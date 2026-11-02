import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { NativeLiveSession } from '../lib/voice/client.ts';
import { prepareLiveDictation, parseLiveDictationArguments, PREPARE_DICTATION_TOOL } from '../lib/voice/live-learning-tools.ts';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { memoryMetadata } from '../lib/learning-memory/context.ts';

const options = { topicId: 'everyday', level: 'B1', minutes: 5, accountScope: 'owner-scope', contextRevision: 3, contextVersion: 'config-v1', temporary: false };
const plan = { items: [{ id: 'word:one', mode: 'words', text: 'book', hint: '书', source: '必修1 Unit 1' }], reason: '已准备一组听写。', clarification: '', ...options };
const pause = () => new Promise(resolve => setImmediate(resolve));
function fixture(toolFetch) {
  const sent = [], plans = [], requests = [];
  const track = { enabled: true, stop() {} }, stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: 'open', send(v) { sent.push(JSON.parse(v)); }, close() { this.readyState = 'closed'; } };
  const peer = { iceGatheringState: 'complete', localDescription: { sdp: 'offer' }, createDataChannel: () => channel, addTrack() {}, createOffer: async () => ({}), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {} };
  const client = new NativeLiveSession({ onState() {}, onTranscript() {}, onDictationPlan: result => plans.push(result) }, {
    getUserMedia: async () => stream, createPeer: () => peer, createAudio: () => ({ setAttribute() {}, pause() {}, play: async () => {} }),
    fetch: async (url, init) => { requests.push({ url, init }); return url.endsWith('/session') ? Response.json({ sessionId: 'live_tool_test', sdp: 'answer', maxSeconds: 300 }) : url.endsWith('/learning-tool') ? toolFetch(init) : Response.json({ ok: true }); },
  });
  const emit = event => channel.onmessage?.({ data: JSON.stringify(event) });
  const response = event => emit({ type: 'response.event', delegation_id: 'delegation_1', event });
  const call = (id = 'call_1', args = { query: 'book', count: 3, mode: 'words' }) => response({ type: 'response.output_item.done', response_id: 'response_1', item: { type: 'function_call', call_id: id, name: 'prepare_dictation', arguments: JSON.stringify(args) } });
  return { client, sent, plans, requests, emit, response, call };
}

test('Live tool sends exact call output, continues only after all calls settle, and keeps answers out of backend result', async () => {
  let finishFirst, finishSecond;
  const f = fixture(() => new Promise(resolve => { if (!finishFirst) finishFirst = resolve; else finishSecond = resolve; }));
  try {
    await f.client.start(options); f.emit({ type: 'session.started' });
    f.response({ type: 'response.created', response: { id: 'response_1' } });
    f.call(); f.call(); f.call('call_2');
    f.response({ type: 'response.completed', response: { id: 'response_1', output: [] } });
    assert.equal(f.requests.filter(r => r.url.endsWith('learning-tool')).length, 2, 'duplicate call executes once');
    finishFirst(Response.json(plan)); await pause(); await pause();
    assert.equal(f.sent.filter(e => e.type === 'response.create').length, 0);
    finishSecond(Response.json(plan)); await pause(); await pause();
    const outputs = f.sent.filter(e => e.type === 'response.item.create');
    assert.deepEqual(outputs.map(e => e.item.call_id), ['call_1', 'call_2']);
    assert.equal(f.sent.filter(e => e.type === 'response.create').length, 1);
    assert.ok(outputs.every(e => !e.item.output.includes('book') && !e.item.output.includes('word:one')));
    assert.equal(f.plans[0].items[0].text, 'book');
    const body = JSON.parse(f.requests.find(r => r.url.endsWith('learning-tool')).init.body);
    assert.equal(body.accountScope, options.accountScope); assert.equal(body.contextVersion, options.contextVersion);
    f.response({ type: 'response.completed', response: { id: 'response_1' } });
    assert.equal(f.sent.filter(e => e.type === 'response.create').length, 1);
  } finally { f.client.dispose(); }
});

test('new speech cancels a pending recommendation, and late old context never reaches UI', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    await f.client.start(options); f.emit({ type: 'session.started' }); f.call();
    f.emit({ type: 'session.input_transcript.delta', delta: 'No, unit two.' });
    finish(Response.json(plan)); await pause(); await pause();
    assert.deepEqual(f.plans, []);
    const output = f.sent.find(e => e.type === 'response.item.create');
    assert.equal(JSON.parse(output.item.output).status, 'cancelled');
  } finally { f.client.dispose(); }
});

test('dictation capture session has no learning tools and mismatched context is discarded', async () => {
  const f = fixture(async () => Response.json({ ...plan, accountScope: 'different-owner' }));
  try {
    await f.client.start(options); f.emit({ type: 'session.started' }); f.call(); await pause(); await pause();
    assert.deepEqual(f.plans, []); assert.equal(JSON.parse(f.sent.find(e => e.type === 'response.item.create').item.output).status, 'unavailable');
  } finally { f.client.dispose(); }
  const silent = fixture(async () => { throw Error('must not run'); });
  try {
    await silent.client.start({ ...options, purpose: 'dictation' }); silent.emit({ type: 'session.started' }); silent.call(); await pause();
    assert.equal(silent.requests.filter(r => r.url.endsWith('learning-tool')).length, 0);
  } finally { silent.client.dispose(); }
});

test('learning tool only searches actual assets for the active authenticated account without a paid model request', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  env.DB = sqliteD1(db); requestHeaders.set('oai-authenticated-user-email', 'live-tool@example.test');
  const user = await authenticatedUserKey(), metadata = await memoryMetadata(user);
  const row = { id: 'word-book', headword: 'book', chineseCore: '书', sources: [{ bookId: 'required1', volume: '必修1', unit: 'Unit 1' }], flags: { formalReleaseEligible: true } };
  const originalAssets = env.ASSETS; env.ASSETS = { fetch: async req => Response.json(new URL(req.url).pathname === '/readings/v1/index.json' ? JSON.parse(readFileSync(new URL('../public/readings/v1/index.json', import.meta.url), 'utf8')) : [row]) }; t.after(() => { env.ASSETS = originalAssets; });
  db.prepare('INSERT INTO ai_rate_limits VALUES (?, ?, ?)').run(`voice-session:${user}:live_own`, Date.now() + 300000, Date.now() + 400000);
  const body = { name: 'prepare_dictation', callId: 'call_1', sessionId: 'live_own', arguments: { query: 'book', count: 3, mode: 'words' }, accountScope: metadata.accountScope, contextRevision: metadata.revision, contextVersion: metadata.contextVersion, temporary: false };
  const req = (value, headers = {}) => new Request('https://app.test/api/voice/learning-tool', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await prepareLiveDictation(req(body, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await prepareLiveDictation(req({ ...body, sessionId: 'live_other' }))).status, 409);
  assert.equal((await prepareLiveDictation(req({ ...body, accountScope: 'wrong' }))).status, 409);
  const response = await prepareLiveDictation(req(body)); assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json(); assert.deepEqual(result.items.map(i => i.text), ['book']); assert.equal(result.accountScope, metadata.accountScope);
  assert.equal((await prepareLiveDictation(req({ ...body, arguments: { query: 'not-in-release', count: 3, mode: 'words' } }))).status, 200);
  assert.throws(() => parseLiveDictationArguments({ query: '', count: 3, mode: 'words' }));
  assert.throws(() => parseLiveDictationArguments({ query: 'book', count: 50, mode: 'words' }));
  assert.equal(PREPARE_DICTATION_TOOL.strict, true);
});

test('a correction before an older delegated call starts prevents lookup, and closed sessions discard late results', async () => {
  const old = fixture(async () => { throw Error('stale call must not fetch'); });
  try {
    await old.client.start(options); old.emit({ type: 'session.started' });
    old.emit({ type: 'session.delegation.created', delegation: { id: 'delegation_1', target: 'responses' } });
    old.emit({ type: 'session.input_transcript.delta', delta: 'Actually book two.' });
    old.call(); await pause();
    assert.equal(old.requests.filter(r => r.url.endsWith('learning-tool')).length, 0);
    assert.equal(JSON.parse(old.sent.find(e => e.type === 'response.item.create').item.output).status, 'cancelled');
  } finally { old.client.dispose(); }
  let finish;
  const closed = fixture(() => new Promise(resolve => { finish = resolve; }));
  await closed.client.start(options); closed.emit({ type: 'session.started' }); closed.call();
  closed.client.dispose(); const sentBeforeLateResult = closed.sent.length;
  finish(Response.json(plan)); await pause(); await pause();
  assert.deepEqual(closed.plans, []); assert.equal(closed.sent.length, sentBeforeLateResult);
});
