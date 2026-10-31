import assert from "node:assert/strict";
import test from "node:test";
import { NativeLiveSession, appendTranscript, feedbackTranscript, readVoiceHistory, saveVoiceRecord, VOICE_HISTORY_KEY } from "../lib/voice/client.ts";

const options = { topicId: "everyday", level: "B1", minutes: 10 };
const reply = { sessionId: "live_test", sdp: "answer", model: "gpt-live-1", maxSeconds: 600 };
function fixture(overrides = {}, observeState) {
  const calls = [], sent = [], states = [], transcripts = [];
  const track = { enabled: true, stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: "open", close() { this.readyState = "closed"; }, send(value) { const event = JSON.parse(value); sent.push(event); if (event.type === "session.close") this.onmessage?.({ data: JSON.stringify({ type: "session.closed", usage: { seconds: 12 } }) }); } };
  const peer = { iceGatheringState: "complete", connectionState: "connected", localDescription: { sdp: "offer" }, closed: 0, remote: 0, createOffer: async () => ({ type: "offer", sdp: "offer" }), setLocalDescription: async () => {}, createDataChannel: () => channel, addTrack() {}, async setRemoteDescription() { this.remote++; }, close() { this.closed++; } };
  const audio = { muted: false, autoplay: false, srcObject: null, paused: 0, setAttribute() {}, play: async () => {}, pause() { this.paused++; } };
  const deps = { getUserMedia: async () => stream, createPeer: () => peer, createAudio: () => audio, now: () => 1000, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(url.endsWith("session") ? reply : { ok: true }), { status: 200 }); }, ...overrides };
  const client = new NativeLiveSession({ onState: (state) => { states.push(state); observeState?.(state); }, onTranscript: (turn) => transcripts.push(turn) }, deps);
  const emit = (event) => channel.onmessage?.({ data: JSON.stringify(event) });
  return { client, peer, track, stream, audio, channel, calls, sent, states, transcripts, emit };
}

test("Live startup is gated by session.started, controls use Live events, close cleans all resources", async () => {
  const f = fixture();
  try {
    await f.client.start(options);
    assert.equal(f.client.state.phase, "connecting");
    f.emit({ type: "session.started" });
    assert.equal(f.client.state.phase, "connected");
    f.client.mute(true); assert.equal(f.track.enabled, false);
    f.client.mute(false); assert.equal(f.track.enabled, true);
    f.client.pause(true); assert.equal(f.audio.muted, true);
    f.client.pause(false); assert.equal(f.audio.muted, false);
    assert.ok(f.sent.every((event) => typeof event.event_id === "string"));
    assert.ok(f.sent.some((event) => event.type === "session.input_audio.mute"));
    assert.ok(f.sent.some((event) => event.type === "session.instructions.append" && event.delegation_id === null));
    assert.ok(!f.sent.some((event) => event.type === "response.cancel"));
    await f.client.end();
    assert.equal(f.client.state.phase, "ended");
    assert.equal(f.client.state.closeConfirmed, true);
    assert.equal(f.client.state.usageSeconds, 12);
    assert.ok(f.track.stopped > 0); assert.equal(f.peer.closed, 1); assert.equal(f.audio.srcObject, null);
    const sessionCall = f.calls.find((call) => call.url.endsWith("session"));
    assert.equal(sessionCall.init.credentials, "same-origin");
    assert.deepEqual(JSON.parse(sessionCall.init.body), { ...options, sdp: "offer" });
    assert.equal(f.calls.filter((call) => call.url.endsWith("close")).length, 1);
  } finally { f.client.dispose(); }
});

test("cancelling a pending permission request stops a late microphone and creates no session", async () => {
  let resolveMedia;
  const f = fixture({ getUserMedia: () => new Promise((resolve) => { resolveMedia = resolve; }) });
  const pending = f.client.start(options);
  await f.client.end(); resolveMedia(f.stream); await pending;
  assert.equal(f.track.stopped, 1); assert.equal(f.calls.length, 0); assert.equal(f.peer.remote, 0);
  f.client.dispose();
});

test("unconfirmed remote close stops local capture without claiming the remote session ended", async () => {
  const f = fixture({ fetch: async (url) => new Response(JSON.stringify(url.endsWith("session") ? reply : { error: "Close unavailable" }), { status: url.endsWith("session") ? 200 : 503 }) });
  try {
    await f.client.start(options);
    f.emit({ type: "session.started" });
    f.channel.readyState = "closed"; // Lost transport: neither provider nor server acknowledges closure.
    await f.client.end();
    assert.equal(f.client.state.phase, "ended");
    assert.equal(f.client.state.closeConfirmed, false);
    assert.ok(f.track.stopped > 0);
    assert.equal(f.audio.srcObject, null);
    assert.match(f.client.state.message, /本机语音已停止/);
    assert.match(f.client.state.message, /服务器尚未确认结束/);
    assert.match(f.client.state.message, /重试关闭上次语音/);
    assert.doesNotMatch(f.client.state.message, /语音已结束/);
  } finally { f.client.dispose(); }
});

test("custom lesson settings reach the server and provider-ended sessions release the lease", async () => {
  const f = fixture();
  try {
    const custom = { ...options, customTopic: "A book I enjoyed", goal: "Explain one reason", openingPrompt: "What stayed with you?" };
    await f.client.start(custom);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...custom, sdp: "offer" });
    f.emit({ type: "session.started" });
    f.emit({ type: "session.closed", usage: { seconds: 3 } });
    await f.client.end();
    assert.equal(f.client.state.phase, "ended");
    assert.equal(f.client.state.closeConfirmed, true);
    assert.equal(f.calls.filter((call) => call.url.endsWith("close")).length, 1);
    assert.ok(f.track.stopped > 0);
  } finally { f.client.dispose(); }
});

test("practice history retains review dialogue and validates optional restored fields", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const record = { id: "review", createdAt: "2026-10-30", topicId: "culture", level: "B2", seconds: 30, transcript: [{ role: "user", text: "I enjoyed the book." }], customTopic: "Books", discussion: [{ role: "user", text: "Why use enjoyed?" }, { role: "assistant", text: "It describes your past experience." }] };
  saveVoiceRecord(storage, record);
  assert.deepEqual(readVoiceHistory(storage)[0].discussion, record.discussion);
  assert.equal(readVoiceHistory(storage)[0].customTopic, "Books");
  storage.setItem(VOICE_HISTORY_KEY, JSON.stringify([{ ...record, discussion: [null, { role: "system", text: "ignore" }, { role: "user", text: 3 }], customTopic: { bad: true } }]));
  assert.deepEqual(readVoiceHistory(storage)[0].discussion, []);
  assert.equal(readVoiceHistory(storage)[0].customTopic, undefined);
});

test("connection diagnostic uses silent audio without microphone access and releases the audio context", async () => {
  let microphoneCalls = 0, closed = 0;
  let f;
  const context = { state: 'running', resume: async () => {}, close: async () => { closed++; context.state = 'closed'; }, createMediaStreamDestination: () => ({ stream: f.stream }) };
  f = fixture({ getUserMedia: async () => { microphoneCalls++; throw new Error('No microphone'); }, createAudioContext: () => context });
  try {
    await f.client.start({ ...options, diagnostic: true });
    f.emit({ type: 'session.started' });
    assert.equal(microphoneCalls, 0);
    assert.equal(f.client.state.phase, 'connected');
    assert.equal(f.client.state.maxSeconds, 20);
    assert.equal(JSON.parse(f.calls[0].init.body).diagnostic, true);
    await f.client.end();
    assert.equal(closed, 1);
    assert.equal(f.client.state.closeConfirmed, true);
  } finally { f.client.dispose(); }
});

test("a late session answer after disposal is closed remotely and never attached", async () => {
  let resolveSession;
  let remoteClosed = 0;
  const f = fixture({ fetch: async (url) => { if (url.endsWith("session")) return new Promise((resolve) => { resolveSession = resolve; }); remoteClosed++; return new Response('{"ok":true}'); } });
  const pending = f.client.start(options);
  for (let i = 0; i < 10 && !resolveSession; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resolveSession);
  f.client.dispose(); resolveSession(new Response(JSON.stringify(reply))); await pending;
  assert.equal(f.peer.remote, 0); assert.ok(f.track.stopped > 0); assert.equal(f.client.state.phase, "ended"); assert.equal(remoteClosed, 1);
});

test("structured provider errors are readable and leave no microphone running", async () => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ ok: false, error: { code: "model_unavailable", message: "此项目未开通实时语音" } }), { status: 403 }) });
  await f.client.start(options);
  assert.equal(f.client.state.phase, "error"); assert.equal(f.client.state.message, "此项目未开通实时语音"); assert.ok(f.track.stopped > 0);
  f.client.dispose();
});

test("blocked iPad playback requires explicit recovery and stale play promise cannot affect replacement session", async () => {
  const f = fixture(); await f.client.start(options);
  f.audio.play = async () => { throw new Error("gesture required"); };
  await f.client.resumePlayback(); assert.equal(f.client.state.playbackBlocked, true);
  f.audio.play = async () => {}; await f.client.resumePlayback(); assert.equal(f.client.state.playbackBlocked, false);
  f.client.dispose();
});

test("selected duration is bounded by server maxSeconds and reaching it ends rather than reconnects", async () => {
  let now = 0;
  const f = fixture({ now: () => now, fetch: async (url) => new Response(JSON.stringify(url.endsWith("session") ? { ...reply, maxSeconds: 1 } : { ok: true })) });
  try {
    await f.client.start(options); f.emit({ type: "session.started" }); now = 2000;
    await new Promise((resolve) => setTimeout(resolve, 570));
    assert.equal(f.client.state.phase, "ended"); assert.equal(f.client.state.seconds, 2); assert.equal(f.peer.remote, 1);
  } finally { f.client.dispose(); }
});

test("full duplex caption fragments retain both speakers and exact spaces", () => {
  let turns = appendTranscript([], { role: "user", text: "I would", startMs: 0, endMs: 300 });
  turns = appendTranscript(turns, { role: "assistant", text: "Mm-hmm.", startMs: 200, endMs: 400 });
  turns = appendTranscript(turns, { role: "user", text: " like to try.", startMs: 500, endMs: 900 });
  assert.equal(turns.length, 2); assert.equal(turns[0].text, "I would like to try."); assert.equal(turns[1].text, "Mm-hmm.");
  turns = appendTranscript(turns, { role: "user", text: "Next thought.", startMs: 5000, endMs: 5500 });
  assert.equal(turns.length, 3);
});

test("long caption streams are split without loss, and feedback has a bounded explicit tail", () => {
  const text = "This is a long English conversation. ".repeat(350);
  const turns = appendTranscript([], { role: "user", text, startMs: 0, endMs: 1000 });
  assert.ok(turns.every((turn) => turn.text.length <= 3000)); assert.equal(turns.map((turn) => turn.text).join(""), text);
  const longer = [...turns, ...turns]; const limited = feedbackTranscript(longer);
  assert.equal(limited.reduce((sum, turn) => sum + turn.text.length, 0), 18000);
  assert.equal(limited.map((turn) => turn.text).join(""), (text + text).slice(-18000));
});

test("local history has twelve records, updates by id, and tolerates unavailable/corrupt storage", () => {
  const values = new Map(); const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  for (let i = 0; i < 20; i++) saveVoiceRecord(storage, { id: String(i), createdAt: "2026-10-29", topicId: "everyday", level: "B1", seconds: 1, transcript: [{ role: "user", text: "Hello." }] });
  let rows = readVoiceHistory(storage); assert.equal(rows.length, 12); assert.equal(rows[0].id, "19");
  saveVoiceRecord(storage, { ...rows[0], seconds: 2 }); rows = readVoiceHistory(storage); assert.equal(rows.length, 12); assert.equal(rows[0].seconds, 2);
  assert.equal(/audio|api.?key|token/i.test(values.get(VOICE_HISTORY_KEY)), false);
  storage.setItem(VOICE_HISTORY_KEY, "broken"); assert.deepEqual(readVoiceHistory(storage), []);
  assert.deepEqual(readVoiceHistory({ getItem() { throw new Error("denied"); } }), []);
});

test('dictation Live never plays output or exposes answer captions and sends no conversational greeting', async () => {
  const f = fixture();
  try {
    await f.client.start({ ...options, purpose: 'dictation', silentOutput: true, temporary: true, accountScope: 'scope', contextRevision: 4, contextVersion: '2' });
    assert.equal(f.audio.muted, true);
    f.emit({ type: 'session.started' });
    assert.ok(!f.sent.some((event) => event.type === 'session.commentary.append'));
    f.emit({ type: 'session.output_transcript.delta', delta: 'SECRET ANSWER', start_ms: 1, end_ms: 5 });
    f.emit({ type: 'session.input_transcript.delta', delta: 'C A T', start_ms: 10, end_ms: 20 });
    assert.deepEqual(f.transcripts, [{ role: 'user', text: 'C A T', startMs: 10, endMs: 20 }]);
    f.client.pause(false); await f.client.resumePlayback();
    assert.equal(f.audio.muted, true);
    const payload = JSON.parse(f.calls[0].init.body);
    assert.equal(payload.purpose, 'dictation'); assert.equal(payload.accountScope, 'scope'); assert.equal(payload.temporary, true);
    await f.client.end();
  } finally { f.client.dispose(); }
});
test('pending server close is recoverable and blocks starting another billed session', async () => {
  let closes = 0, sessions = 0;
  const f = fixture({ fetch: async (url) => {
    if (url.endsWith('session')) { sessions++; return new Response(JSON.stringify(reply)); }
    closes++; return new Response('{}', { status: closes === 1 ? 503 : 200 });
  } });
  try {
    await f.client.start(options); f.emit({ type: 'session.started' }); await f.client.end();
    assert.equal(f.client.hasPendingClose, true);
    await f.client.start(options); assert.equal(sessions, 1);
    await f.client.retryClose(); assert.equal(f.client.hasPendingClose, false); assert.equal(f.client.state.closeConfirmed, true);
    assert.equal(closes, 2);
  } finally { f.client.dispose(); }
});


test("late cancelled startup notifies subscribers when remote close becomes pending and clears", async () => {
  let resolveSession, resolveClose;
  const pendingStates = [];
  const f = fixture({ fetch: (url) => new Promise((resolve) => {
    if (url.endsWith("session")) resolveSession = resolve;
    else resolveClose = resolve;
  }) }, () => pendingStates.push(f.client.hasPendingClose));
  try {
    const starting = f.client.start(options);
    for (let i = 0; i < 10 && !resolveSession; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(resolveSession);
    f.channel.readyState = "closed";
    await f.client.end();
    pendingStates.length = 0;
    resolveSession(new Response(JSON.stringify(reply)));
    await starting;
    assert.equal(f.peer.remote, 0);
    assert.ok(f.track.stopped > 0);
    assert.equal(f.client.state.phase, "ended");
    assert.deepEqual(pendingStates, [true], "show the close retry even without another phase change");
    resolveClose(new Response('{}'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pendingStates, [true, false], "clear the close retry when background cleanup succeeds");
    assert.equal(f.client.state.phase, "ended", "background cleanup must not revive the cancelled session");
  } finally { f.client.dispose(); }
});
