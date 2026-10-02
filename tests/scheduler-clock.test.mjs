import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { newStoredCard, previewReviewIntervals, scheduleReview } from '../lib/scheduler.ts';
import { clearUserData, commitReview, exportBackup, getOne, restoreBackup, validateBackup } from '../lib/storage.ts';

const originalTime = new Date('2026-10-02T10:00:00.000Z');
const rewoundTime = new Date('2026-09-01T10:00:00.000Z');
const createReview = (stored, rating, now) => scheduleReview({
  stored, cardId: stored?.id || 'apple', rating, now, retention: .9,
  skill: 'meaning', questionType: 'meaning-recall', correct: rating !== 1,
  responseMs: 1234, hints: 0, errorType: rating === 1 ? 'recall' : null,
});
const reviewed = createReview(null, 4, originalTime).after;
const states = [
  newStoredCard('new', originalTime),
  createReview(null, 3, originalTime).after,
  reviewed,
  createReview(reviewed, 1, new Date('2026-10-09T10:00:00.000Z')).after,
];
const schedulingTime = (card, now) => new Date(Math.max(now.getTime(), card.fsrs.last_review ? Date.parse(card.fsrs.last_review) : -Infinity));

test('preview and saved reviews share a monotonic scheduler clock for every FSRS state and rating', () => {
  assert.deepEqual(states.map((card) => card.fsrs.state), [0, 1, 2, 3]);
  for (const card of states) {
    const snapshot = structuredClone(card);
    const effective = schedulingTime(card, rewoundTime);
    const preview = previewReviewIntervals(card, .9, rewoundTime);
    assert.deepEqual(preview.map((row) => row.due), previewReviewIntervals(card, .9, effective).map((row) => row.due));
    for (const row of preview) assert.equal(row.days, (Date.parse(row.due) - rewoundTime.getTime()) / 86_400_000);
    for (const rating of [1, 2, 3, 4]) {
      const rewound = createReview(card, rating, rewoundTime);
      const normal = createReview(card, rating, effective);
      assert.deepEqual(rewound.after.fsrs, normal.after.fsrs);
      assert.equal(rewound.after.due, normal.after.due);
      assert.deepEqual(rewound.after.skills, normal.after.skills);
      assert.equal(rewound.after.lastReviewed, effective.toISOString());
      assert.equal(rewound.after.updatedAt, rewoundTime.toISOString());
      assert.equal(rewound.event.timestampUtc, rewoundTime.toISOString());
      assert.equal(rewound.event.localDate, rewoundTime.toLocaleDateString('sv-SE'));
      assert.equal(rewound.event.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
      assert.equal(rewound.event.schedulerLog.review, effective.toISOString());
      assert.equal(rewound.event.intervalBeforeDays, card.lastReviewed ? Math.max(0, (Date.parse(card.due) - Date.parse(card.lastReviewed)) / 86_400_000) : null);
      assert.equal(rewound.event.intervalAfterDays, Math.max(0, (Date.parse(rewound.after.due) - effective.getTime()) / 86_400_000));
      assert.deepEqual(rewound.event.before, snapshot);
      assert.doesNotThrow(() => validateBackup({ schemaVersion: '1.2.0', cards: [rewound.after], events: [rewound.event], lists: [], settings: [], writings: [] }));
    }
    assert.deepEqual(card, snapshot, 'neither preview nor scheduling mutates the expected CAS snapshot');
  }
});

test('a rewind, partial clock recovery and full recovery preserve normal scheduling intervals', () => {
  const backwards = createReview(reviewed, 3, rewoundTime);
  assert.equal(backwards.after.lastReviewed, originalTime.toISOString());
  const partiallyRecovered = createReview(backwards.after, 4, new Date('2026-09-30T10:00:00.000Z'));
  assert.equal(partiallyRecovered.after.lastReviewed, originalTime.toISOString());
  const recoveredTime = new Date('2026-10-12T10:00:00.000Z');
  const recovered = createReview(partiallyRecovered.after, 3, recoveredTime);
  assert.equal(recovered.after.lastReviewed, recoveredTime.toISOString());
  assert.equal(recovered.after.fsrs.elapsed_days, 10);
  assert.equal(recovered.event.timestampUtc, recoveredTime.toISOString());
  assert.equal(recovered.event.intervalAfterDays, (Date.parse(recovered.after.due) - recoveredTime.getTime()) / 86_400_000);
  assert.deepEqual(recovered.event.before, partiallyRecovered.after);
});

test('rewound-clock reviews commit through existing CAS checks and survive backup restore', async () => {
  await clearUserData();
  const initial = createReview(null, 4, originalTime);
  await commitReview(initial.event);
  const rewound = createReview(initial.after, 3, rewoundTime);
  await commitReview(rewound.event);
  assert.deepEqual(await getOne('cards', initial.after.id), rewound.after);
  const saved = await exportBackup();
  assert.doesNotThrow(() => validateBackup(saved));
  await restoreBackup(saved);
  assert.deepEqual(await getOne('cards', initial.after.id), rewound.after);
  const normalTime = new Date('2026-10-03T10:00:00.000Z');
  const next = createReview(await getOne('cards', initial.after.id), 3, normalTime);
  await commitReview(next.event);
  assert.equal((await getOne('cards', initial.after.id)).lastReviewed, normalTime.toISOString());
});

test('New cards without prior reviews keep the actual answer clock', () => {
  for (const stored of [null, states[0]]) {
    const result = createReview(stored, 4, rewoundTime);
    assert.equal(result.after.lastReviewed, rewoundTime.toISOString());
    assert.equal(result.after.fsrs.last_review, rewoundTime.toISOString());
    assert.equal(result.event.timestampUtc, rewoundTime.toISOString());
  }
});
