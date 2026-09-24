import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import 'fake-indexeddb/auto';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { readJsonObject } from '../lib/http.ts';
import { encryptApiKey, decryptApiKey } from '../lib/ai-config.ts';
import { fetchChatCompletionWithTimeout, readChatCompletion } from '../lib/assistant/core.ts';
import { POST as syncPost, GET as syncGet } from '../app/api/sync/route.ts';
import { POST as configPost, GET as configGet } from '../app/api/ai/config/route.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { scheduleReview } from '../lib/scheduler.ts';
import { clearUserData, commitReview, exportBackup, restoreBackup, validateBackup } from '../lib/storage.ts';

async function bounded(promise, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not settle before watchdog')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('slow request bodies time out even if their producer never completes cancellation', async () => {
  let cancelled = false;
  const request = new Request('https://app.test/api/sync', {
    method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }),
  });
  await assert.rejects(bounded(readJsonObject(request, 4096, 5)), error => error.status === 408);
  assert.equal(cancelled, true);
});

test('aborted requests and malformed UTF-8 cannot become accepted backup data', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request('https://app.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal });
  await assert.rejects(readJsonObject(request, 4096), error => error.status === 408);
  const bytes = new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]);
  await assert.rejects(readJsonObject(new Request('https://app.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes }), 4096), error => error.status === 400);
});

test('provider errors and oversized declared bodies release their streams without exposing contents', async () => {
  for (const [status, headers, code] of [[401, {}, 'provider_auth_failed'], [200, { 'content-length': '300001' }, 'model_response_too_large']]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { status, headers });
    await assert.rejects(bounded(readChatCompletion(response)), error => error.code === code);
    assert.equal(cancelled, true);
  }
});

test('provider body timeout and byte limits cannot be blocked by a stalled cancel promise', async () => {
  let timeoutCancelled = false;
  const stalled = async () => new Response(new ReadableStream({ cancel() { timeoutCancelled = true; return new Promise(() => {}); } }));
  await assert.rejects(bounded(fetchChatCompletionWithTimeout(stalled, 'https://api.example.com/v1', {}, 5)), error => error.code === 'upstream_timeout');
  assert.equal(timeoutCancelled, true);
  let sizeCancelled = false;
  const huge = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(300001)); },
    cancel() { sizeCancelled = true; return new Promise(() => {}); },
  }));
  await assert.rejects(bounded(readChatCompletion(huge)), error => error.code === 'model_response_too_large');
  assert.equal(sizeCancelled, true);
});

const secret = 'test-only-credential-0123456789';
env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
const scope = { userKey: 'user-a', provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };

test('version 2 credentials authenticate the account, provider and destination together', async () => {
  const encrypted = await encryptApiKey(secret, scope);
  assert.equal(encrypted.encryptionVersion, 2);
  assert.equal(await decryptApiKey(encrypted.encryptedApiKey, encrypted.keyIv, 2, scope), secret);
  for (const changed of [{ ...scope, userKey: 'user-b' }, { ...scope, provider: 'deepseek' }, { ...scope, baseUrl: 'https://other.example/v1' }]) {
    await assert.rejects(decryptApiKey(encrypted.encryptedApiKey, encrypted.keyIv, 2, changed));
  }
  await assert.rejects(decryptApiKey(encrypted.encryptedApiKey, encrypted.keyIv, 1));
  await assert.rejects(decryptApiKey(encrypted.encryptedApiKey, encrypted.keyIv, 3, scope));
  const legacy = await encryptApiKey(secret);
  assert.equal(await decryptApiKey(legacy.encryptedApiKey, legacy.keyIv), secret);
});

const database = new DatabaseSync(':memory:');
for (const migration of ['0000_curvy_newton_destine', '0001_flawless_human_cannonball', '0002_swift_cerise']) {
  database.exec(readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8'));
}
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async raw() { const stmt = database.prepare(this.sql); stmt.setReturnArrays(true); return stmt.all(...this.args); }
  async all() { return { results: database.prepare(this.sql).all(...this.args) }; }
  async run() { return database.prepare(this.sql).run(...this.args); }
  async first() { return database.prepare(this.sql).get(...this.args) ?? null; }
}
env.DB = { prepare: sql => new Statement(sql) };
const request = (path, body) => new Request(`https://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
const emptyBackup = { schemaVersion: '1.1.0', cards: [], events: [], lists: [], settings: [] };

test('sync rejects an identity changed after the client read its revision', async () => {
  requestHeaders.set('oai-authenticated-user-email', 'sync-a@example.test');
  const initial = await (await syncGet()).json();
  assert.match(initial.identity, /^[a-f0-9]{64}$/);
  assert.equal(initial.state, null);
  const body = { schemaVersion: '1.1.0', baseRevision: 0, clientUpdatedAt: '2026-09-15T00:00:00Z', payload: emptyBackup, expectedIdentity: initial.identity };
  requestHeaders.set('oai-authenticated-user-email', 'sync-b@example.test');
  const conflict = await syncPost(request('/api/sync', body));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'identity-conflict');
  assert.equal((await (await syncGet()).json()).state, null);
  requestHeaders.set('oai-authenticated-user-email', 'sync-a@example.test');
  const saved = await (await syncPost(request('/api/sync', body))).json();
  assert.equal(saved.identity, initial.identity);
  const restored = await (await syncGet()).json();
  assert.equal(restored.state.revision, 1);
  assert.equal('userKey' in restored.state, false);
});

test('saving legacy AI settings upgrades encryption and public responses never include the secret', async () => {
  requestHeaders.set('oai-authenticated-user-email', 'config@example.test');
  const userKey = await authenticatedUserKey();
  const legacy = await encryptApiKey(secret);
  database.prepare('INSERT INTO ai_configs (user_key, provider, base_url, model, encrypted_api_key, key_iv) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userKey, scope.provider, scope.baseUrl, 'test-model', legacy.encryptedApiKey, legacy.keyIv);
  const response = await configPost(request('/api/ai/config', { provider: scope.provider, baseUrl: scope.baseUrl, model: 'test-model', dailyLimit: 30, timeoutSeconds: 25 }));
  assert.equal(response.status, 200);
  const row = database.prepare('SELECT * FROM ai_configs WHERE user_key = ?').get(userKey);
  assert.equal(row.encryption_version, 2);
  assert.equal(await decryptApiKey(row.encrypted_api_key, row.key_iv, 2, { ...scope, userKey }), secret);
  const publicResponse = await (await configGet()).text();
  assert.doesNotMatch(publicResponse, /encryptedApiKey|keyIv|encryptionVersion|test-only-credential/);
  requestHeaders.set('oai-authenticated-user-email', 'other-config@example.test');
  assert.equal((await (await configGet()).json()).hasApiKey, false);
});

function review() {
  return scheduleReview({ stored: null, cardId: 'test-word', rating: 3, retention: 0.9, skill: 'meaning', questionType: 'meaning-recall', correct: true, responseMs: 1000, hints: 0, errorType: null, now: new Date('2026-09-15T00:00:00Z') }).event;
}

test('invalid imported metrics, calendar dates and undo links are rejected before replacing local data', async () => {
  await clearUserData();
  const event = review();
  await commitReview(event);
  const backup = await exportBackup();
  for (const patch of [{ localDate: '2026-02-31' }, { intervalAfterDays: 'bad' }, { difficultyAfter: 11 }, { hints: 0.5 }, { eventType: 'undo', targetEventId: 'missing' }]) {
    const invalid = structuredClone(backup);
    Object.assign(invalid.events[0], patch);
    await assert.rejects(restoreBackup(invalid));
  }
  assert.deepEqual((await exportBackup()).cards, backup.cards);
  const undo = { ...event, eventId: 'undo', eventType: 'undo', targetEventId: event.eventId };
  assert.doesNotThrow(() => validateBackup({ ...backup, cards: [], events: [event, undo] }));
  assert.throws(() => validateBackup({ ...backup, events: [event, undo, { ...undo, eventId: 'undo-again' }] }));
});

test('a forged undo cannot remove a card without the matching committed review event', async () => {
  await clearUserData();
  const event = review();
  await commitReview(event);
  await assert.rejects(commitReview({ ...event, eventId: 'bad-undo', eventType: 'undo', targetEventId: 'missing' }));
  const backup = await exportBackup();
  assert.equal(backup.cards.length, 1);
  assert.equal(backup.events.length, 1);
});

function workerRuntime({ missingManifest = false, quotaFailure = false, privateShell = false, chunkFailure = false, chunkQuotaFailure = false } = {}) {
  const handlers = {}, buckets = new Map([['vocab-shell-old', new Map([['/', 'working shell']])]]);
  const runtime = {
    URL, Request, Response, AbortSignal,
    self: { location: { origin: 'https://app.test' }, addEventListener(type, handler) { handlers[type] = handler; } },
    caches: {
      async open(name) {
        if (!buckets.has(name)) buckets.set(name, new Map());
        return { async put(request, response) {
          if (quotaFailure && request.url.endsWith('.js') || chunkQuotaFailure && request.url.includes('/chunks/')) throw new Error('quota exceeded');
          buckets.get(name).set(request.url, response);
        }, async match(request) { return buckets.get(name).get(request.url)?.clone(); } };
      },
      async delete(name) { return buckets.delete(name); },
    },
    async fetch(input) {
      const path = typeof input === 'string' ? input : new URL(input.url).pathname;
      if (path === '/offline-assets.json') return missingManifest ? new Response('', { status: 503 }) : Response.json(['/assets/app-hash.js', '/assets/font-hash.woff2']);
      if (path === '/data/v1/manifest.json') return Response.json({ chunks: [{ file: 'chunks/part-1.json' }, { file: 'chunks/part-2.json' }] });
      if (chunkFailure && path.includes('/chunks/')) return new Response('', { status: 503 });
      return new Response('public shell', { headers: privateShell && path === '/' ? { 'cache-control': 'NO-STORE' } : {} });
    },
  };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), runtime);
  return { buckets, async install() { let pending; handlers.install({ waitUntil(promise) { pending = promise; } }); await pending; }, async download() { let pending, reply; handlers.message({ data: { type: 'PREPARE_LEXICON' }, ports: [{ postMessage(value) { reply = value; } }], waitUntil(promise) { pending = promise; } }); await pending; return reply; } };
}

test('offline installation rejects missing assets, cache quota failures and non-cacheable shells', async () => {
  for (const options of [{ missingManifest: true }, { quotaFailure: true }, { privateShell: true }]) {
    const worker = workerRuntime(options);
    await assert.rejects(worker.install());
    assert.equal(worker.buckets.get('vocab-shell-old').get('/'), 'working shell');
    if (!options.missingManifest) assert.equal(worker.buckets.has('vocab-shell-v2'), false);
  }
});

test('a complete offline installation retains its executable shell and declared fonts', async () => {
  const worker = workerRuntime();
  await worker.install();
  const cached = worker.buckets.get('vocab-shell-v2');
  assert.ok(cached.has('https://app.test/'));
  assert.ok(cached.has('https://app.test/assets/app-hash.js'));
  assert.ok(cached.has('https://app.test/assets/font-hash.woff2'));
});

test('offline preparation only confirms success when every detail chunk is saved', async () => {
  const worker = workerRuntime();
  await worker.install();
  assert.deepEqual(JSON.parse(JSON.stringify(await worker.download())), { ok: true, files: 2 });
  const cached = worker.buckets.get('vocab-shell-v2');
  assert.ok(cached.has('https://app.test/data/v1/chunks/part-1.json'));
  assert.ok(cached.has('https://app.test/data/v1/chunks/part-2.json'));
  assert.equal((await worker.download()).ok, true);
});

test('offline preparation reports failure on unavailable chunks or exhausted storage', async () => {
  for (const options of [{ chunkFailure: true }, { chunkQuotaFailure: true }]) {
    const worker = workerRuntime(options);
    await worker.install();
    assert.equal((await worker.download()).ok, false);
    assert.ok(worker.buckets.get('vocab-shell-v2').has('https://app.test/assets/app-hash.js'));
  }
});
