import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { createVoiceSession, closeVoiceSession, createVoiceSpeech, voiceFeedback, voiceStatus, reserveVoiceSeconds, sanitizeVoiceFeedback } from '../lib/voice/server.ts';
import { VOICE_TOPICS } from '../lib/voice/curriculum.ts';
import { closeOpenAISession, normalizedSpeechText, speechAudio, voiceOpenAI } from '../lib/voice/openai.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';

const json = (body, headers = {}) => new Request('https://app.test/api/voice/session', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const fakeKey = 'not-a-real-key-only-for-offline-test';
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  env.DB = sqliteD1(db);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'voice-owner@example.test');
  return db;
}
async function configure() {
  const { POST } = await import('../app/api/ai/config/route.ts');
  const response = await POST(json({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: fakeKey, timeoutSeconds: 25, dailyLimit: 100, dailyTokenBudget: 200000 }, { 'x-vocab-action': 'settings' }));
  assert.equal(response.status, 200, await response.clone().text());
}
function wav() { const bytes = new Uint8Array(44); bytes.set(new TextEncoder().encode('RIFF')); bytes.set(new TextEncoder().encode('WAVE'), 8); return Buffer.from(bytes).toString('base64'); }
const voiceInput = () => ({ topicId: VOICE_TOPICS[0].id, level: 'B1', minutes: 5, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', targetWords: ['curious'] });

test('voice admission authenticates before parsing, bounds bodies and fails closed without config', async () => {
  setup();
  requestHeaders.delete('oai-authenticated-user-email');
  assert.equal((await createVoiceSession(json({}))).status, 401);
  assert.equal((await createVoiceSession(json({}, { origin: 'https://attacker.test' }))).status, 403);
  requestHeaders.set('oai-authenticated-user-email', 'voice-owner@example.test');
  assert.equal((await createVoiceSession(json({ text: 'x'.repeat(65000) }))).status, 413);
  const response = await voiceStatus(new Request('https://app.test/api/voice/status'));
  const status = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(status.configured, false);
  assert.equal(status.reasonCode, 'assistant_not_configured');
  assert.match(status.reason, /请先在设置中保存/);
  assert.equal(status.dailySecondsLimit, 3600);
  assert.equal(status.models.voice, 'gpt-live-1');
});

test('persistent seconds admission prevents parallel over-budget requests', async () => {
  setup();
  const outcomes = await Promise.allSettled([reserveVoiceSeconds('budget-user', 2400), reserveVoiceSeconds('budget-user', 2400)]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((value) => value.status === 'rejected').reason.code, 'voice_budget_exhausted');
});

test('microphone-free connection diagnostic reserves only twenty seconds', async (t) => {
  setup(); await configure();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ session: { id: 'live_probe' }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' } });
  const response = await createVoiceSession(json({ ...voiceInput(), diagnostic: true }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).maxSeconds, 20);
  const status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.usedSeconds, 20);
});

test('status works with production D1 pattern limits and isolates account session prefixes', async () => {
  const db = setup(); await configure();
  const userKey = await authenticatedUserKey();
  const until = Date.now() + 300000;
  for (const [key, time] of [[`voice-session:${userKey}:live_own`, until], [`voice-session:${userKey}extra:live_other`, until + 1000], ['voice-session:someone-else:live_other', until + 2000]]) {
    db.prepare('INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)').run(key, time, time + 86400000);
  }
  const original = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const statement = original(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      if (/\b(?:LIKE|GLOB)\s+\?/i.test(sql) && args.some(value => typeof value === 'string' && value.length > 50)) {
        throw new Error('D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR');
      }
      return bind(...args);
    };
    return statement;
  };
  const response = await voiceStatus(new Request('https://app.test/api/voice/status'));
  assert.equal(response.status, 200, await response.clone().text());
  const status = await response.json();
  assert.equal(status.ready, true);
  assert.equal(status.activeSession.sessionId, 'live_own');
  db.prepare('UPDATE ai_rate_limits SET request_count=0 WHERE bucket_key=?').run(`voice-session:${userKey}:live_own`);
  assert.equal((await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json()).activeSession, null);
});

test('Live uses BYOK fixed host, single active session, durable ownership and idempotent close', async (t) => {
  const db = setup(); await configure();
  const calls = [], originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/attach')) {
      const socket = new EventTarget();
      socket.accept = () => {};
      socket.close = () => {};
      socket.send = (data) => {
        assert.equal(JSON.parse(data).type, 'session.close');
        queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.closed' }) })));
      };
      return { status: 101, webSocket: socket };
    }
    return Response.json({ session: { id: 'live_test_session' }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' } });
  };
  const response = await createVoiceSession(json(voiceInput()));
  const session = await response.json();
  assert.equal(response.status, 200, JSON.stringify(session));
  assert.equal(session.maxSeconds, 300);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${fakeKey}`);
  assert.equal(calls[0].body.session.store, false);
  assert.equal(calls[0].body.transport.sdp, voiceInput().sdp, 'browser SDP, including its final CRLF, must reach OpenAI unchanged');
  assert.equal(calls[0].body.session.delegation.responses.model, 'gpt-6.1-terra');
  assert.equal(JSON.stringify(session).includes(fakeKey), false);
  assert.equal((await createVoiceSession(json(voiceInput()))).status, 409);
  assert.equal(calls.length, 1, 'single-active admission happens before paid API');
  const activeStatus = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(activeStatus.activeSession.sessionId, session.sessionId);
  assert.equal(activeStatus.readiness, 'configuration-only');
  const key = await authenticatedUserKey();
  assert.ok(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key = ?').get(`voice-session:${key}:live_test_session`));
  requestHeaders.set('oai-authenticated-user-email', 'another-owner@example.test');
  await configure();
  assert.equal((await closeVoiceSession(json({ sessionId: session.sessionId }))).status, 404);
  assert.equal(calls.length, 1);
  requestHeaders.set('oai-authenticated-user-email', 'voice-owner@example.test');
  assert.equal((await closeVoiceSession(json({ sessionId: session.sessionId }))).status, 200);
  assert.equal((await closeVoiceSession(json({ sessionId: session.sessionId }))).status, 200);
  assert.equal(calls.length, 2);
  const finalStatus = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(finalStatus.usedSeconds, 300, 'early close does not refund an uncertain paid session');
  assert.equal(finalStatus.activeSession, null);
});

test('speech requires transcript agreement, valid WAV, and retains reservation after mismatch', async (t) => {
  assert.notEqual(normalizedSpeechText('ice cream'), normalizedSpeechText('icecream'));
  assert.equal(normalizedSpeechText('Stay, curious!'), normalizedSpeechText('stay curious'));
  assert.equal(normalizedSpeechText('don’t'), normalizedSpeechText("don't"));
  setup(); await configure();
  const calls = [], originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let transcript = 'Stay curious.';
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { audio: { data: wav(), transcript } } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
  };
  const good = await createVoiceSpeech(json({ text: 'stay curious', rate: .8 }));
  assert.equal(good.status, 200, await good.clone().text());
  assert.equal(good.headers.get('content-type'), 'audio/wav');
  assert.equal((await good.arrayBuffer()).byteLength, 44);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-audio-1.5');
  assert.match(calls[0].body.messages[0].content, /verbatim/);
  transcript = 'Stay curious and keep learning.';
  const wrong = await createVoiceSpeech(json({ text: 'stay curious' }));
  assert.equal(wrong.status, 502);
  assert.equal((await wrong.json()).error.code, 'speech_text_mismatch');
  const status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.usedSeconds, 8);
  assert.equal((await createVoiceSpeech(json({ text: 'word', rate: 0 }))).status, 400);
  assert.equal((await createVoiceSpeech(json({ text: 'x'.repeat(601) }))).status, 400);
  assert.equal(calls.length, 2);
  assert.throws(() => speechAudio({ choices: [{ message: { audio: { data: 'AAAA', transcript: 'word' } } }] }, 'word'), /音频无效/);
});

test('voice fixed-host transport rejects redirect bodies, bounds replies and cancels stalled bodies', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('secret-upstream-body', { status: 307, headers: { location: 'https://attacker.test' } });
  await assert.rejects(voiceOpenAI(json({}), fakeKey, '/v1/live/sessions', {}), (error) => error.code === 'provider_redirect_rejected' && !error.message.includes('secret-upstream'));
  globalThis.fetch = async () => new Response('private upstream auth failure', { status: 401 });
  await assert.rejects(closeOpenAISession(json({}), fakeKey, 'live_owned', 100), (error) => error.code === 'provider_auth_failed' && !error.message.includes('private upstream'));
  globalThis.fetch = async () => new Response('x'.repeat(100));
  await assert.rejects(voiceOpenAI(json({}), fakeKey, '/v1/live/sessions', {}, 10), (error) => error.code === 'model_response_too_large');
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  await assert.rejects(voiceOpenAI(json({}), fakeKey, '/v1/live/sessions', {}, 100, 5), (error) => error.code === 'upstream_timeout');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(voiceOpenAI(new Request('https://app.test', { signal: controller.signal }), fakeKey, '/v1/live/sessions', {}), (error) => error.code === 'request_aborted');
});

test('feedback uses official Responses, quotes actual learner turns and rejects invented corrections', async (t) => {
  setup(); await configure();
  const originalFetch = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  const feedback = { strength: '给出了具体原因。', improvements: [{ original: 'I likes books', suggestion: 'I like books', reason: '主谓一致。' }], retryPrompt: 'What do you like reading?', expressions: [{ text: 'be curious about', meaning: '对……好奇' }] };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(feedback) }] }], usage: { input_tokens: 300, output_tokens: 200, total_tokens: 500 } });
  };
  const response = await voiceFeedback(json({ topicId: VOICE_TOPICS[0].id, level: 'B1', transcript: [{ role: 'assistant', text: 'What do you like?' }, { role: 'user', text: 'I likes books because they are interesting.' }] }));
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.improvements[0].original, 'I likes books');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.max_output_tokens, 2400);
  assert.match(result.limitation, /不据此判断发音/);
  assert.throws(() => sanitizeVoiceFeedback(JSON.stringify(feedback), ['different actual learner turn']), /有效的口语反馈/);
});

 test('WebRTC close waits for session.closed and fails when finalization is unconfirmed', async (t) => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let sent, closed = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/live/sessions/live_owned/attach');
    assert.equal(init.headers.upgrade, 'websocket');
    const socket = new EventTarget(); socket.accept = () => {}; socket.close = () => { closed = true; };
    socket.send = (data) => { sent = JSON.parse(data); };
    return { status: 101, webSocket: socket };
  };
  await assert.rejects(closeOpenAISession(json({}), fakeKey, 'live_owned', 5), (error) => error.code === 'voice_close_unconfirmed');
  assert.equal(sent.type, 'session.close'); assert.equal(closed, true);
});

test('known created sessions are closed if ownership persistence fails', async (t) => {
  const db = setup(); await configure();
  const realDB = env.DB, originalFetch = globalThis.fetch;
  t.after(() => { env.DB = realDB; globalThis.fetch = originalFetch; });
  env.DB = { ...realDB, prepare(sql) {
    const statement = realDB.prepare(sql);
    if (sql === "INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)") {
      return { bind: () => ({ run: async () => { throw new Error('simulated persistence failure'); } }) };
    }
    return statement;
  } };
  let finalized = false;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/attach')) {
      const socket = new EventTarget(); socket.accept = () => {}; socket.close = () => {};
      socket.send = () => { finalized = true; queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"session.closed"}' }))); };
      return { status: 101, webSocket: socket };
    }
    return Response.json({ session: { id: 'live_orphan_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' } });
  };
  const response = await createVoiceSession(json(voiceInput()));
  assert.equal(response.status, 503);
  assert.equal(finalized, true);
  const userKey = await authenticatedUserKey();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key = ?').get(`voice-active:${userKey}`).request_count, 0);
});

test('cancellation after session persistence closes the known upstream session', async (t) => {
  const db = setup(); await configure();
  const realDB = env.DB, originalFetch = globalThis.fetch, controller = new AbortController();
  t.after(() => { env.DB = realDB; globalThis.fetch = originalFetch; });
  env.DB = { ...realDB, prepare(sql) {
    const statement = realDB.prepare(sql);
    if (sql === "INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)") {
      return { bind(...args) { return { run: async () => { const result = await statement.bind(...args).run(); controller.abort(); return result; } }; } };
    }
    return statement;
  } };
  let finalized = false;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/attach')) {
      const socket = new EventTarget(); socket.accept = () => {}; socket.close = () => {};
      socket.send = () => { finalized = true; queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"session.closed"}' }))); };
      return { status: 101, webSocket: socket };
    }
    return Response.json({ session: { id: 'live_cancelled_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111' } });
  };
  const response = await createVoiceSession(new Request(json(voiceInput()), { signal: controller.signal }));
  assert.equal(response.status, 499);
  assert.equal(finalized, true);
  const userKey = await authenticatedUserKey();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key = ?').get(`voice-session:${userKey}:live_cancelled_test`).request_count, 0);
});
