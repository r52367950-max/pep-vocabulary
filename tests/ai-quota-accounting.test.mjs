import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { POST as configPost } from './config-client.mjs';
import { POST as explain } from '../app/api/assistant/explain/route.ts';
import { readTokenUsage } from '../lib/assistant/usage.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { budgetDay } from '../lib/http.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const binding = sqliteD1(db);
const word = { id: 'pep-1e3e7e41accdc5f7', headword: 'abandon', chineseCore: '放弃', partsOfSpeech: ['vt'], scopes: [], sources: [], flags: { formalReleaseEligible: true } };
const settings = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKey: 'test-only-no-real-key-1234567890', dailyLimit: 30, timeoutSeconds: 25 };
const request = (body, path) => new Request(`https://app.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body),
});
const ask = () => explain(request({ wordId: word.id }, '/api/assistant/explain'));
const outputCap = (body) => Number(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens);

beforeEach(async () => {
  db.exec('DELETE FROM ai_rate_limits; DELETE FROM ai_configs; DELETE FROM ai_preferences;');
  env.DB = binding;
  env.ASSETS = { fetch: async () => Response.json([word]) };
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  delete env.AI_ALLOWED_PROVIDER_ORIGINS;
  requestHeaders.set('oai-authenticated-user-email', 'quota@example.test');
  assert.equal((await configPost(request(settings, '/api/ai/config'))).status, 200);
});

async function failedCallTotal(t, status) {
  db.exec("DELETE FROM ai_rate_limits WHERE bucket_key LIKE 'tokens%'");
  let cap = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    cap = outputCap(JSON.parse(init.body));
    return Response.json({ error: { code: 'test' } }, { status });
  });
  const response = await ask();
  assert.equal(response.status >= 400, true);
  t.mock.restoreAll();
  return { total: (await readTokenUsage(await authenticatedUserKey())).total, cap };
}

test('a provider rejection before generation returns the reserved output; ambiguous failures keep it', async (t) => {
  const retained = await failedCallTotal(t, 500);
  assert.ok(retained.cap >= 256, 'the call reserved an output allowance');
  for (const status of [400, 401, 402, 403, 404, 422, 429, 307]) {
    const rejected = await failedCallTotal(t, status);
    assert.equal(rejected.cap, retained.cap, `${status}: same request shape`);
    assert.equal(rejected.total, retained.total - retained.cap, `${status}: only the prompt estimate stays charged`);
    assert.ok(rejected.total > 0, `${status}: the prompt estimate is never refunded`);
  }
  for (const status of [408, 502, 503]) {
    assert.equal((await failedCallTotal(t, status)).total, retained.total, `${status}: reservation retained`);
  }
});

test('daily request counts reset at Beijing midnight with a specific message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'test' } }, { status: 401 }));
  const userKey = await authenticatedUserKey();
  const day = budgetDay();
  await ask();
  const row = db.prepare('SELECT request_count, expires_at FROM ai_rate_limits WHERE bucket_key = ?').get(`day:${userKey}:${day.start}`);
  assert.equal(row.request_count, 1);
  assert.equal(row.expires_at, day.expiresAt);
  db.prepare('UPDATE ai_rate_limits SET request_count = ? WHERE bucket_key = ?').run(settings.dailyLimit, `day:${userKey}:${day.start}`);
  const exhausted = await ask();
  assert.equal(exhausted.status, 429);
  const body = await exhausted.json();
  assert.equal(body.error.code, 'rate_limited');
  assert.match(body.error.message, /北京时间 0 点重置/);
  assert.ok(Number(exhausted.headers.get('retry-after')) <= Math.ceil((day.expiresAt - Date.now()) / 1000));
});
