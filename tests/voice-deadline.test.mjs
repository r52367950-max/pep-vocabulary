import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { deadlineNamespace } from './voice-deadline-env.mjs';
import { armVoiceDeadline, voicePendingExpiry } from '../lib/voice/deadline.ts';
import { createVoiceSession, closeVoiceSession, voiceStatus } from '../lib/voice/server.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';

const key = 'offline-test-key-never-sent-to-a-provider';
const post = (body, headers = {}) => new Request('https://app.test/api/voice/session', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const input = { topicId: 'daily-life', level: 'B1', minutes: 5, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
async function setup() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  env.DB = sqliteD1(db); env.VOICE_DEADLINES = deadlineNamespace(env);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'deadline-owner@example.test');
  const { POST } = await import('../app/api/ai/config/route.ts');
  const response = await POST(post({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: key, timeoutSeconds: 25, dailyLimit: 100, dailyTokenBudget: 200000 }, { 'x-vocab-action': 'settings' }));
  assert.equal(response.status, 200, await response.clone().text());
  const { VOICE_TOPICS } = await import('../lib/voice/curriculum.ts'); input.topicId = VOICE_TOPICS[0].id;
  return { db, userKey: await authenticatedUserKey() };
}
function mockProvider(t, id = 'live_deadline_test') {
  const calls = [], old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/attach')) {
      const socket = new EventTarget(); socket.accept = () => {}; socket.close = () => {};
      socket.send = data => {
        assert.equal(JSON.parse(data).type, 'session.close');
        queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"session.closed"}' })));
      };
      return { status: 101, webSocket: socket };
    }
    return Response.json({ session: { id }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
  };
  return calls;
}
test('deadline binding is required before any paid capability or seconds reservation', async t => {
  await setup(); const calls = mockProvider(t);
  delete env.VOICE_DEADLINES;
  const status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.ready, false); assert.equal(status.reasonCode, 'voice_deadline_unavailable');
  const response = await createVoiceSession(post(input));
  assert.equal(response.status, 503); assert.equal(calls.length, 0);
  assert.equal((await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json()).usedSeconds, 0);
});
test('one-second server deadline closes after eviction without any browser code or saved config', async t => {
  const { db, userKey } = await setup(); const calls = mockProvider(t);
  const now = Date.now(), oldNow = Date.now; t.after(() => { Date.now = oldNow; });
  Date.now = () => now;
  const until = now + 61_000, id = 'live_one_second';
  for (const bucket of [`voice-active:${userKey}`, `voice-session:${userKey}:${id}`]) db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(bucket, until, voicePendingExpiry(until));
  await armVoiceDeadline(userKey, id, until, key);
  let entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${id}`);
  assert.equal(entry.state.storage.alarm, now + 1000);
  assert.ok(!JSON.stringify([...entry.state.storage.values]).includes(key), 'only authenticated ciphertext is durable');
  db.exec('DELETE FROM ai_configs');
  entry = env.VOICE_DEADLINES.restart(`${userKey}:${id}`);
  await entry.object.alarm(); assert.equal(calls.length, 0, 'early alarm cannot shorten legitimate session');
  Date.now = () => now + 1000;
  await entry.object.alarm();
  assert.equal(calls.length, 1); assert.match(calls[0].url, /live_one_second\/attach$/);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${key}`);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, 0);
  assert.deepEqual(await entry.state.storage.get('session'), { closed: true });
  assert.equal(entry.state.storage.alarm, null);
});
test('failed deadline closure retains bounded admission and durably retries after restart', async t => {
  const { db, userKey } = await setup(); const calls = mockProvider(t);
  const response = await createVoiceSession(post({ ...input, diagnostic: true }));
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json(), name = `${userKey}:${result.sessionId}`;
  let entry = env.VOICE_DEADLINES.entries.get(name);
  const record = await entry.state.storage.get('session');
  const oldNow = Date.now; t.after(() => { Date.now = oldNow; }); Date.now = () => record.until - 60_000;
  const goodProvider = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(entry.object.alarm());
  assert.equal(entry.state.storage.alarm, Date.now() + 15_000);
  assert.equal(db.prepare('SELECT expires_at FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).expires_at, voicePendingExpiry(record.until));
  assert.equal((await createVoiceSession(post(input))).status, 409);
  assert.equal((await entry.state.storage.get('session')).until, record.until);
  const retryAt = entry.state.storage.alarm;
  globalThis.fetch = goodProvider; Date.now = () => retryAt; entry = env.VOICE_DEADLINES.restart(name);
  await entry.object.alarm();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, 0);
  assert.equal(calls.length, 2);
});
test('owned early close survives credential deletion, stays idempotent and isolates another account', async t => {
  const { db, userKey } = await setup(); const calls = mockProvider(t);
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 200, await response.clone().text());
  const { sessionId } = await response.json(); db.exec('DELETE FROM ai_configs');
  requestHeaders.set('oai-authenticated-user-email', 'other@example.test');
  assert.equal((await closeVoiceSession(post({ sessionId }))).status, 404); assert.equal(calls.length, 1);
  requestHeaders.set('oai-authenticated-user-email', 'deadline-owner@example.test');
  assert.equal((await closeVoiceSession(post({ sessionId }))).status, 200);
  assert.equal((await closeVoiceSession(post({ sessionId }))).status, 200); assert.equal(calls.length, 2);
  assert.deepEqual(await env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`).state.storage.get('session'), { closed: true });
});
test('late alarm releases only its original lease and treats provider 404 as finalized', async t => {
  const { db, userKey } = await setup(); mockProvider(t);
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 200, await response.clone().text());
  const { sessionId } = await response.json(), entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`);
  const record = await entry.state.storage.get('session');
  db.prepare('UPDATE ai_rate_limits SET request_count=? WHERE bucket_key=?').run(record.until + 999, `voice-active:${userKey}`);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const oldNow = Date.now; t.after(() => { Date.now = oldNow; }); Date.now = () => record.until;
  await entry.object.alarm();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, record.until + 999);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-session:${userKey}:${sessionId}`).request_count, 0);
});
test('alarm propagates retry-storage failure for Cloudflare automatic retries', async t => {
  const { db, userKey } = await setup(); mockProvider(t);
  const response = await createVoiceSession(post({ ...input, diagnostic: true })); assert.equal(response.status, 200);
  const { sessionId } = await response.json(), entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`);
  const record = await entry.state.storage.get('session'), oldNow = Date.now;
  t.after(() => { Date.now = oldNow; }); Date.now = () => record.until;
  entry.state.storage.setAlarm = async () => { throw new Error('durable storage unavailable'); };
  await assert.rejects(entry.object.alarm(), /durable storage unavailable/);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, record.until);
  assert.equal((await entry.state.storage.get('session')).sessionId, sessionId);
});
test('ownership persistence failure still has a durable close retry when immediate close fails', async t => {
  const { db, userKey } = await setup(); const calls = mockProvider(t, 'live_failed_persistence');
  const originalPrepare = env.DB.prepare, goodFetch = globalThis.fetch;
  env.DB.prepare = sql => {
    if (sql === 'INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)') return { bind: () => ({ run: async () => { throw new Error('ownership write failed'); } }) };
    return originalPrepare(sql);
  };
  globalThis.fetch = (url, init) => url.endsWith('/attach') ? Promise.resolve(new Response(null, { status: 503 })) : goodFetch(url, init);
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 503);
  const entry = env.VOICE_DEADLINES.entries.get(`${userKey}:live_failed_persistence`);
  const record = await entry.state.storage.get('session');
  assert.equal(record.sessionId, 'live_failed_persistence'); assert.ok(entry.state.storage.alarm);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, record.until);
  env.DB.prepare = originalPrepare; globalThis.fetch = goodFetch;
  const oldNow = Date.now; t.after(() => { Date.now = oldNow; }); Date.now = () => record.until;
  await entry.object.alarm();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, 0);
  assert.equal(calls.length, 2);
});
test('transient arming failure retries durable registration before returning an error', async t => {
  const { userKey } = await setup(); mockProvider(t, 'live_arm_retry');
  const namespace = env.VOICE_DEADLINES, originalGet = namespace.get;
  let armAttempts = 0;
  namespace.get = name => {
    const stub = originalGet(name);
    return { fetch(url, init) {
      if (url.endsWith('/arm') && ++armAttempts === 1) return Promise.resolve(new Response(null, { status: 503 }));
      return stub.fetch(url, init);
    } };
  };
  const goodFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => url.endsWith('/attach') ? Promise.resolve(new Response(null, { status: 503 })) : goodFetch(url, init);
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.sdp, undefined);
  assert.equal(armAttempts, 2);
  const entry = namespace.entries.get(`${userKey}:live_arm_retry`);
  assert.equal((await entry.state.storage.get('session')).sessionId, 'live_arm_retry');
  assert.ok(entry.state.storage.alarm);
});
test('finalized D1 row fences stale cleanup when a new session has an identical timestamp lease', async t => {
  const { db, userKey } = await setup(); mockProvider(t, 'live_old_collision');
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 200);
  const { sessionId } = await response.json(), entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`);
  const record = await entry.state.storage.get('session'), originalTransaction = entry.state.storage.transaction;
  entry.state.storage.transaction = callback => originalTransaction(transaction => callback({ ...transaction,
    put: async (name, value) => { if (value.closed) throw new Error('final DO tombstone failed'); return transaction.put(name, value); },
  }));
  assert.equal((await closeVoiceSession(post({ sessionId }))).status, 503);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, 0);
  db.prepare('UPDATE ai_rate_limits SET request_count=? WHERE bucket_key=?').run(record.until, `voice-active:${userKey}`);
  db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(`voice-session:${userKey}:live_new_collision`, record.until, voicePendingExpiry(record.until));
  entry.state.storage.transaction = originalTransaction;
  const oldNow = Date.now; t.after(() => { Date.now = oldNow; }); Date.now = () => record.until;
  await entry.object.alarm();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, record.until, 'stale retry must not release the new call');
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-session:${userKey}:live_new_collision`).request_count, record.until);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-session:${userKey}:${sessionId}`).request_count, 0);
});
test('missing ownership row is durably finalized so repeated cleanup cannot release a replacement lease', async t => {
  const { db, userKey } = await setup(); mockProvider(t, 'live_missing_owner');
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 200);
  const { sessionId } = await response.json(), entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`);
  const record = await entry.state.storage.get('session'), originalTransaction = entry.state.storage.transaction;
  db.prepare('DELETE FROM ai_rate_limits WHERE bucket_key=?').run(`voice-session:${userKey}:${sessionId}`);
  entry.state.storage.transaction = callback => originalTransaction(transaction => callback({ ...transaction,
    put: async (name, value) => { if (value.closed) throw new Error('final DO tombstone failed'); return transaction.put(name, value); },
  }));
  assert.equal((await entry.object.fetch(new Request('https://voice-deadline/close', { method: 'POST' }))).status, 503);
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-session:${userKey}:${sessionId}`).request_count, 0);
  db.prepare('UPDATE ai_rate_limits SET request_count=? WHERE bucket_key=?').run(record.until, `voice-active:${userKey}`);
  entry.state.storage.transaction = originalTransaction;
  await entry.object.alarm();
  assert.equal(db.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`).request_count, record.until);
});
test('an early explicit-close failure retries after fifteen seconds instead of waiting for selected deadline', async t => {
  const { userKey } = await setup(); const calls = mockProvider(t, 'live_early_retry');
  const response = await createVoiceSession(post(input)); assert.equal(response.status, 200);
  const { sessionId } = await response.json(), entry = env.VOICE_DEADLINES.entries.get(`${userKey}:${sessionId}`);
  const record = await entry.state.storage.get('session'), goodFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const now = Date.now(), oldNow = Date.now; t.after(() => { Date.now = oldNow; }); Date.now = () => now;
  assert.equal((await closeVoiceSession(post({ sessionId }))).status, 503);
  assert.equal(entry.state.storage.alarm, now + 15_000);
  assert.equal((await entry.state.storage.get('session')).closing, true);
  Date.now = () => now + 15_000; assert.ok(Date.now() < record.until - 60_000);
  globalThis.fetch = goodFetch;
  await env.VOICE_DEADLINES.restart(`${userKey}:${sessionId}`).object.alarm();
  assert.equal(calls.length, 2, 'server retries before original deadline without browser participation');
  assert.deepEqual(await entry.state.storage.get('session'), { closed: true });
});
