import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { POST, DELETE, GET } from '../app/api/ai/config/route.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const binding = sqliteD1(db);
const config = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: 'test-only-no-real-key-1234567890', dailyLimit: 30, timeoutSeconds: 25, dailyTokenBudget: 10_000 };
function request(body = {}, method = 'POST') {
  return new Request('https://app.test/api/ai/config', { method, headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  db.exec('DELETE FROM ai_rate_limits; DELETE FROM ai_configs; DELETE FROM ai_preferences; DELETE FROM ai_config_generations;');
  env.DB = binding;
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'lifecycle@example.test');
});

// Pause at the actual write, after the route has read its configuration snapshot.
function pauseConfigWrite() {
  let arrive, resume;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  const resumed = new Promise((resolve) => { resume = resolve; });
  env.DB = { ...binding, async batch(statements) {
    if (statements.some((statement) => /^(?:INSERT INTO|UPDATE) ai_configs/.test(statement.sql))) {
      arrive(); await resumed;
    }
    return binding.batch(statements);
  } };
  return { arrived, resume };
}

test('a delayed first save cannot restore a credential after create and delete', async () => {
  const barrier = pauseConfigWrite();
  const delayed = POST(request({ ...config, model: 'stale', dailyTokenBudget: 40_000 }));
  await barrier.arrived;
  env.DB = binding;
  try {
    assert.equal((await POST(request(config))).status, 200);
    assert.equal((await DELETE(request({}, 'DELETE'))).status, 200);
  } finally { barrier.resume(); }
  const result = await delayed;
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'configuration_conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
  assert.equal(db.prepare('SELECT daily_token_budget FROM ai_preferences').get().daily_token_budget, 10_000);
});

test('deleting an absent configuration also fences an in-flight first save', async () => {
  const barrier = pauseConfigWrite();
  const delayed = POST(request(config));
  await barrier.arrived;
  env.DB = binding;
  try { assert.equal((await DELETE(request({}, 'DELETE'))).status, 200); }
  finally { barrier.resume(); }
  assert.equal((await delayed).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_preferences').get().n, 0);
});

test('ordinary first creation, retained-key update, delete and deliberate recreation work', async () => {
  assert.equal((await POST(request(config))).status, 200);
  assert.equal((await POST(request({ ...config, apiKey: '', model: 'updated-model' }))).status, 200);
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, 'updated-model');
  assert.equal((await DELETE(request({}, 'DELETE'))).status, 200);
  assert.equal((await (await GET()).json()).hasApiKey, false);
  assert.equal((await POST(request({ ...config, apiKey: '' }))).status, 400);
  assert.equal((await POST(request({ ...config, model: 'new-model' }))).status, 200);
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, 'new-model');
});

test('competing first saves admit one credential and its matching preferences', async () => {
  let resume;
  const barrier = new Promise((resolve) => { resume = resolve; });
  let arrivals = 0;
  env.DB = { ...binding, async batch(statements) {
    if (statements.some((statement) => /^INSERT INTO ai_configs/.test(statement.sql))) {
      if (++arrivals === 2) resume();
      await barrier;
    }
    return binding.batch(statements);
  } };
  const variants = [{ ...config, model: 'first', dailyTokenBudget: 20_000 }, { ...config, model: 'second', dailyTokenBudget: 30_000 }];
  const results = await Promise.all(variants.map((body) => POST(request(body))));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = variants[results.findIndex((result) => result.status === 200)];
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, winner.model);
  assert.equal(db.prepare('SELECT daily_token_budget FROM ai_preferences').get().daily_token_budget, winner.dailyTokenBudget);
});

test('another account deletion does not reject an admitted first save', async () => {
  const barrier = pauseConfigWrite();
  const delayed = POST(request(config));
  await barrier.arrived;
  env.DB = binding;
  requestHeaders.set('oai-authenticated-user-email', 'other-lifecycle@example.test');
  try { assert.equal((await DELETE(request({}, 'DELETE'))).status, 200); }
  finally { barrier.resume(); }
  assert.equal((await delayed).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 1);
});

test('failed deletion retains the credential and can be retried', async (t) => {
  assert.equal((await POST(request(config))).status, 200);
  const before = db.prepare('SELECT * FROM ai_configs').get();
  const fenceBefore = db.prepare('SELECT * FROM ai_config_generations').get();
  db.exec("CREATE TRIGGER reject_config_delete BEFORE DELETE ON ai_configs BEGIN SELECT RAISE(ABORT, 'delete failure'); END;");
  t.after(() => db.exec('DROP TRIGGER IF EXISTS reject_config_delete'));
  assert.equal((await DELETE(request({}, 'DELETE'))).status, 503);
  assert.deepEqual(db.prepare('SELECT * FROM ai_configs').get(), before);
  assert.deepEqual(db.prepare('SELECT * FROM ai_config_generations').get(), fenceBefore);
  assert.equal((await POST(request({ ...config, apiKey: '', model: 'updated-after-failure' }))).status, 200);
  db.exec('DROP TRIGGER reject_config_delete');
  assert.equal((await DELETE(request({}, 'DELETE'))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
});
