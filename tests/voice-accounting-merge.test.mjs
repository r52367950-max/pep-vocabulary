import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { POST as configure } from '../app/api/ai/config/route.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { readTokenUsage } from '../lib/assistant/usage.ts';
import { createVoiceSpeech } from '../lib/voice/server.ts';

const request = (body, extra = {}) => new Request('https://app.test/api/voice/speech', {
  method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});

test('speech settlement preserves token floors, larger audio usage and uncertain-call reservations', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  }
  env.DB = sqliteD1(db);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'speech-accounting@example.test');
  assert.equal((await configure(request({
    provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra',
    apiKey: 'offline-only-key-never-sent-to-provider', dailyLimit: 100, timeoutSeconds: 25, dailyTokenBudget: 200000,
  }, { 'x-vocab-action': 'settings' }))).status, 200);
  const key = await authenticatedUserKey();
  const bytes = new Uint8Array(44);
  bytes.set(new TextEncoder().encode('RIFF'));
  bytes.set(new TextEncoder().encode('WAVE'), 8);
  let transcript = 'Stay curious.';
  let usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { audio: { data: Buffer.from(bytes).toString('base64'), transcript } } }],
    ...(usage ? { usage } : {}),
  });
  assert.equal((await createVoiceSpeech(request({ text: 'stay curious' }))).status, 200);
  const floor = await readTokenUsage(key);
  assert.ok(floor.total > 2, 'tiny reported usage cannot erase the prompt/output floor');
  usage = { prompt_tokens: 1000, completion_tokens: 4000, total_tokens: 5000 };
  assert.equal((await createVoiceSpeech(request({ text: 'stay curious' }))).status, 200);
  const audioUsage = await readTokenUsage(key);
  assert.equal(audioUsage.total - floor.total, 5000, 'provider audio tokens above the text floor remain charged');
  assert.equal(audioUsage.output - floor.output, 4000);
  transcript = 'a different sentence';
  usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  assert.equal((await createVoiceSpeech(request({ text: 'stay curious' }))).status, 502);
  const invalid = await readTokenUsage(key);
  assert.ok(invalid.total - audioUsage.total > 2048, 'invalid speech retains prompt plus output reservation');
  assert.equal(invalid.output, audioUsage.output);
  transcript = 'Stay curious.';
  usage = null;
  assert.equal((await createVoiceSpeech(request({ text: 'stay curious' }))).status, 200);
  assert.ok((await readTokenUsage(key)).total - invalid.total > 2048, 'unknown provider usage retains reservation');
});
