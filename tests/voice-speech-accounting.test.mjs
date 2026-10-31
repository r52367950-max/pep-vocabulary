import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { createVoiceSpeech, voiceStatus, reserveVoiceSeconds } from '../lib/voice/server.ts';
import { estimatedSpeechSeconds, speechDurationSeconds } from '../lib/voice/openai.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';

const json = body => new Request('https://app.test/api/voice/speech', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
async function setup() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  env.DB = sqliteD1(db);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'speech-accounting@example.test');
  const { POST } = await import('../app/api/ai/config/route.ts');
  const response = await POST(json({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: 'not-a-real-key-only-for-offline-test', timeoutSeconds: 25, dailyLimit: 100, dailyTokenBudget: 200000 }));
  assert.equal(response.status, 200, await response.clone().text());
  return db;
}
function wav(seconds, ancillary = false) {
  const bytes = Buffer.alloc(44 + seconds * 16000 + (ancillary ? 12 : 0));
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  let dataOffset = 36;
  if (ancillary) { bytes.write('JUNK', 36); bytes.writeUInt32LE(3, 40); dataOffset += 12; }
  bytes.write('data', dataOffset); bytes.writeUInt32LE(seconds * 16000, dataOffset + 4);
  return bytes;
}
const used = async () => (await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json()).usedSeconds;

test('admission counts punctuation-equivalent spoken tokens and long non-whitespace runs', () => {
  const words = Array(80).fill('a');
  assert.equal(Math.max(4, Math.ceil(words.join(',').split(/\s+/).length * .8)), 4, 'old estimator undercounted the trigger');
  for (const rate of [.5, 1, 1.5]) {
    const control = estimatedSpeechSeconds(words.join(' '), rate);
    for (const separator of [',', '.', '-', '，', '\n']) assert.equal(estimatedSpeechSeconds(words.join(separator), rate), control);
    assert.ok(control > 4);
  }
  assert.equal(estimatedSpeechSeconds('Don’t stop, stay curious!', .8), estimatedSpeechSeconds("Don't stop stay curious", .8));
  assert.ok(estimatedSpeechSeconds('a' + '1'.repeat(100), 1) >= 80);
  assert.ok(estimatedSpeechSeconds('a' + '汉'.repeat(100), 1) >= 80);
  assert.ok(estimatedSpeechSeconds('a'.repeat(600), 1) >= 96);
});

test('WAV duration parsing handles metadata and rejects inconsistent/truncated/unknown formats', () => {
  assert.equal(speechDurationSeconds(wav(9)), 9);
  assert.equal(speechDurationSeconds(wav(9, true)), 9);
  assert.equal(speechDurationSeconds(new Uint8Array(44)), null);
  assert.equal(speechDurationSeconds(wav(9).subarray(0, 100)), null);
  const badRate = wav(9); badRate.writeUInt32LE(1, 28);
  assert.equal(speechDurationSeconds(badRate), null);
  const compressed = wav(9); compressed.writeUInt16LE(6, 20);
  assert.equal(speechDurationSeconds(compressed), null);
  const badLength = wav(9); badLength.writeUInt32LE(1, 40);
  assert.equal(speechDurationSeconds(badLength), null);
});

test('speech endpoint charges normalized admission and upward-only measured duration', async t => {
  await setup();
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let seconds = 1, malformed = false, wrong = false;
  globalThis.fetch = async (_url, init) => {
    const expected = JSON.parse(JSON.parse(init.body).messages[1].content).quotedText;
    const bytes = wav(seconds, true);
    if (malformed) bytes.writeUInt32LE(1, 28);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: bytes.toString('base64'), transcript: wrong ? 'unrelated' : expected } } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
  };
  const punctuation = Array(40).fill('a').join(',');
  assert.equal((await createVoiceSpeech(json({ text: punctuation }))).status, 200);
  assert.equal(await used(), estimatedSpeechSeconds(punctuation, 1), 'short audio cannot refund admission');
  seconds = 9;
  assert.equal((await createVoiceSpeech(json({ text: 'stay curious' }))).status, 200);
  assert.equal(await used(), 41, 'nine measured seconds replace four-second floor upwards');
  malformed = true;
  assert.equal((await createVoiceSpeech(json({ text: 'stay curious' }))).status, 200);
  assert.equal(await used(), 45, 'unknown duration retains estimate');
  malformed = false; wrong = true;
  assert.equal((await createVoiceSpeech(json({ text: punctuation }))).status, 502);
  assert.equal(await used(), 77, 'failed transcript keeps full reservation');
});

test('measured overage remains charged and blocks later paid admission', async t => {
  await setup();
  await reserveVoiceSeconds(await authenticatedUserKey(), 3596);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ choices: [{ message: { audio: { data: wav(9).toString('base64'), transcript: 'word' } } }] }); };
  assert.equal((await createVoiceSpeech(json({ text: 'word' }))).status, 200);
  assert.equal(await used(), 3605);
  assert.equal((await createVoiceSpeech(json({ text: 'word' }))).status, 429);
  assert.equal(calls, 1);
});
