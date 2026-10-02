import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fetchCompletion, upstreamPayload } from '../lib/assistant/core.ts';
import { POST as configPost } from '../app/api/ai/config/route.ts';
import { POST as classify } from '../app/api/reading/classify/route.ts';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';

function controlledJson() {
  let controller, cancelled = false;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'application/json' } });
  return { response, write: (text) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(), get cancelled() { return cancelled; } };
}

for (const streaming of [true, false]) {
  const mode = streaming ? 'SSE JSON fallback' : 'non-streaming JSON';
  test(`${mode} resets the idle timer on every body chunk`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const body = controlledJson();
    let settled = false;
    const pending = fetchCompletion(async () => body.response, 'https://llm.example.test', {},
      { idleMs: 100, totalMs: 1000, stream: streaming }).then(
      (completion) => { settled = true; return { completion }; },
      (error) => { settled = true; return { error }; });
    await nextTurn();
    for (const part of ['{"choices":[', '{"message":', '{"content":"OK"}', '}]}']) {
      t.mock.timers.tick(75);
      await nextTurn();
      assert.equal(settled, false, 'an active response must not time out');
      body.write(part);
      await nextTurn();
    }
    body.close();
    const result = await pending;
    assert.equal(result.error, undefined);
    assert.equal(result.completion.content, 'OK');
    assert.equal(body.cancelled, false);
  });

  test(`${mode} still cancels a genuinely idle body`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const body = controlledJson();
    const pending = fetchCompletion(async () => body.response, 'https://llm.example.test', {},
      { idleMs: 100, totalMs: 1000, stream: streaming });
    const rejected = assert.rejects(pending, (error) => error.code === 'upstream_timeout');
    await nextTurn();
    body.write('{');
    await nextTurn();
    t.mock.timers.tick(101);
    await rejected;
    assert.equal(body.cancelled, true);
  });

  test(`${mode} retains its total deadline despite active chunks`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const body = controlledJson();
    const pending = fetchCompletion(async () => body.response, 'https://llm.example.test', {},
      { idleMs: 100, totalMs: 200, stream: streaming });
    const rejected = assert.rejects(pending, (error) => error.code === 'upstream_timeout');
    await nextTurn();
    for (let index = 0; index < 3; index++) {
      t.mock.timers.tick(60);
      await nextTurn();
      assert.equal(body.cancelled, false, 'the total deadline has not elapsed');
      body.write(' ');
      await nextTurn();
    }
    t.mock.timers.tick(21);
    await rejected;
    assert.equal(body.cancelled, true);
  });

  test(`${mode} preserves caller cancellation and the byte limit`, async () => {
    const controller = new AbortController();
    const body = controlledJson();
    const pending = fetchCompletion(async () => body.response, 'https://llm.example.test', { signal: controller.signal },
      { idleMs: 5000, totalMs: 5000, stream: streaming });
    const rejected = assert.rejects(pending, (error) => error.code === 'request_aborted');
    await nextTurn();
    body.write('{');
    await nextTurn();
    controller.abort();
    await rejected;
    assert.equal(body.cancelled, true);
    const oversized = controlledJson();
    oversized.write('x'.repeat(300_001));
    await assert.rejects(fetchCompletion(async () => oversized.response, 'https://llm.example.test', {},
      { idleMs: 5000, totalMs: 5000, stream: streaming }), (error) => error.code === 'model_response_too_large');
    assert.equal(oversized.cancelled, true);
  });
}

test('official reasoning models omit unsupported temperature without changing other providers', () => {
  const prompt = { system: 'Return JSON.', user: '{}' };
  const payload = (model, baseUrl) => upstreamPayload(model, prompt, 'explain', 'openai-compatible', { baseUrl });
  for (const model of ['o1', 'o3', 'o4-mini', 'o4-mini-2025-04-16', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-2025-08-07']) {
    const official = payload(model, 'https://api.openai.com/v1');
    assert.equal('temperature' in official, false, model);
    assert.equal(official.max_completion_tokens, 10_000, model);
    const custom = payload(model, 'https://llm.example.test/v1');
    assert.equal(custom.temperature, 0.4, model);
    assert.equal(custom.max_tokens, 10_000, model);
  }
  for (const model of ['gpt-4.1-mini', 'gpt-4o', 'gpt-5-chat-latest', 'gpt-5.1']) {
    assert.equal(payload(model, 'https://api.openai.com/v1').temperature, 0.4, model);
  }
  assert.equal(upstreamPayload('deepseek-v4-flash', prompt, 'explain', 'deepseek',
    { baseUrl: 'https://api.deepseek.com/v1' }).temperature, 0.4);
});

test('an official FQDN trailing dot retains the official model parameters', () => {
  const prompt = { system: 'Return JSON.', user: '{}' };
  const options = { baseUrl: 'https://api.openai.com./v1', stream: true, cacheKey: 'test-cache' };
  const payload = upstreamPayload('o4-mini', prompt, 'explain', 'openai-compatible', options);
  assert.equal('temperature' in payload, false);
  assert.equal(payload.max_completion_tokens, 10_000);
  assert.equal('max_tokens' in payload, false);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.prompt_cache_key, 'test-cache');
  assert.equal(upstreamPayload('o4-mini', prompt, 'explain', 'openai-compatible',
    { baseUrl: 'https://api.openai.com.example.test/v1' }).temperature, .4);
});

test('reading classification uses the same official-model temperature rules', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  }
  env.DB = sqliteD1(db);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'compatibility@example.test');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: '{"category":"science","difficulty":"B1"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  };
  const post = (path, body, action) => new Request(`https://app.test${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vocab-action': action }, body: JSON.stringify(body) });
  for (const [baseUrl, model, expectedTemperature] of [
    ['https://api.openai.com/v1', 'o4-mini', undefined],
    ['https://api.openai.com/v1', 'gpt-4.1-mini', 0],
    ['https://llm.example.test/v1', 'o4-mini', 0],
  ]) {
    const saved = await configPost(post('/api/ai/config', { provider: 'openai-compatible', baseUrl, model,
      apiKey: 'test-only-not-a-real-key-1234567890', dailyLimit: 30, timeoutSeconds: 25 }, 'settings'));
    assert.equal(saved.status, 200);
    const response = await classify(post('/api/reading/classify', { title: 'A science article', text: 'This article describes a science experiment. '.repeat(4) }, 'reading-classify'));
    assert.equal(response.status, 200);
    const sent = calls.at(-1);
    assert.equal(sent.temperature, expectedTemperature);
    assert.equal('temperature' in sent, expectedTemperature !== undefined);
    assert.equal(sent[baseUrl.includes('api.openai.com') && model === 'o4-mini' ? 'max_completion_tokens' : 'max_tokens'], 160);
  }
});
