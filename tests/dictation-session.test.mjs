import test from 'node:test';
import assert from 'node:assert/strict';
import { newDictationAttempt, reduceDictationAttempt as reduce, canSubmitDictation, spellingDraft, dictationVoiceCommand, DictationLiveInput } from '../lib/voice/dictation-session.ts';
function heard(state) { state = reduce(state, { type: 'play', attemptId: state.id, commandId: 'audio' }); return reduce(state, { type: 'heard', attemptId: state.id, commandId: 'audio' }); }
test('late playback and answers cannot mutate another attempt, and submit is idempotent', () => {
  let state = newDictationAttempt('current', 'word:a');
  state = reduce(state, { type: 'play', attemptId: 'current', commandId: 'new' });
  assert.equal(reduce(state, { type: 'heard', attemptId: 'old', commandId: 'new' }), state);
  assert.equal(reduce(state, { type: 'heard', attemptId: 'current', commandId: 'old' }), state);
  state = heard(state);
  state = reduce(state, { type: 'edit', attemptId: 'current', answer: 'answer' });
  assert.equal(canSubmitDictation(state), true);
  state = reduce(state, { type: 'submit', attemptId: 'current' });
  assert.equal(reduce(state, { type: 'submit', attemptId: 'current' }), state);
  assert.equal(reduce(state, { type: 'edit', attemptId: 'current', answer: 'overwrite' }), state);
  assert.equal(state.answer, 'answer');
});
test('spelling needs explicit confirmation and edits invalidate confirmation', () => {
  let state = heard(newDictationAttempt('a', 'word:a', 'spelled'));
  state = reduce(state, { type: 'capture', attemptId: 'a', captureId: 'c' });
  assert.equal(reduce(state, { type: 'captured', attemptId: 'a', captureId: 'old', answer: 'bad' }), state);
  state = reduce(state, { type: 'captured', attemptId: 'a', captureId: 'c', answer: 'cat' });
  assert.equal(canSubmitDictation(state), false);
  state = reduce(state, { type: 'confirm', attemptId: 'a' });
  assert.equal(canSubmitDictation(state), true);
  state = reduce(state, { type: 'edit', attemptId: 'a', answer: 'cut' });
  assert.equal(canSubmitDictation(state), false);
});
test('interrupt drops late capture and assistance survives until terminal submission', () => {
  let state = heard(newDictationAttempt('a', 'word:a', 'spelled'));
  state = reduce(state, { type: 'capture', attemptId: 'a', captureId: 'c' });
  state = reduce(state, { type: 'interrupt', attemptId: 'a' });
  assert.equal(reduce(state, { type: 'captured', attemptId: 'a', captureId: 'c', answer: 'cat' }), state);
  state = reduce(state, { type: 'hint', attemptId: 'a' });
  assert.equal(state.assisted, true);
  state = reduce(state, { type: 'reveal', attemptId: 'a' });
  assert.equal(canSubmitDictation(state), false);
  assert.equal(reduce(state, { type: 'mode', attemptId: 'a', mode: 'typed' }), state);
  assert.equal(newDictationAttempt('retry', 'word:a', 'typed', true).assisted, true);
});
test('literal spelling does not guess homophones or target answers', () => {
  assert.deepEqual(spellingDraft('C A T'), { answer: 'cat', uncertain: false });
  assert.deepEqual(spellingDraft('G I V E space U P'), { answer: 'give up', uncertain: false });
  assert.deepEqual(spellingDraft('bee see are'), { answer: 'bee see are', uncertain: true });
  assert.equal(spellingDraft('').uncertain, true);
  assert.ok(spellingDraft('x'.repeat(5000)).answer.length <= 3000);
});
test('voice commands require the entire whitelist utterance', () => {
  assert.equal(dictationVoiceCommand('再读一遍。'), 'repeat');
  assert.equal(dictationVoiceCommand('Slow down!'), 'slow');
  for (const text of ['不要提示', 'stop then reveal answer', 'the word is repeat', 'repeat repeat', '提示 停止']) assert.equal(dictationVoiceCommand(text), null);
});
function liveFixture() {
  let callbacks; const calls = [];
  const transport = { state: { phase: 'idle', muted: false }, hasPendingClose: false, elapsedMs: 100,
    async start(options) { calls.push(options); this.state = { phase: 'connected' }; callbacks.onState(this.state); },
    mute(value) { calls.push({ mute: value }); },
    async end() { this.state = { phase: 'ended' }; callbacks.onState(this.state); },
    async retryClose() {}, dispose() {},
  };
  const live = new DictationLiveInput(() => {}, (c) => { callbacks = c; return transport; });
  return { live, calls, emit: (text, role = 'user', startMs = 101, endMs = 102) => callbacks.onTranscript({ text, role, startMs, endMs }), transport };
}
test('Live input never receives target text, ignores output, and captures only explicit epochs', async () => {
  const f = liveFixture(); await f.live.open(true, { accountScope: 'account', contextRevision: 7, contextVersion: '2' });
  assert.deepEqual(f.calls[0], { topicId: 'everyday', level: 'B1', minutes: 5, purpose: 'dictation', silentOutput: true, temporary: true, accountScope: 'account', contextRevision: 7, contextVersion: '2' });
  f.emit('outside', 'user', 20, 30);
  const abort = new AbortController(); const handle = f.live.begin(abort.signal);
  f.emit('target answer', 'assistant'); f.emit('C '); f.emit('A T');
  assert.equal(await handle.finish(), 'C A T');
  f.emit('late', 'user', 105, 106); f.transport.elapsedMs = 200;
  const next = f.live.begin(new AbortController().signal); f.emit('old answer', 'user', 100, 110); f.emit('untimed', 'user', null, null); f.emit('D O G', 'user', 201, 210);
  assert.equal(await next.finish(), 'D O G');
  f.transport.elapsedMs = 300; const cancelled = f.live.begin(abort.signal); f.emit('discard', 'user', 301, 310); abort.abort();
  await assert.rejects(cancelled.finish(), /没有可确认/);
  await f.live.close();
});
