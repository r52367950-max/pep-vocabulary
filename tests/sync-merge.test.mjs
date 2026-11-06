import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { scheduleReview } from '../lib/scheduler.ts';
import { validateBackup } from '../lib/backup.ts';
import { mergeBackups, SyncMergeError } from '../lib/sync-merge.ts';
import { clearUserData, commitReview, exportBackup, LocalDataChangedError, loadLearningState, replaceMergedBackup, restoreBackup } from '../lib/storage.ts';

const start = Date.parse('2026-10-02T10:00:00.000Z');
const at = (minutes) => new Date(start + minutes * 60_000);
function review(stored, cardId, { rating = 3, minute = 0, eventId, answer = 'answer' } = {}) {
  return { ...scheduleReview({ stored, cardId, rating, now: at(minute), retention: 0.9, skill: 'spelling', questionType: 'spelling',
    correct: rating !== 1, responseMs: 1200 + minute, hints: 0, errorType: rating === 1 ? 'recall' : null, answerGiven: answer }).event, eventId };
}
const undo = (target, eventId, minute) => ({ ...structuredClone(target), eventType: 'undo', eventId, targetEventId: target.eventId,
  timestampUtc: at(minute).toISOString(), localDate: at(minute).toLocaleDateString('sv-SE') });
const snapshot = (events, cards, extra = {}) => ({ schemaVersion: '1.2.0', cards, events, lists: [], settings: [], writings: [], ...extra });
const evidenceOf = ({ eventId, cardId, timestampUtc, rating, correct, responseMs, answerGiven, questionType, skill, localDate, timezone }) =>
  ({ eventId, cardId, timestampUtc, rating, correct, responseMs, answerGiven, questionType, skill, localDate, timezone });
const byId = (payload, id) => payload.events.find((event) => event.eventId === id);
const card = (payload, id) => payload.cards.find((row) => row.id === id);

// Shared history: one answer for "apple", synced to both devices.
const shared = review(null, 'apple', { eventId: 'shared-1', minute: 0 });

test('answers for different words on each device are combined without rescheduling', () => {
  const local = review(null, 'banana', { eventId: 'local-1', minute: 5 });
  const cloud = review(shared.after, 'apple', { eventId: 'cloud-1', minute: 60 * 24 });
  const { payload, summary } = mergeBackups(snapshot([shared, local], [shared.after, local.after]), snapshot([shared, cloud], [cloud.after]));
  assert.deepEqual(summary, { localAnswers: 1, cloudAnswers: 1, rescheduledWords: 0, droppedUndos: 0 });
  assert.deepEqual(byId(payload, 'local-1'), local);
  assert.deepEqual(byId(payload, 'cloud-1'), cloud);
  assert.deepEqual(card(payload, 'apple'), cloud.after);
  assert.deepEqual(card(payload, 'banana'), local.after);
});

test('a word answered only on this device keeps its local history and schedule', () => {
  const next = review(shared.after, 'apple', { eventId: 'local-2', minute: 60 * 24 });
  const { payload, summary } = mergeBackups(snapshot([shared, next], [next.after]), snapshot([shared], [shared.after]));
  assert.equal(summary.rescheduledWords, 0);
  assert.deepEqual(card(payload, 'apple'), next.after);
  assert.deepEqual(byId(payload, 'local-2'), next);
});

test('a word answered on both devices keeps every answer and reschedules local ones after the cloud history', () => {
  const cloud = review(shared.after, 'apple', { eventId: 'cloud-2', minute: 60 * 24, rating: 4 });
  const local = review(shared.after, 'apple', { eventId: 'local-2', minute: 60 * 26, rating: 1, answer: 'aple' });
  const later = review(local.after, 'apple', { eventId: 'local-3', minute: 60 * 27, rating: 3 });
  const { payload, summary } = mergeBackups(snapshot([shared, later, local], [later.after]), snapshot([shared, cloud], [cloud.after]));
  assert.deepEqual(summary, { localAnswers: 2, cloudAnswers: 1, rescheduledWords: 1, droppedUndos: 0 });
  assert.deepEqual(byId(payload, 'cloud-2'), cloud, 'cloud history is kept as confirmed');
  const first = byId(payload, 'local-2'), second = byId(payload, 'local-3');
  assert.deepEqual(evidenceOf(first), evidenceOf(local), 'the recorded answer is unchanged');
  assert.deepEqual(evidenceOf(second), evidenceOf(later));
  assert.deepEqual(first.before, cloud.after, 'rescheduled from the cloud state');
  assert.deepEqual(second.before, first.after);
  assert.equal(second.after.fsrs.reps, cloud.after.fsrs.reps + 2);
  assert.deepEqual(card(payload, 'apple'), second.after);
  assert.equal(payload.events.length, 4);
  assert.doesNotThrow(() => validateBackup(payload));
});

test('local undo records are replayed with their answers; an undo of a synced answer is dropped when the cloud built on it', () => {
  const cloud = review(shared.after, 'apple', { eventId: 'cloud-2', minute: 60 * 24 });
  const mistaken = review(shared.after, 'apple', { eventId: 'local-2', minute: 60 * 25, rating: 1 });
  const undone = undo(mistaken, 'local-undo-2', 60 * 25 + 1);
  const retried = review(shared.after, 'apple', { eventId: 'local-3', minute: 60 * 25 + 2, rating: 3 });
  const merged = mergeBackups(snapshot([shared, mistaken, undone, retried], [retried.after]), snapshot([shared, cloud], [cloud.after]));
  assert.equal(merged.summary.localAnswers, 2);
  const replayedUndo = byId(merged.payload, 'local-undo-2');
  assert.equal(replayedUndo.eventType, 'undo');
  assert.deepEqual(replayedUndo.before, byId(merged.payload, 'local-2').before);
  assert.deepEqual(byId(merged.payload, 'local-3').before, cloud.after, 'the retry starts where the undo returned');

  const undoShared = undo(shared, 'local-undo-shared', 30);
  const dropped = mergeBackups(snapshot([shared, undoShared], []), snapshot([shared, cloud], [cloud.after]));
  assert.equal(dropped.summary.droppedUndos, 1);
  assert.equal(byId(dropped.payload, 'local-undo-shared'), undefined);
  assert.deepEqual(card(dropped.payload, 'apple'), cloud.after);
});

test('merging again after the cloud holds rescheduled copies adds nothing and needs no further rescheduling', () => {
  const cloud = review(shared.after, 'apple', { eventId: 'cloud-2', minute: 60 * 24 });
  const local = review(shared.after, 'apple', { eventId: 'local-2', minute: 60 * 26 });
  const localSnapshot = snapshot([shared, local], [local.after]);
  const first = mergeBackups(localSnapshot, snapshot([shared, cloud], [cloud.after])).payload;
  const again = mergeBackups(localSnapshot, first);
  assert.equal(again.payload.events.length, first.events.length);
  assert.deepEqual(card(again.payload, 'apple'), card(first, 'apple'));
  assert.deepEqual(again.summary, { localAnswers: 0, cloudAnswers: 1, rescheduledWords: 0, droppedUndos: 0 }, 'only the other device\'s answer is new here');
});

test('the same record ID with a different recorded answer is refused', () => {
  const local = review(shared.after, 'apple', { eventId: 'same-id', minute: 60, answer: 'apple' });
  const cloud = review(shared.after, 'apple', { eventId: 'same-id', minute: 60, answer: 'appel' });
  assert.throws(() => mergeBackups(snapshot([shared, local], [local.after]), snapshot([shared, cloud], [cloud.after])), SyncMergeError);
});

test('notes, favourites, pause, settings and writings follow the most recently updated side', () => {
  const cloud = review(shared.after, 'apple', { eventId: 'cloud-2', minute: 60 * 24 });
  const localCard = { ...shared.after, note: 'local note', favorite: true, status: 'paused', updatedAt: at(60 * 30).toISOString() };
  const settings = (minutes, dailyMinutes) => ({ key: 'app', dailyMinutes, desiredRetention: 0.9, selectedBooks: ['HS-R1'], mode: 'normal', theme: 'system',
    aiEnabled: false, diagnosisComplete: false, examDate: null, updatedAt: at(minutes).toISOString() });
  const version = (id, minute) => ({ id, text: `draft ${id}`, savedAt: at(minute).toISOString() });
  const writing = (versions, minute) => ({ id: 'essay', createdAt: at(0).toISOString(), updatedAt: at(minute).toISOString(), genre: 'free', title: 'Title',
    prompt: 'Prompt', targetIds: [], wordRange: [80, 120], versions });
  const { payload } = mergeBackups(
    snapshot([shared], [localCard], { settings: [settings(10, 30)], writings: [writing([version('v1', 1), version('v3', 40)], 40)] }),
    snapshot([shared, cloud], [cloud.after], { settings: [settings(20, 60)], writings: [writing([version('v1', 1), version('v2', 20)], 20)] }),
  );
  const merged = card(payload, 'apple');
  assert.equal(merged.note, 'local note');
  assert.equal(merged.favorite, true);
  assert.equal(merged.status, 'paused');
  assert.deepEqual(merged.fsrs, cloud.after.fsrs, 'scheduling still follows the answers');
  assert.equal(payload.settings[0].dailyMinutes, 60);
  assert.deepEqual(payload.writings[0].versions.map((row) => row.id), ['v1', 'v2', 'v3']);
});

test('large histories merge in linear time', () => {
  const localEvents = [], cloudEvents = [], localCards = [], cloudCards = [];
  for (let word = 0; word < 2_000; word++) {
    const id = `word-${word}`;
    let localCard = null, cloudCard = null;
    for (let step = 0; step < 4; step++) {
      const local = review(localCard, id, { eventId: `l-${word}-${step}`, minute: step * 1440 });
      const cloud = review(cloudCard, id, { eventId: `c-${word}-${step}`, minute: step * 1440 + 5 });
      localEvents.push(local); cloudEvents.push(cloud); localCard = local.after; cloudCard = cloud.after;
    }
    localCards.push(localCard); cloudCards.push(cloudCard);
  }
  const started = performance.now();
  const { payload, summary } = mergeBackups(snapshot(localEvents, localCards), snapshot(cloudEvents, cloudCards));
  assert.equal(summary.rescheduledWords, 2_000);
  assert.equal(payload.events.length, 16_000);
  assert.ok(performance.now() - started < 15_000, `merge took ${performance.now() - started} ms`);
});

test('a merged snapshot replaces local data only if nothing was saved since the export', async () => {
  await clearUserData();
  const { generation } = await loadLearningState();
  const local = review(null, 'apple', { eventId: 'local-1', minute: 0 });
  await commitReview(local, generation);
  const exported = await exportBackup(generation);
  const cloud = review(null, 'banana', { eventId: 'cloud-1', minute: 1 });
  const { payload } = mergeBackups(exported, snapshot([cloud], [cloud.after]));

  const extra = review(null, 'cherry', { eventId: 'local-2', minute: 2 });
  await commitReview(extra, generation);
  await assert.rejects(replaceMergedBackup(payload, exported, generation), LocalDataChangedError);
  assert.equal((await exportBackup(generation)).events.length, 2, 'local data untouched');

  const current = await exportBackup(generation);
  const remerged = mergeBackups(current, snapshot([cloud], [cloud.after])).payload;
  const replaced = await replaceMergedBackup(remerged, current, generation);
  assert.notEqual(replaced, generation);
  assert.deepEqual((await exportBackup(replaced)).events.map((event) => event.eventId).sort(), ['cloud-1', 'local-1', 'local-2']);
  await restoreBackup(snapshot([], []));
});
