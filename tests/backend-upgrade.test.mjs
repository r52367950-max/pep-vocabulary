import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { reserveTokens, settleTokens, readTokenUsage, TokenBudgetError } from '../lib/assistant/usage.ts';
import { budgetDay } from '../lib/http.ts';
import { fetchCompletion, parseUsage, readChatCompletionStream, connectionTestPayload } from '../lib/assistant/core.ts';
import { GET as syncGet, POST as syncPost } from '../app/api/sync/route.ts';
import { POST as configPost, GET as configGet } from '../app/api/ai/config/route.ts';
import { POST as explain } from '../app/api/assistant/explain/route.ts';
import { POST as testConnection } from '../app/api/ai/test/route.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const binding = sqliteD1(db);
const config = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: 'test-only-no-real-key-1234567890', dailyLimit: 30, timeoutSeconds: 25, dailyTokenBudget: 10_000 };
const request = (path, body) => new Request(`https://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
const word = { id: 'pep-1e3e7e41accdc5f7', headword: 'abandon', chineseCore: '放弃', partsOfSpeech: ['vt'], scopes: [], sources: [], flags: { formalReleaseEligible: true } };
beforeEach(() => {
  db.exec('DELETE FROM ai_rate_limits; DELETE FROM ai_configs; DELETE FROM ai_preferences; DELETE FROM sync_states;');
  env.DB = binding;
  env.ASSETS = { fetch: async () => Response.json([word]) };
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'upgrade@example.test');
});

test('concurrent budget reservations never admit more than the available allowance', async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveTokens('user', 3000, 'prompt', 2000)));
  const accepted = results.filter((result) => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason instanceof TokenBudgetError));
  assert.ok((await readTokenUsage('user')).total <= 3000);
  const first = accepted[0].value;
  assert.equal(await settleTokens(first, { prompt: 100, completion: 50, total: 150, cacheHit: 80, estimated: false }), 150);
  assert.deepEqual({ ...(await readTokenUsage('user')), date: null, resetsAt: null }, { total: 150, output: 50, cacheHit: 80, date: null, resetsAt: null });
});

test('output is reduced to remaining budget and an uncertain failed call keeps its reservation', async () => {
  const reserved = await reserveTokens('user', 3000, 'prompt', 10_000);
  assert.equal(reserved.amount, 3000);
  assert.ok(reserved.maxOutputTokens > 256 && reserved.maxOutputTokens < 3000);
  await assert.rejects(reserveTokens('user', 3000, 'prompt', 100), TokenBudgetError);
  const failAfterFirstWrite = { ...binding, batch: async (statements) => binding.batch([statements[0], binding.prepare('SELECT * FROM missing_accounting_table')]) };
  env.DB = failAfterFirstWrite;
  assert.equal(await settleTokens(reserved, { prompt: 10, completion: 10, total: 20, cacheHit: 0, estimated: false }), null);
  env.DB = binding;
  assert.equal((await readTokenUsage('user')).total, 3000, 'first accounting write was rolled back');
});

test('a request finishing after midnight settles the day in which it began', async () => {
  const beforeMidnight = Date.parse('2026-09-29T15:59:59Z');
  const reserved = await reserveTokens('midnight', 2000, 'prompt', 500, beforeMidnight);
  await settleTokens(reserved, { prompt: 10, completion: 20, total: 30, cacheHit: 0, estimated: false });
  const rows = db.prepare("SELECT bucket_key, request_count FROM ai_rate_limits WHERE bucket_key LIKE 'tokens:day:midnight:%'").all();
  assert.deepEqual(rows.map((row) => [row.bucket_key, row.request_count]), [[`tokens:day:midnight:${budgetDay(beforeMidnight).start}`, 30]]);
});

test('provider usage cannot undercount its own prompt plus completion', () => {
  assert.equal(parseUsage({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1 }).total, 1100);
  assert.equal(parseUsage({ prompt_tokens: Infinity, completion_tokens: -1 }), null);
  assert.equal(connectionTestPayload('openai-compatible', 'o4-mini', true, 'https://api.openai.com/v1').max_completion_tokens, 64);
});

const stream = (rows, close = true) => new Response(new ReadableStream({ start(controller) {
  for (const row of rows) controller.enqueue(new TextEncoder().encode(`data: ${typeof row === 'string' ? row : JSON.stringify(row)}\n\n`));
  if (close) controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

test('valid JSON cut off before a terminal SSE event is rejected', async () => {
  const part = { choices: [{ delta: { content: '{"ok":true}' } }] };
  await assert.rejects(readChatCompletionStream(stream([part])), (error) => error.code === 'incomplete_stream');
  assert.equal((await readChatCompletionStream(stream([part, '[DONE]']))).content, '{"ok":true}');
  assert.equal((await readChatCompletionStream(stream([part, { choices: [{ finish_reason: 'stop' }] }]))).finishReason, 'stop');
});

test('caller cancellation prevents a fetch and interrupts a stalled body', async () => {
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  await assert.rejects(fetchCompletion(async () => { calls++; return Response.json({}); }, 'https://example.test', { signal: aborted.signal }, { idleMs: 5000, totalMs: 5000, stream: true }), (error) => error.code === 'request_aborted');
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = fetchCompletion(async () => stream([], false), 'https://example.test', { signal: active.signal }, { idleMs: 5000, totalMs: 5000, stream: true });
  setTimeout(() => active.abort(), 5);
  await assert.rejects(pending, (error) => error.code === 'request_aborted');
});

test('config and budget save together, and preference read failures fail closed', async (t) => {
  assert.equal((await configPost(request('/api/ai/config', config))).status, 200);
  db.exec("CREATE TRIGGER reject_budget BEFORE UPDATE ON ai_preferences BEGIN SELECT RAISE(ABORT, 'budget store failure'); END;");
  t.after(() => db.exec('DROP TRIGGER IF EXISTS reject_budget'));
  assert.equal((await configPost(request('/api/ai/config', { ...config, model: 'changed-model', dailyTokenBudget: 20_000 }))).status, 503);
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, config.model);
  assert.equal(db.prepare('SELECT daily_token_budget FROM ai_preferences').get().daily_token_budget, 10_000);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  env.DB = { ...binding, prepare(sql) { if (sql.includes('ai_preferences')) throw new Error('transient database error'); return binding.prepare(sql); } };
  assert.equal((await configGet()).status, 503);
  assert.equal((await explain(request('/api/assistant/explain', { wordId: word.id }))).status, 503);
  assert.equal(calls, 0);
});

test('an exhausted budget blocks credentialed connection-test generations', async (t) => {
  assert.equal((await configPost(request('/api/ai/config', config))).status, 200);
  await reserveTokens(await authenticatedUserKey(), 10_000, 'prompt', 10_000);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const auth = [];
  globalThis.fetch = async (_url, init) => { auth.push(new Headers(init?.headers).get('authorization')); return new Response('{}', { status: 401 }); };
  const response = await testConnection(request('/api/ai/test', {}));
  assert.equal(response.status, 429, await response.clone().text());
  assert.ok(auth.every((value) => value === null), 'only credential-free reachability probes may occur');
});

test('competing configuration saves keep the winning credential and budget together', async () => {
  assert.equal((await configPost(request('/api/ai/config', config))).status, 200);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let arrivals = 0;
  env.DB = { ...binding, async batch(statements) { if (++arrivals === 2) release(); await barrier; return binding.batch(statements); } };
  const variants = [{ ...config, model: 'first', dailyTokenBudget: 20_000 }, { ...config, model: 'second', dailyTokenBudget: 30_000 }];
  const results = await Promise.all(variants.map((body) => configPost(request('/api/ai/config', body))));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  const winner = variants[results.findIndex((response) => response.status === 200)];
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, winner.model);
  assert.equal(db.prepare('SELECT daily_token_budget FROM ai_preferences').get().daily_token_budget, winner.dailyTokenBudget);
});

test('a stale settings save cannot recreate a deleted API credential', async () => {
  assert.equal((await configPost(request('/api/ai/config', config))).status, 200);
  env.DB = { ...binding, async batch(statements) { db.exec('DELETE FROM ai_configs'); return binding.batch(statements); } };
  const response = await configPost(request('/api/ai/config', { ...config, apiKey: '', model: 'stale', dailyTokenBudget: 40_000 }));
  assert.equal(response.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
  assert.equal(db.prepare('SELECT daily_token_budget FROM ai_preferences').get().daily_token_budget, 10_000);
});

test('metadata sync reads do not select or return the old backup body', async () => {
  const backup = { schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] };
  assert.equal((await syncPost(request('/api/sync', { schemaVersion: '1.2.0', baseRevision: 0, clientUpdatedAt: new Date().toISOString(), payload: backup }))).status, 200);
  const queries = [];
  env.DB = { ...binding, prepare(sql) { queries.push(sql); return binding.prepare(sql); } };
  const metaResponse = await syncGet(new Request('https://app.test/api/sync?metadata=1'));
  const meta = await metaResponse.json();
  assert.equal(meta.state.revision, 1);
  assert.equal('payload' in meta.state, false);
  assert.ok(queries.filter((sql) => /select.*sync_states/i.test(sql)).every((sql) => !sql.includes('payload')));
  assert.ok(metaResponse.headers.get('cache-control').includes('no-store'));
  assert.deepEqual(JSON.parse((await (await syncGet()).json()).state.payload).cards, []);
});

test('expired bucket cleanup uses the new index', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM ai_rate_limits WHERE expires_at < ?').all(Date.now());
  assert.match(JSON.stringify(plan), /idx_ai_rate_limits_expires_at/);
});
