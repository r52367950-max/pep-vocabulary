import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { complete } from '../lib/assistant/server.ts';
import { readTokenUsage } from '../lib/assistant/usage.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const config = {
  userKey: 'merge-responses', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-6.1-terra', apiKey: 'test-only-key-never-sent-to-a-real-provider',
  dailyTokenBudget: 10_000, maxOutputTokens: 256, timeoutMs: 1000, dailyLimit: 30,
};
const messages = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Explain this sample.' }];
const request = () => new Request('https://app.test/api/assistant/explain');
const payload = { model: config.model, messages, max_tokens: 256, temperature: 0.3, response_format: { type: 'json_object' }, stream: false };
beforeEach(() => {
  db.exec('DELETE FROM ai_rate_limits;');
  env.DB = sqliteD1(db);
  delete env.AI_ALLOWED_PROVIDER_ORIGINS;
});

test('Responses generation retains the shared atomic budget and independent usage floor', async () => {
  const originalFetch = globalThis.fetch;
  const content = '{"explanation":"' + 'sample '.repeat(25) + '"}';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.redirect, 'manual');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input, messages);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  try {
    const { completion, today } = await complete(config, request(), payload);
    assert.equal(calls, 1);
    assert.equal(completion.content, content);
    const estimate = (value) => Math.max(Math.ceil(Buffer.byteLength(value) / 3), Math.ceil(value.length / 2));
    const expectedFloor = estimate(JSON.stringify(messages)) + 256 + estimate(content);
    assert.equal(completion.usage.total, expectedFloor);
    assert.equal(completion.usage.estimated, true);
    assert.equal(today, expectedFloor);
    assert.equal((await readTokenUsage(config.userKey)).total, expectedFloor);
  } finally { globalThis.fetch = originalFetch; }
});

test('Responses connection endpoint overrides cannot bypass the operator origin policy', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not contact an unapproved host'); };
  try {
    await assert.rejects(complete(config, request(), payload, { url: 'https://unapproved.example/v1/responses' }));
    assert.equal(calls, 0);
    // No response was independently accounted for, so the reservation remains.
    assert.ok((await readTokenUsage(config.userKey)).total > 256);
  } finally { globalThis.fetch = originalFetch; }
});
