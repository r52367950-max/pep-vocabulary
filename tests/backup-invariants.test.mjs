import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { newStoredCard, previewReviewIntervals, scheduleReview } from '../lib/scheduler.ts';
import { clearUserData, commitReview, exportBackup, restoreBackup, validateBackup } from '../lib/storage.ts';
import { defaultSettings, validUndoTarget } from '../lib/backup.ts';

const now = new Date('2026-10-02T10:00:00.000Z');
const review = (stored = null, rating = 4, at = now) => scheduleReview({
  stored, cardId: stored?.id || 'apple', rating, retention: .9, skill: 'meaning',
  questionType: 'meaning-recall', correct: rating !== 1, responseMs: 1000,
  hints: 0, errorType: rating === 1 ? 'recall' : null, now: at,
}).event;
const first = review();
const subsequent = review(first.after, 1, new Date('2026-10-09T10:00:00.000Z'));
const payload = (cards = [], events = []) => ({
  schemaVersion: '1.2.0', cards, events, lists: [], settings: [], writings: [],
});
const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
    : value;

test('all application-generated FSRS states remain importable and schedulable', () => {
  const cards = [newStoredCard('new', now), review(null, 3).after, first.after, subsequent.after];
  assert.deepEqual(cards.map((card) => card.fsrs.state), [0, 1, 2, 3]);
  for (const card of cards) {
    assert.doesNotThrow(() => validateBackup(payload([card])));
    const at = new Date(Math.max(now.getTime(), Date.parse(card.lastReviewed || card.updatedAt)) + 86_400_000);
    assert.equal(previewReviewIntervals(card, .9, at).length, 4);
    for (const rating of [1, 2, 3, 4]) assert.doesNotThrow(() => review(card, rating, at));
  }
});

test('invalid FSRS memory state is rejected in cards and both review snapshots', () => {
  const mutations = [
    (card) => { card.fsrs.stability = 0; },
    (card) => { card.fsrs.last_review = null; },
    (card) => { card.fsrs.last_review = ''; },
    (card) => { card.fsrs.last_review = 0; },
    (card) => { card.lastReviewed = null; },
    (card) => { card.fsrs.last_review = '2026-02-31T10:00:00Z'; },
    (card) => { card.fsrs.due = '2026-02-31T10:00:00Z'; },
    (card) => { card.fsrs.last_review = '9999-12-31T23:59:59.999Z'; },
    (card) => { card.fsrs.due = '9999-12-31T23:59:59.999Z'; },
    (card) => { card.fsrs.reps = .5; },
    (card) => { card.fsrs.reps = Number.MAX_SAFE_INTEGER; },
    (card) => { card.fsrs.lapses = .5; },
    (card) => { card.fsrs.elapsed_days = .5; },
    (card) => { card.fsrs.scheduled_days = .5; },
    (card) => { card.fsrs.learning_steps = .5; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    for (const location of ['cards', 'before', 'after']) {
      const backup = payload([structuredClone(first.after)], [structuredClone(subsequent)]);
      mutate(location === 'cards' ? backup.cards[0] : backup.events[0][location]);
      assert.throws(() => validateBackup(backup), /词卡|复习事件/, `${location}, mutation ${index}`);
    }
  }
});

test('card dates must represent real calendar days', () => {
  for (const key of ['due', 'updatedAt']) {
    const card = newStoredCard('new', now); card[key] = '2026-02-31T00:00:00Z';
    assert.throws(() => validateBackup(payload([card])), /词卡/);
  }
});

test('invalid imported scheduler state never replaces the existing learning database', async () => {
  await clearUserData();
  await commitReview(structuredClone(first));
  const saved = await exportBackup();
  for (const location of ['cards', 'before', 'after']) {
    const corrupt = payload([structuredClone(first.after)], [structuredClone(subsequent)]);
    (location === 'cards' ? corrupt.cards[0] : corrupt.events[0][location]).fsrs.stability = 0;
    await assert.rejects(restoreBackup(corrupt), /词卡|复习事件/);
    const remaining = await exportBackup();
    for (const table of ['cards', 'events', 'lists', 'settings', 'writings']) assert.deepEqual(remaining[table], saved[table]);
  }
});

test('older backup schemas and missing optional learning_steps retain scheduler compatibility', () => {
  for (const schemaVersion of ['1.0.0', '1.1.0', '1.2.0']) {
    const card = structuredClone(first.after); delete card.fsrs.learning_steps;
    const backup = { ...payload([card], [first]), schemaVersion, settings: [structuredClone(defaultSettings)] };
    if (schemaVersion !== '1.2.0') delete backup.writings;
    if (schemaVersion === '1.0.0') { delete backup.settings[0].theme; delete backup.settings[0].aiEnabled; }
    const imported = validateBackup(backup);
    assert.equal(imported.schemaVersion, '1.2.0');
    assert.equal(previewReviewIntervals(imported.cards[0], .9, now).length, 4);
    assert.doesNotThrow(() => review(imported.cards[0], 3, new Date('2026-10-09T10:00:00Z')));
  }
});

test('equivalent timezone encodings and self-consistent future clock readings remain importable', () => {
  const card = structuredClone(first.after);
  card.fsrs.due = '2026-10-09T18:00:00+08:00';
  card.fsrs.last_review = '2026-10-02T18:00:00+08:00';
  card.updatedAt = '2026-09-01T10:00:00Z';
  assert.doesNotThrow(() => validateBackup(payload([card])));
  const future = review(null, 4, new Date('2030-01-01T10:00:00Z')).after;
  assert.doesNotThrow(() => validateBackup(payload([future])));
  assert.equal(previewReviewIntervals(future, .9, new Date('2030-01-02T10:00:00Z')).length, 4);
});

test('undo snapshot equality ignores object key order while retaining every value check', () => {
  const target = structuredClone(subsequent);
  const undo = { ...target, eventType: 'undo', eventId: 'undo', targetEventId: target.eventId,
    before: reverseKeys(target.before), after: reverseKeys(target.after) };
  assert.ok(validUndoTarget(target, undo));
  assert.doesNotThrow(() => validateBackup(payload([target.before], [target, undo])));
  const changed = structuredClone(undo); changed.after.skills.meaning = .123;
  assert.equal(Boolean(validUndoTarget(target, changed)), false);
  assert.throws(() => validateBackup(payload([target.before], [target, changed])), /撤销记录/);
});

test('the largest representable date cannot enter a destructive restoration', async () => {
  await clearUserData();
  await commitReview(structuredClone(first));
  const saved = await exportBackup();
  const card = structuredClone(first.after);
  const maximum = '+275760-09-13T00:00:00.000Z';
  card.fsrs.last_review = card.lastReviewed = card.fsrs.due = card.due = maximum;
  assert.throws(() => validateBackup(payload([card])), /词卡/);
  await assert.rejects(restoreBackup(payload([card])), /词卡/);
  assert.deepEqual((await exportBackup()).cards, saved.cards);
  const ordinaryFuture = review(null, 4, new Date('9999-01-01T10:00:00Z')).after;
  assert.doesNotThrow(() => validateBackup(payload([ordinaryFuture])));
  assert.equal(previewReviewIntervals(ordinaryFuture, .9, now).length, 4);
});

test('counter exhaustion is explicitly rejected before corrupt scheduler output can be committed', () => {
  for (const [key, rating] of [['reps', 4], ['lapses', 1]]) {
    const card = structuredClone(first.after);
    card.fsrs[key] = Number.MAX_SAFE_INTEGER;
    assert.throws(() => validateBackup(payload([card])), /词卡/);
    card.fsrs[key] = Number.MAX_SAFE_INTEGER - 1;
    assert.doesNotThrow(() => validateBackup(payload([card])));
    assert.throws(() => review(card, rating), /超出安全范围/);
  }
});
