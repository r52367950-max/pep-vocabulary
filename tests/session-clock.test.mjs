import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { advanceSession, restoreSession, sessionEventId } from '../lib/session.ts';
import { clearUserData, commitReview, loadLearningState } from '../lib/storage.ts';
import { scheduleReview } from '../lib/scheduler.ts';

const before = Date.parse('2026-10-02T12:00:00Z');
const after = before - 3_600_000;
const session = { id: 'clock-session', dataGeneration: 'test-generation', mode: 'daily',
  title: '学习', queue: ['apple', 'pear'], position: 0, startedAt: before, results: [], retries: {} };
const review = (state, now) => ({ ...scheduleReview({ stored: null,
  cardId: state.queue[state.position], rating: 3, retention: .9, skill: 'meaning',
  questionType: 'meaning-recall', correct: true, responseMs: 1000, hints: 0,
  errorType: null, now: new Date(now) }).event, eventId: sessionEventId(state) });
const recover = (state, events, now) => restoreSession(JSON.stringify(state), new Set(session.queue), events, now, state.dataGeneration);

test('a committed answer after clock rollback advances once and repairs the stale checkpoint', async () => {
  await clearUserData();
  const { generation } = await loadLearningState();
  const state = { ...session, dataGeneration: generation };
  const event = review(state, after);
  await commitReview(event, generation);
  const advanced = advanceSession(state, event);
  assert.equal(advanced.position, 1);
  assert.equal(advanced.startedAt, after);
  const recovered = recover(state, (await loadLearningState()).events, after + 1000);
  assert.equal(recovered.position, 1);
  assert.equal(recovered.results.length, 1);
  assert.deepEqual(recover(recovered, [event], before + 1000), recovered);
  assert.throws(() => advanceSession(advanced, event), /不一致/);
});

test('generation-bound checkpoints recover pre-rollback history while the wall clock remains behind', () => {
  const first = review(session, before + 1000);
  const advanced = advanceSession(session, first);
  assert.equal(recover(advanced, [first], after).position, 1);
  assert.equal(recover(session, [], after).position, 0);
  assert.equal(restoreSession(JSON.stringify(advanced), new Set(session.queue), [first], after, 'other-generation'), null);
  assert.equal(recover(advanced, [], after), null, 'a clock adjustment cannot invent missing history');
});

test('clock-tolerant progression still rejects foreign IDs, wrong positions and future revisions', () => {
  const event = review(session, after);
  for (const eventId of ['foreign:0:0', 'clock-session:1:0', 'clock-session:0:1', 'clock-session:0:00'])
    assert.throws(() => advanceSession(session, { ...event, eventId }), /不一致/);
  assert.throws(() => advanceSession(session, { ...event, timestampUtc: 'invalid' }), /不一致/);
  assert.throws(() => advanceSession(session, { ...event, cardId: 'pear' }), /不一致/);
  assert.equal(recover(session, [{ ...event, cardId: 'pear' }], after), null);
});

test('completion after a rollback and later undo retain coherent session timestamps', () => {
  const first = review(session, before + 1000);
  const state = advanceSession(session, first);
  const second = review(state, after);
  const done = advanceSession(state, second);
  assert.equal(done.finishedAt, after);
  assert.equal(done.startedAt, after);
  assert.equal(recover(done, [first, second], after + 1000), null, 'completed sessions stay completed');
  const undone = { ...second, eventId: 'undo-second', eventType: 'undo', targetEventId: second.eventId };
  const recovered = recover(done, [first, second, undone], after + 1000);
  assert.equal(recovered.position, 1);
  assert.equal(recovered.revision, 1);
});
