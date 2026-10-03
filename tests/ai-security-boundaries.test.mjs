import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { decryptApiKey, fetchAiProvider, normalizeConfiguredBaseUrl } from '../lib/ai-config.ts';
import { fetchCompletion } from '../lib/assistant/core.ts';
import { readTokenUsage, reserveTokens, settleTokens } from '../lib/assistant/usage.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { GET as configGet, POST as configPost, DELETE as configDelete } from '../app/api/ai/config/route.ts';
import { POST as explain } from '../app/api/assistant/explain/route.ts';
import { POST as testConnection } from '../app/api/ai/test/route.ts';
import { POST as classify } from '../app/api/reading/classify/route.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const binding = sqliteD1(db);
const word = { id: 'pep-1e3e7e41accdc5f7', headword: 'abandon', chineseCore: '放弃', partsOfSpeech: ['vt'], scopes: [], sources: [], flags: { formalReleaseEligible: true } };
const settings = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKey: 'test-only-no-real-key-1234567890', dailyLimit: 30, timeoutSeconds: 25 };
const request = (body = settings, method = 'POST', path = '/api/ai/config') => new Request(`https://app.test${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-vocab-action': path === '/api/reading/classify' ? 'reading-classify' : 'settings' },
  ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  db.exec('DELETE FROM ai_rate_limits; DELETE FROM ai_configs; DELETE FROM ai_preferences;');
  env.DB = binding;
  env.ASSETS = { fetch: async () => Response.json([word]) };
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  delete env.AI_ALLOWED_PROVIDER_ORIGINS;
  delete env.AI_ALLOW_INSECURE_LOCAL_BASE_URL;
  requestHeaders.set('oai-authenticated-user-email', 'security@example.test');
});

test('users cannot select DNS-controlled origins or alternate authorities; operators approve exact HTTPS origins', async () => {
  for (const url of ['https://dns-controlled.example/v1', 'https://api.openai.com.evil.test/v1', 'https://api.openai.com:8443/v1']) {
    assert.throws(() => normalizeConfiguredBaseUrl(url), /管理员批准/);
    assert.equal((await configPost(request({ ...settings, baseUrl: url }))).status, 400);
  }
  assert.equal(normalizeConfiguredBaseUrl('https://API.OPENAI.COM.:443/v1'), 'https://api.openai.com./v1');
  assert.equal(normalizeConfiguredBaseUrl('https://api.deepseek.com', 'deepseek'), 'https://api.deepseek.com/v1');
  env.AI_ALLOW_INSECURE_LOCAL_BASE_URL = 'true';
  assert.throws(() => normalizeConfiguredBaseUrl('http://localhost:11434/v1'), /HTTPS/);
  env.AI_ALLOWED_PROVIDER_ORIGINS = 'https://llm.example.test:8443';
  assert.equal(normalizeConfiguredBaseUrl('https://llm.example.test:8443/custom/v1'), 'https://llm.example.test:8443/custom/v1');
  assert.throws(() => normalizeConfiguredBaseUrl('https://llm.example.test/v1'), /管理员批准/);
  for (const config of ['https://llm.example.test/path', 'https://*.example.test', 'https://llm.example.test,']) {
    env.AI_ALLOWED_PROVIDER_ORIGINS = config;
    assert.throws(() => normalizeConfiguredBaseUrl(settings.baseUrl), /配置无效/);
  }
});

test('unapproved stored destinations block every AI caller and preserve the credential scope', async (t) => {
  const custom = { ...settings, baseUrl: 'https://llm.example.test./custom/v1' };
  env.AI_ALLOWED_PROVIDER_ORIGINS = 'https://llm.example.test';
  assert.equal((await configPost(request(custom))).status, 200);
  const before = db.prepare('SELECT * FROM ai_configs').get();
  const scope = { userKey: await authenticatedUserKey(), provider: custom.provider, baseUrl: custom.baseUrl };
  assert.equal(await decryptApiKey(before.encrypted_api_key, before.key_iv, before.encryption_version, scope), custom.apiKey);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return init.method === 'GET' ? new Response(null, { status: 401 }) : Response.json({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 400, completion_tokens: 10, total_tokens: 410 },
    });
  });
  delete env.AI_ALLOWED_PROVIDER_ORIGINS;
  const blockedGet = await configGet();
  assert.equal(blockedGet.status, 503);
  assert.match((await blockedGet.json()).error, /管理员批准/);
  for (const [handler, path, body] of [
    [explain, '/api/assistant/explain', { wordId: word.id }],
    [testConnection, '/api/ai/test', {}],
    [classify, '/api/reading/classify', { title: 'Sample', text: 'An English article about science. '.repeat(5) }],
  ]) assert.equal((await handler(request(body, 'POST', path))).status, 503);
  assert.equal(calls.length, 0);
  assert.deepEqual(db.prepare('SELECT * FROM ai_configs').get(), before);

  env.AI_ALLOWED_PROVIDER_ORIGINS = 'https://llm.example.test';
  assert.equal((await (await configGet()).json()).baseUrl, custom.baseUrl);
  assert.equal((await testConnection(request({}, 'POST', '/api/ai/test'))).status, 200);
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'POST', 'POST']);
  assert.ok(calls.every(({ url, init }) => url === `${custom.baseUrl}/chat/completions` && init.redirect === 'manual'));
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), null);
  assert.ok(calls.slice(1).every(({ init }) => new Headers(init.headers).get('authorization') === `Bearer ${custom.apiKey}`));
});

test('the fetch boundary rechecks policy after configuration loading for both probes and completions', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 307, headers: { location: 'https://dns-controlled.example' } }); });
  const url = 'https://llm.example.test/v1/chat/completions';
  env.AI_ALLOWED_PROVIDER_ORIGINS = 'https://llm.example.test';
  normalizeConfiguredBaseUrl(url);
  delete env.AI_ALLOWED_PROVIDER_ORIGINS;
  for (const method of ['GET', 'POST']) {
    await assert.rejects(async () => fetchAiProvider(url, { method, redirect: 'manual' }), /管理员批准/);
  }
  assert.equal(calls, 0);
  const approved = await fetchAiProvider(settings.baseUrl, { redirect: 'manual' });
  assert.equal(approved.status, 307);
  assert.equal(calls, 1, 'redirect is returned, never followed');
});

test('tiny JSON/SSE usage and missing or malformed usage cannot refund below local prompt and actual output', async () => {
  const content = '中文'.repeat(40);
  const tiny = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 };
  for (const [label, usage, stream] of [['json', tiny, false], ['sse', tiny, true], ['missing', undefined, false], ['malformed', { prompt_tokens: -1 }, false]]) {
    const reservation = await reserveTokens(label, 3000, 'p'.repeat(600), 1000);
    const response = stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage });
    const completion = await fetchCompletion(async () => response, settings.baseUrl, {}, { idleMs: 1000, totalMs: 1000, stream, promptChars: 600 });
    const settled = await settleTokens(reservation, completion.usage, completion.content);
    assert.equal(settled.today, 636, label); // 300 local prompt tokens + 256 margin + 80 UTF-8 output tokens.
    assert.equal(settled.usage.total, 636);
    assert.equal(settled.usage.estimated, true);
    assert.equal((await readTokenUsage(label)).total, 636);
  }
  const reservation = await reserveTokens('honest', 3000, 'prompt', 1000);
  const honest = { prompt: 1500, completion: 500, total: 2000, cacheHit: 100, estimated: false };
  assert.deepEqual(await settleTokens(reservation, honest, 'short answer'), { today: 2000, usage: honest });
});

test('POST and DELETE share a mutation limit before encryption or configuration reads, isolated by identity', async (t) => {
  let encryptions = 0;
  const encrypt = crypto.subtle.encrypt;
  t.mock.method(crypto.subtle, 'encrypt', function (...args) { encryptions++; return encrypt.apply(this, args); });
  for (let i = 0; i < 12; i++) {
    const response = i % 2 ? await configDelete(request(undefined, 'DELETE')) : await configPost(request());
    assert.equal(response.status, 200);
  }
  assert.equal(encryptions, 6);
  const queries = [];
  env.DB = { ...binding, prepare(sql) { queries.push(sql); return binding.prepare(sql); } };
  for (const method of ['POST', 'DELETE']) {
    const response = method === 'POST' ? await configPost(request()) : await configDelete(request(undefined, 'DELETE'));
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
  }
  assert.equal(encryptions, 6);
  assert.ok(queries.every(sql => sql.includes('ai_rate_limits')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
  requestHeaders.set('oai-authenticated-user-email', 'other@example.test');
  assert.equal((await configPost(request())).status, 200);
});

test('daily mutation exhaustion and missing or unavailable limiter storage leave configuration untouched', async () => {
  assert.equal((await configPost(request())).status, 200);
  const before = db.prepare('SELECT * FROM ai_configs').get();
  const userKey = await authenticatedUserKey();
  const start = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  db.prepare('UPDATE ai_rate_limits SET request_count=100 WHERE bucket_key=?').run(`ai-config:mutation:day:${userKey}:${start}`);
  for (const [handler, method] of [[configPost, 'POST'], [configDelete, 'DELETE']]) assert.equal((await handler(request(settings, method))).status, 429);
  for (const store of [undefined, { prepare() { throw new Error('no such table: ai_rate_limits'); } }, { prepare() { throw new Error('storage unavailable'); } }]) {
    env.DB = store;
    for (const [handler, method] of [[configPost, 'POST'], [configDelete, 'DELETE']]) assert.equal((await handler(request(settings, method))).status, 503);
  }
  assert.deepEqual(db.prepare('SELECT * FROM ai_configs').get(), before);
});

test('invalid provider policy blocks stored settings and outbound calls while credential removal still succeeds', async (t) => {
  assert.equal((await configPost(request())).status, 200);
  env.AI_ALLOWED_PROVIDER_ORIGINS = 'https://invalid.example/path';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected outbound request'); });
  assert.equal((await configGet()).status, 503);
  assert.equal((await explain(request({ wordId: word.id }, 'POST', '/api/assistant/explain'))).status, 503);
  assert.equal(calls, 0);
  const removed = await configDelete(request(undefined, 'DELETE'));
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).hasApiKey, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
});
