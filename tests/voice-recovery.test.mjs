import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { deadlineNamespace } from './voice-deadline-env.mjs';
import { createVoiceSession, closeVoiceSession, voiceStatus, reserveVoiceSeconds } from '../lib/voice/server.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { VOICE_TOPICS } from '../lib/voice/curriculum.ts';

const GRACE = 3_600_000;
const key = 'offline-recovery-test-key-never-a-real-credential';
const request = body => new Request('https://app.test/api/voice/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
const input = () => ({ topicId: VOICE_TOPICS[0].id, level: 'B1', minutes: 5, diagnostic: true, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' });
async function setup(t) {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  env.DB = sqliteD1(db); env.VOICE_DEADLINES = deadlineNamespace(env);
  env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'voice-recovery@example.test');
  const { POST } = await import('../app/api/ai/config/route.ts');
  assert.equal((await POST(request({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: key, timeoutSeconds: 25, dailyLimit: 100, dailyTokenBudget: 200000 }))).status, 200);
  const now = Date.now(), realNow = Date.now, realFetch = globalThis.fetch;
  let time = now, creates = 0, closes = 0, closeStatus = 404;
  Date.now = () => time;
  globalThis.fetch = async url => {
    if (url.endsWith('/attach')) { closes++; return new Response(null, { status: closeStatus }); }
    return Response.json({ session: { id: `live_recovery_${++creates}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
  };
  t.after(() => { Date.now = realNow; globalThis.fetch = realFetch; });
  const userKey = await authenticatedUserKey();
  return { db, userKey, now, setTime: value => { time = value; }, setCloseStatus: value => { closeStatus = value; }, counts: () => ({ creates, closes }) };
}
const activeRow = ({ db, userKey }) => db.prepare('SELECT * FROM ai_rate_limits WHERE bucket_key=?').get(`voice-active:${userKey}`);
const sessionRow = ({ db, userKey }, id) => db.prepare('SELECT * FROM ai_rate_limits WHERE bucket_key=?').get(`voice-session:${userKey}:${id}`);
async function create(t) {
  const state = await setup(t), response = await createVoiceSession(request(input()));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  return { ...state, id: body.sessionId, entry: env.VOICE_DEADLINES.entries.get(`${state.userKey}:${body.sessionId}`) };
}

test('a: failed arm and direct close cannot strand a lease without ownership beyond its bounded grace', async t => {
  const state = await setup(t); state.setCloseStatus(503);
  const ns = env.VOICE_DEADLINES, get = ns.get;
  ns.get = name => ({ fetch(url, init) { return url.endsWith('/arm') ? Promise.resolve(new Response(null, { status: 503 })) : get(name).fetch(url, init); } });
  assert.equal((await createVoiceSession(request(input()))).status, 503);
  const until = activeRow(state).request_count;
  assert.equal(sessionRow(state, 'live_recovery_1'), undefined);
  assert.equal((await closeVoiceSession(request({ sessionId: 'live_recovery_1' }))).status, 404);
  state.setTime(until + GRACE - 1);
  assert.equal((await createVoiceSession(request(input()))).status, 409);
  ns.get = get; state.setCloseStatus(404); state.setTime(until + GRACE);
  assert.equal((await createVoiceSession(request(input()))).status, 200);
  assert.ok(activeRow(state).expires_at < Number.MAX_SAFE_INTEGER);
});

test('b: an interrupted claim and deployed MAX-expiry row block before grace and recycle exactly at its deadline', async t => {
  const state = await setup(t), until = state.now + 120_000;
  state.db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(`voice-active:${state.userKey}`, until, Number.MAX_SAFE_INTEGER);
  state.db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(`voice-session:${state.userKey}:live_legacy_max`, until, Number.MAX_SAFE_INTEGER);
  state.setTime(until + GRACE - 1);
  assert.equal((await createVoiceSession(request(input()))).status, 409);
  state.setTime(until + GRACE);
  const status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.activeSession, null);
  assert.equal((await createVoiceSession(request(input()))).status, 200);
  assert.equal(state.counts().creates, 1);
});

for (const status of [401, 403, 410]) test(`c: irrecoverable provider ${status} erases credentials, terminates retries and restores normal expiry`, async t => {
  const state = await create(t); state.setCloseStatus(status);
  const response = await closeVoiceSession(request({ sessionId: state.id }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(); assert.equal(body.terminal, true); assert.equal(body.confirmed, false);
  assert.equal(activeRow(state).request_count, 0);
  assert.equal(sessionRow(state, state.id).request_count, 0);
  assert.ok(activeRow(state).expires_at <= Date.now() + 86_400_000);
  const terminal = await state.entry.state.storage.get('session');
  assert.equal(terminal.closed, true); assert.equal('credential' in terminal, false);
  assert.equal(state.entry.state.storage.alarm, null);
  const calls = state.counts().closes;
  await state.entry.object.alarm(); await closeVoiceSession(request({ sessionId: state.id }));
  assert.equal(state.counts().closes, calls);
});

test('c: undecryptable stored credentials are terminal without any provider close request', async t => {
  const state = await create(t), record = await state.entry.state.storage.get('session');
  await state.entry.state.storage.put('session', { ...record, credential: { ...record.credential, encryptedApiKey: 'invalid-ciphertext' } });
  const response = await closeVoiceSession(request({ sessionId: state.id }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).confirmed, false);
  assert.equal(state.counts().closes, 0);
  assert.equal(activeRow(state).request_count, 0);
  assert.equal('credential' in await state.entry.state.storage.get('session'), false);
  assert.equal(state.entry.state.storage.alarm, null);
});

test('bounded backoff stops provider attempts and erases credentials while uncertain lease waits for grace', async t => {
  const state = await create(t); state.setCloseStatus(503);
  const until = activeRow(state).request_count;
  state.setTime(until - 60_000);
  let previousDelay = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    await state.entry.object.alarm().catch(() => undefined);
    const stored = await state.entry.state.storage.get('session');
    if (!('credential' in stored)) break;
    const alarm = state.entry.state.storage.alarm, delay = alarm - Date.now();
    assert.ok(delay >= previousDelay); assert.ok(delay <= 300_000);
    previousDelay = delay; state.setTime(alarm);
  }
  assert.ok(state.counts().closes <= 8);
  assert.equal('credential' in await state.entry.state.storage.get('session'), false);
  assert.equal(activeRow(state).request_count, until, 'retry exhaustion cannot admit a concurrent unconfirmed call before grace');
  state.setTime(until + GRACE - 1);
  assert.equal((await createVoiceSession(request(input()))).status, 409);
  state.setTime(until + GRACE);
  const calls = state.counts().closes;
  await state.entry.object.alarm();
  assert.equal(state.counts().closes, calls);
  assert.equal(activeRow(state).request_count, 0);
  assert.equal(state.entry.state.storage.alarm, null);
});

test('manual close obeys persisted retry backoff instead of spending the provider budget on repeated clicks', async t => {
  const state = await create(t); state.setCloseStatus(429);
  assert.equal((await closeVoiceSession(request({ sessionId: state.id }))).status, 503);
  for (let click = 0; click < 5; click++) assert.equal((await closeVoiceSession(request({ sessionId: state.id }))).status, 503);
  assert.equal(state.counts().closes, 1);
  const alarm = state.entry.state.storage.alarm;
  state.setTime(alarm);
  assert.equal((await closeVoiceSession(request({ sessionId: state.id }))).status, 503);
  assert.equal(state.counts().closes, 2);
  assert.equal(state.entry.state.storage.alarm - Date.now(), 30_000);
});

test('terminalization removes old credentials before failing D1 cleanup and never retries the rejected provider key', async t => {
  const state = await create(t); state.setCloseStatus(401);
  const batch = env.DB.batch;
  env.DB.batch = async () => { throw new Error('temporary D1 outage'); };
  assert.equal((await closeVoiceSession(request({ sessionId: state.id }))).status, 503);
  const pending = await state.entry.state.storage.get('session');
  assert.equal(pending.finalizing, true); assert.equal('credential' in pending, false);
  assert.equal(state.counts().closes, 1);
  assert.equal(activeRow(state).request_count, pending.until);
  env.DB.batch = batch;
  state.setTime(state.entry.state.storage.alarm);
  await env.VOICE_DEADLINES.restart(`${state.userKey}:${state.id}`).object.alarm();
  assert.equal(state.counts().closes, 1);
  assert.equal(activeRow(state).request_count, 0);
  assert.equal(state.entry.state.storage.alarm, null);
  assert.equal('credential' in await state.entry.state.storage.get('session'), false);
});

test('status reports an orphan admission lease as recovering until the exact grace cutoff', async t => {
  const state = await setup(t), until = state.now + 80_000;
  state.db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(`voice-active:${state.userKey}`, until, Number.MAX_SAFE_INTEGER);
  let status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.ready, false); assert.equal(status.reasonCode, 'voice_session_active');
  assert.equal(status.activeSession, null); assert.equal(status.recoveryAt, new Date(until + GRACE).toISOString());
  state.setTime(until + GRACE);
  status = await (await voiceStatus(new Request('https://app.test/api/voice/status'))).json();
  assert.equal(status.ready, true); assert.equal(status.recoveryAt, null);
});

for (const mode of ['malformed-success', 'network-failure', 503, 408]) test(`ambiguous creation ${mode} retains admission without a known ID until bounded recovery`, async t => {
  const state = await setup(t), provider = globalThis.fetch;
  globalThis.fetch = async () => {
    if (mode === 'malformed-success') return Response.json({ unexpected: true });
    if (mode === 'network-failure') throw new Error('connection ended before the response');
    return new Response(null, { status: mode });
  };
  const first = await createVoiceSession(request(input())); assert.notEqual(first.status, 200);
  const until = activeRow(state).request_count; assert.ok(until > Date.now());
  globalThis.fetch = provider;
  state.setTime(until + GRACE - 1);
  assert.equal((await createVoiceSession(request(input()))).status, 409);
  state.setTime(until + GRACE);
  assert.equal((await createVoiceSession(request(input()))).status, 200);
});

test('pre-provider admission failure and definitive provider rejection release the lease normally', async t => {
  const state = await setup(t), provider = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 400 });
  assert.notEqual((await createVoiceSession(request(input()))).status, 200);
  assert.equal(activeRow(state).request_count, 0);
  assert.ok(activeRow(state).expires_at <= Date.now() + 86_400_000);
  globalThis.fetch = provider;
  await reserveVoiceSeconds(state.userKey, 3580);
  assert.equal((await createVoiceSession(request(input()))).status, 429);
  assert.equal(activeRow(state).request_count, 0);
  assert.equal(state.counts().creates, 0);
});

test('a caller-aborted legacy close is not a provider rejection and cannot unlock its unconfirmed lease', async t => {
  const state = await create(t), provider = globalThis.fetch, controller = new AbortController();
  const until = activeRow(state).request_count;
  // The owned row exists, but an older session has no matching DO snapshot.
  env.VOICE_DEADLINES.get = () => ({ fetch: async () => new Response(null, { status: 404 }) });
  globalThis.fetch = async url => {
    assert.ok(url.endsWith('/attach'));
    controller.abort();
    throw new DOMException('Request aborted by its caller', 'AbortError');
  };
  const aborted = await closeVoiceSession(new Request(request({ sessionId: state.id }), { signal: controller.signal }));
  assert.equal(aborted.status, 499);
  assert.equal(activeRow(state).request_count, until);
  assert.equal(sessionRow(state, state.id).request_count, until);
  assert.ok(Date.now() < until + GRACE);
  globalThis.fetch = provider;
  assert.equal((await closeVoiceSession(request({ sessionId: state.id }))).status, 200);
  assert.equal(activeRow(state).request_count, 0);
});
