import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { PRIVATE_API_ROUTES, createSecureHandler, documentContentSecurityPolicy } from '../worker/security.ts';
import { gatewayEmail, getChatGPTUser, identityHostTrusted } from '../app/chatgpt-auth.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { consumeRateLimit, RateLimitStoreError } from '../lib/http.ts';

// Test-only identity and credential values; no request leaves the process.
const OWNER = 'owner@example.test';
env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
const database = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
  database.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
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

const apiRoot = new URL('../app/api/', import.meta.url);
const routeFiles = readdirSync(apiRoot, { recursive: true }).filter(path => path.endsWith('route.ts')).sort();
const routePath = file => `/api/${file.replace(/\/?route\.ts$/, '')}`;
const exportedMethods = file => [...readFileSync(new URL(file, apiRoot), 'utf8').matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(match => match[1]).sort();
const modules = Object.fromEntries(await Promise.all(routeFiles.map(async file => [routePath(file), await import(new URL(file, apiRoot).href)])));

const wordA = 'pep-1e3e7e41accdc5f7';
const wordB = 'pep-07d418db40de3fe8';
const backup = { schemaVersion: '1.1.0', cards: [], events: [], lists: [], settings: [] };
// The smallest body each POST route accepts before it checks identity.
const validBodies = {
  '/api/sync': { schemaVersion: '1.1.0', baseRevision: 0, clientUpdatedAt: '2026-09-24T00:00:00Z', payload: backup },
  '/api/ai/config': { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-only-not-a-real-key-000000', dailyLimit: 30, timeoutSeconds: 25 },
  '/api/ai/test': {},
  '/api/assistant/explain': { wordId: wordA },
  '/api/assistant/check-sentence': { wordId: wordA, sentence: 'They abandoned the plan.' },
  '/api/assistant/generate-practice': { wordIds: [wordA, wordB], count: 3 },
  '/api/assistant/contrast-words': { wordIds: [wordA, wordB] },
  '/api/reading/classify': { title: 'A test article', text: 'This is an English reading sample. '.repeat(5) },
};
const actions = { '/api/ai/config': 'settings', '/api/ai/test': 'settings', '/api/reading/classify': 'reading-classify', '/api/sync': 'sync' };
const call = (path, method, { headers = {}, body } = {}) => {
  const init = { method, headers: { 'content-type': 'application/json', ...(actions[path] ? { 'x-vocab-action': actions[path] } : {}), ...headers } };
  if (method !== 'GET' && method !== 'HEAD') init.body = typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body ?? validBodies[path] ?? {});
  if (init.body instanceof ReadableStream) init.duplex = 'half';
  const request = new Request(`https://app.test${path}`, init);
  return modules[path][method](request);
};
const asIdentity = (email) => { if (email === null) requestHeaders.delete('oai-authenticated-user-email'); else requestHeaders.set('oai-authenticated-user-email', email); };
const endpoints = () => Object.entries(PRIVATE_API_ROUTES).flatMap(([path, methods]) => methods.map(method => [path, method]));

async function assertPrivateError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-type') || '', /^application\/json/);
  const text = await response.text();
  assert.doesNotMatch(text, /\bat .*\.(?:ts|js):\d+|SQLITE|D1_|binding|stack/i);
  return JSON.parse(text);
}

test('every API route is inventoried with the methods it exports', () => {
  assert.deepEqual(routeFiles.map(routePath).sort(), Object.keys(PRIVATE_API_ROUTES).sort());
  for (const file of routeFiles) assert.deepEqual(exportedMethods(file), [...PRIVATE_API_ROUTES[routePath(file)]].sort(), file);
});

test('missing or malformed identity headers are rejected with 401 on every private endpoint', async () => {
  for (const identity of [null, '', 'not-an-email', 'owner@example.test, attacker@example.test', 'a b@example.test', `${'x'.repeat(250)}@example.test`, 'owner@example.test\u0001', '@example.test', 'owner@']) {
    asIdentity(identity);
    for (const [path, method] of endpoints()) {
      const response = await call(path, method);
      await assertPrivateError(response, 401);
    }
  }
});

test('cross-site requests are rejected with 403 before identity or body are used', async () => {
  asIdentity(OWNER);
  for (const [path, method] of endpoints().filter(([, method]) => method !== 'GET')) {
    for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      await assertPrivateError(await call(path, method, { headers }), 403);
    }
  }
});

test('AI settings mutations require the settings action header', async () => {
  asIdentity(OWNER);
  for (const [path, method] of [['/api/ai/config', 'POST'], ['/api/ai/config', 'DELETE'], ['/api/ai/test', 'POST']]) {
    for (const action of [undefined, 'sync', 'assistant']) {
      const request = new Request(`https://app.test${path}`, { method, headers: { 'content-type': 'application/json', ...(action ? { 'x-vocab-action': action } : {}) }, body: JSON.stringify(validBodies[path] ?? {}) });
      await assertPrivateError(await modules[path][method](request), 403);
    }
  }
});

test('oversized bodies are refused with 413, including chunked bodies without Content-Length', async () => {
  asIdentity(OWNER);
  for (const [path, method] of endpoints().filter(([, method]) => method === 'POST')) {
    let produced = 0;
    let cancelled = false;
    const endless = new ReadableStream({
      pull(controller) { produced += 65536; controller.enqueue(new Uint8Array(65536).fill(32)); },
      cancel() { cancelled = true; },
    });
    const response = await call(path, method, { body: endless });
    await assertPrivateError(response, 413);
    assert.equal(cancelled, true, `${path} must stop reading`);
    assert.ok(produced <= 5_000_000 + 4096 + 2 * 65536, `${path} read ${produced} bytes`);
    const declared = await call(path, method, { headers: { 'content-length': '99999999' }, body: '{}' });
    assert.equal(declared.status, 413, path);
  }
});

test('sync is rate limited per identity with 429 and Retry-After', async () => {
  asIdentity('limited@example.test');
  const statuses = [];
  for (let index = 0; index < 30; index++) statuses.push((await modules['/api/sync'].GET()).status);
  assert.deepEqual([...new Set(statuses)], [200]);
  const limited = await modules['/api/sync'].GET();
  const body = await assertPrivateError(limited, 429);
  assert.equal(body.code, 'rate_limited');
  assert.match(body.error, /过于频繁/);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);
  assert.equal((await call('/api/sync', 'POST')).status, 429);
  // Other identities keep their own budget.
  asIdentity('unlimited@example.test');
  assert.equal((await modules['/api/sync'].GET()).status, 200);
});

test('sync writes have a daily budget; no storage answers 503, a missing limiter table does not block sync', async () => {
  asIdentity('daily@example.test');
  const key = await authenticatedUserKey();
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  database.prepare('INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)').run(`sync:write-day:${key}:${dayStart}`, 200, dayStart + 86_400_000);
  assert.equal((await modules['/api/sync'].GET()).status, 200, 'reads are not charged to the write budget');
  const limited = await call('/api/sync', 'POST');
  await assertPrivateError(limited, 429);
  assert.ok(Number(limited.headers.get('retry-after')) <= 86_400);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_states WHERE user_key = ?').get(key).count, 0);
  const binding = env.DB;
  delete env.DB;
  try { await assertPrivateError(await modules['/api/sync'].GET(), 503); } finally { env.DB = binding; }
  // A deployment that never applied the limiter migration keeps syncing.
  database.exec('ALTER TABLE ai_rate_limits RENAME TO ai_rate_limits_hidden');
  try { assert.equal((await modules['/api/sync'].GET()).status, 200); } finally { database.exec('ALTER TABLE ai_rate_limits_hidden RENAME TO ai_rate_limits'); }
  await assert.rejects(consumeRateLimit({ prepare() { throw new Error('no such table: ai_rate_limits'); } }, 'k', 1, 1), error => error instanceof RateLimitStoreError && error.migrationRequired);
});

test('sync keeps identity and revision conflicts after the hardening', async () => {
  asIdentity('conflict@example.test');
  const first = await (await modules['/api/sync'].GET()).json();
  assert.equal((await call('/api/sync', 'POST', { body: { ...validBodies['/api/sync'], expectedIdentity: first.identity } })).status, 200);
  const stale = await call('/api/sync', 'POST');
  assert.deepEqual(await assertPrivateError(stale, 409), { error: 'revision-conflict', code: 'revision-conflict' });
  const moved = await call('/api/sync', 'POST', { body: { ...validBodies['/api/sync'], baseRevision: 1, expectedIdentity: 'f'.repeat(64) } });
  assert.deepEqual(await assertPrivateError(moved, 409), { error: 'identity-conflict', code: 'identity-conflict' });
});

test('gateway identity values are validated without changing existing user keys', async () => {
  assert.equal(gatewayEmail(' Owner@Example.test '), 'Owner@Example.test');
  for (const bad of [null, '', 'x', 'a,b@example.test', 'a@b@example.test', 'a<b>@example.test', 'tab\t@example.test', 'a@', '@a']) assert.equal(gatewayEmail(bad), null, String(bad));
  asIdentity('  Owner@Example.TEST ');
  const trimmed = await authenticatedUserKey();
  asIdentity('owner@example.test');
  assert.equal(trimmed, await authenticatedUserKey(), 'case and surrounding whitespace map to the same key as before');
  requestHeaders.set('oai-authenticated-user-full-name', encodeURIComponent('李\u0007雷'));
  requestHeaders.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
  assert.equal((await getChatGPTUser()).fullName, null);
  requestHeaders.set('oai-authenticated-user-full-name', encodeURIComponent('李雷'));
  assert.equal((await getChatGPTUser()).displayName, '李雷');
  requestHeaders.set('oai-authenticated-user-full-name', encodeURIComponent('名'.repeat(201)));
  assert.equal((await getChatGPTUser()).displayName, 'owner@example.test');
  requestHeaders.delete('oai-authenticated-user-full-name');
  requestHeaders.delete('oai-authenticated-user-full-name-encoding');
});

test('the optional trusted-host guard is off by default and ignores identity on other hosts when set', async () => {
  assert.equal(identityHostTrusted('anything.example', undefined), true);
  assert.equal(identityHostTrusted(null, ''), true);
  assert.equal(identityHostTrusted('App.Example.test:443', 'app.example.test'), true);
  assert.equal(identityHostTrusted('app.workers.dev', 'app.example.test, other.example.test'), false);
  assert.equal(identityHostTrusted(null, 'app.example.test'), false);
  asIdentity(OWNER);
  requestHeaders.set('host', 'preview.workers.dev');
  assert.ok(await getChatGPTUser());
  env.IDENTITY_TRUSTED_HOSTS = 'app.example.test';
  try {
    assert.equal(await getChatGPTUser(), null);
    await assertPrivateError(await modules['/api/sync'].GET(), 401);
    requestHeaders.set('host', 'app.example.test');
    assert.ok(await getChatGPTUser());
  } finally {
    delete env.IDENTITY_TRUSTED_HOSTS;
    requestHeaders.delete('host');
  }
});

const secure = (inner, enforce = true) => createSecureHandler({ fetch: inner }, { enforceContentSecurityPolicy: enforce });

test('HTML documents carry a per-request nonce CSP that matches the one handed to vinext', async () => {
  const seen = [];
  const handler = secure(async (request) => {
    seen.push(request.headers.get('content-security-policy'));
    return new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' } });
  });
  const first = await handler.fetch(new Request('https://app.test/', { headers: { 'content-security-policy': "script-src 'nonce-attacker'" } }));
  const second = await handler.fetch(new Request('https://app.test/'));
  const policy = first.headers.get('content-security-policy');
  assert.equal(policy, seen[0]);
  assert.doesNotMatch(policy, /attacker/);
  assert.notEqual(policy, second.headers.get('content-security-policy'));
  const nonce = policy.match(/'nonce-([^']+)'/)[1];
  assert.ok(Buffer.from(nonce, 'base64').length >= 16);
  assert.equal(policy, documentContentSecurityPolicy(nonce, true));
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", 'upgrade-insecure-requests']) assert.ok(policy.includes(directive), directive);
  assert.doesNotMatch(policy.match(/script-src[^;]*/)[0], /'unsafe-inline'|'unsafe-eval'|\s\*(?:\s|$)/);
  assert.equal(first.headers.get('x-frame-options'), 'DENY');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.headers.get('referrer-policy'), 'same-origin');
  assert.match(first.headers.get('permissions-policy'), /microphone=\(\).*|camera=\(\)/);
  assert.equal(first.headers.get('strict-transport-security'), 'max-age=31536000');
  // The offline shell stays storable by the service worker but never by shared caches.
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const other = await handler.fetch(new Request('https://app.test/missing'));
  assert.match(other.headers.get('cache-control'), /no-store/);
  const local = await handler.fetch(new Request('http://localhost/'));
  assert.equal(local.headers.get('strict-transport-security'), null);
  assert.doesNotMatch(local.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});

test('development skips script CSP but keeps framing and sniffing protection', async () => {
  let forwarded;
  const handler = secure(async (request) => { forwarded = request.headers.get('content-security-policy'); return new Response('<html></html>', { headers: { 'content-type': 'text/html' } }); }, false);
  const response = await handler.fetch(new Request('http://localhost/', { headers: { 'content-security-policy': "script-src 'nonce-attacker'" } }));
  assert.equal(forwarded, null);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('framework API errors become private JSON: 404, 405 with Allow, and 500 without internals', async () => {
  const cases = [
    [async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }), '/api/unknown', 404, 'not_found'],
    [async () => new Response(null, { status: 405 }), '/api/sync', 405, 'method_not_allowed'],
    [async () => new Response('Error: boom\n    at handler (route.ts:1:1)', { status: 500 }), '/api/sync', 500, 'internal_error'],
    [async () => new Response('upstream timed out', { status: 504 }), '/api/sync', 504, 'internal_error'],
    [async () => { throw new Error('D1_ERROR: SELECT * FROM sync_states'); }, '/api/sync', 500, 'internal_error'],
  ];
  for (const [inner, path, status, code] of cases) {
    const response = await secure(inner).fetch(new Request(`https://app.test${path}`, { method: status === 405 ? 'PUT' : 'GET' }));
    const body = await assertPrivateError(response, status);
    assert.equal(body.code, code);
    assert.equal(typeof body.error, 'string');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET, POST, OPTIONS');
  }
  // Route responses keep their own JSON body and status; only headers are added.
  const own = await secure(async () => Response.json({ error: 'identity-conflict' }, { status: 409 })).fetch(new Request('https://app.test/api/sync', { method: 'POST' }));
  assert.equal(own.status, 409);
  assert.deepEqual(await own.json(), { error: 'identity-conflict' });
  assert.match(own.headers.get('cache-control'), /no-store/);
  const thrownPage = await secure(async () => { throw new Error('secret stack'); }).fetch(new Request('https://app.test/'));
  assert.equal(thrownPage.status, 500);
  assert.doesNotMatch(await thrownPage.text(), /secret stack/);
});
