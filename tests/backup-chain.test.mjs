import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { newStoredCard, scheduleReview } from '../lib/scheduler.ts';
import { validateBackup } from '../lib/backup.ts';
import { clearUserData, commitReview, exportBackup, restoreBackup, updateCardMetadata } from '../lib/storage.ts';

const clock = new Date('2026-10-02T10:00:00.000Z');
let sequence = 0;
function review(stored = null, { rating = 4, now = clock, eventId = `review-${++sequence}` } = {}) {
  return { ...scheduleReview({ stored, cardId: stored?.id || 'apple', rating, now,
    retention: .9, skill: 'meaning', questionType: 'meaning-recall', correct: rating !== 1,
    responseMs: 1000, hints: 0, errorType: rating === 1 ? 'recall' : null,
  }).event, eventId };
}
const undo = (target, eventId = `undo-${++sequence}`) => ({ ...structuredClone(target),
  eventType: 'undo', eventId, targetEventId: target.eventId,
});
const payload = (cards = [], events = []) => ({ schemaVersion: '1.2.0',
  cards, events, lists: [], settings: [], writings: [],
});
const first = review(null, { eventId: 'z-first' });
const second = review(first.after, { eventId: 'a-second', now: new Date(clock.getTime() + 1000) });
const reject = (backup) => assert.throws(() => validateBackup(backup), /复习.*(?:链|词卡|调度)|词卡.*复习/);

test('normal exports keep note and favorite edits between reviews and after the terminal review', async () => {
  await clearUserData();
  const initial = await updateCardMetadata(newStoredCard('apple', clock), { note: 'first note' });
  const a = review(initial, { eventId: 'z-first' });
  await commitReview(a);
  const noted = await updateCardMetadata(a.after, { note: 'before second', toggleFavorite: true });
  const b = review(noted, { eventId: 'a-second', now: new Date(clock.getTime() + 1000) });
  await commitReview(b);
  await updateCardMetadata(b.after, { note: 'after second' });
  const exported = await exportBackup();
  assert.deepEqual(exported.events.map((event) => event.eventId), ['a-second', 'z-first'], 'real IndexedDB key order differs from review order');
  assert.doesNotThrow(() => validateBackup(exported));
  await restoreBackup(exported);
  const restored = await exportBackup();
  assert.deepEqual(restored.cards, exported.cards);
  assert.deepEqual(restored.events, exported.events);
});

test('old schemas retain reviewed baselines, optional FSRS fields, and independent metadata/status', () => {
  for (const schemaVersion of ['1.0.0', '1.1.0', '1.2.0']) {
    const card = structuredClone(first.after);
    delete card.fsrs.learning_steps;
    card.note = 'legacy note'; card.tags = ['exam']; card.favorite = true; card.status = 'paused';
    card.updatedAt = new Date(clock.getTime() - 1000).toISOString();
    const old = { ...payload([card], [first]), schemaVersion };
    if (schemaVersion !== '1.2.0') delete old.writings;
    assert.doesNotThrow(() => validateBackup(old));
    const partial = { ...payload([second.after], [second]), schemaVersion };
    if (schemaVersion !== '1.2.0') delete partial.writings;
    assert.doesNotThrow(() => validateBackup(partial), 'the first included event can start from an older reviewed baseline');
    assert.doesNotThrow(() => validateBackup({ ...partial, events: [] }), 'legacy cards can have no exported events');
  }
});

test('same-time and clock-rollback chains are independent of array, timestamp, and event-ID order', () => {
  for (const now of [clock, new Date(clock.getTime() - 86_400_000)]) {
    const b = review(first.after, { now, eventId: 'a-after-z' });
    for (const events of [[first, b], [b, first]])
      assert.doesNotThrow(() => validateBackup(payload([b.after], events)));
  }
});

test('undo and redo preserve inactive branches while requiring one terminal active chain', () => {
  const redo = review(first.after, { rating: 1, eventId: 'redo-second' });
  const events = [redo, undo(second), first, second];
  assert.doesNotThrow(() => validateBackup(payload([redo.after], events)));
  const third = review(redo.after, { eventId: 'third' });
  assert.doesNotThrow(() => validateBackup(payload([third.after], [third, ...events])));
});

test('all-undone histories allow an absent original card and a new metadata-only card', async () => {
  await clearUserData();
  await commitReview(first);
  await commitReview(second);
  await commitReview(undo(second));
  await commitReview(undo(first));
  const removed = await exportBackup();
  assert.deepEqual(removed.cards, []);
  assert.doesNotThrow(() => validateBackup(removed));
  const later = newStoredCard('apple', new Date(clock.getTime() + 60_000));
  await updateCardMetadata(later, { note: 'new note after undo', toggleFavorite: true });
  const recreated = await exportBackup();
  assert.doesNotThrow(() => validateBackup(recreated));
  await restoreBackup(recreated);
  assert.deepEqual((await exportBackup()).cards, recreated.cards);
});

test('all-undone reviewed baselines return to their original scheduler state', () => {
  const card = { ...structuredClone(first.after), note: 'retained baseline note', status: 'paused' };
  assert.doesNotThrow(() => validateBackup(payload([card], [undo(second), second])));
});

test('equivalent timezone encodings compare by absolute time without rewriting the imported payload', () => {
  const backup = payload([structuredClone(first.after)], [structuredClone(first)]);
  const dateOffset = (date) => new Date(Date.parse(date) + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
  for (const key of ['due', 'lastReviewed']) backup.cards[0][key] = dateOffset(backup.cards[0][key]);
  for (const key of ['due', 'last_review']) backup.cards[0].fsrs[key] = dateOffset(backup.cards[0].fsrs[key]);
  const original = structuredClone(backup);
  assert.deepEqual(validateBackup(backup), original);
});

test('a shape-valid terminal skill mismatch is rejected', () => {
  const card = structuredClone(second.after); card.skills.context = .75;
  reject(payload([card], [first, second]));
});

test('a terminal review cannot be reclassified as unseen, weak, or mastered independently of its history', () => {
  for (const status of ['unseen', 'weak', 'mastered']) {
    const card = { ...structuredClone(second.after), status };
    reject(payload([card], [first, second]));
  }
});

test('an original review never produces an unseen or paused state even when its current card agrees', () => {
  for (const status of ['unseen', 'paused']) {
    const forged = structuredClone(first); forged.after.status = status;
    reject(payload([forged.after], [forged]));
  }
});

test('paused cards retain their scheduler history and can resume through a normal review', () => {
  const paused = { ...structuredClone(first.after), status: 'paused', note: 'temporarily paused' };
  assert.doesNotThrow(() => validateBackup(payload([paused], [first])));
  const resumed = review(paused, { eventId: 'resume-paused' });
  assert.equal(resumed.after.status, 'learning');
  assert.doesNotThrow(() => validateBackup(payload([resumed.after], [resumed, first])));
  assert.doesNotThrow(() => validateBackup(payload([paused], [resumed, first, undo(resumed)])));
});

test('status changes inside an active chain cannot reinterpret the preceding review as unseen', () => {
  const broken = structuredClone(second); broken.before.status = 'unseen';
  reject(payload([broken.after], [first, broken]));
});

test('an all-undone originally absent card remains unseen when recreated only for metadata', () => {
  const fresh = { ...newStoredCard('apple', new Date(clock.getTime() + 60_000)), note: 'retained note' };
  assert.doesNotThrow(() => validateBackup(payload([fresh], [first, undo(first)])));
  reject(payload([{ ...fresh, status: 'learning' }], [first, undo(first)]));
  assert.doesNotThrow(() => validateBackup(payload([{ ...fresh, status: 'paused' }], [first, undo(first)])));
});

test('a shape-valid terminal scheduler mismatch and unknown FSRS value changes are rejected', () => {
  for (const mutate of [
    (card) => { card.fsrs.stability += 1; },
    (card) => { card.fsrs.due = card.due = new Date(Date.parse(card.due) + 1000).toISOString(); },
    (card) => { card.fsrs.futureSchedulerField = 1; },
  ]) {
    const card = structuredClone(second.after); mutate(card);
    reject(payload([card], [first, second]));
  }
});

test('an active terminal review cannot reference a missing current card', () => {
  reject(payload([], [first, second]));
});

test('each original review advances exactly one repetition counter', () => {
  for (const event of [structuredClone(first), structuredClone(second)]) {
    event.after.fsrs.reps += 1;
    reject(payload([event.after], [event]));
  }
});

test('shape-valid discontinuities between active before and after snapshots are rejected', () => {
  const broken = structuredClone(second); broken.before.skills.context = .75;
  reject(payload([broken.after], [first, broken]));
});

test('two active reviews from the same baseline are rejected even when one matches the card', () => {
  const other = review(first.after, { rating: 1, eventId: 'active-branch' });
  reject(payload([second.after], [first, second, other]));
});

test('undoing a predecessor cannot leave its dependent active review installed', () => {
  reject(payload([second.after], [first, second, undo(first)]));
});

test('an all-undone history cannot retain the undone scheduler state or lose its reviewed baseline', () => {
  reject(payload([first.after], [first, undo(first)]));
  reject(payload([], [second, undo(second)]));
});

test('a disconnected inactive history cannot be attached to an otherwise valid active chain', () => {
  const foreignBaseline = structuredClone(first.after); foreignBaseline.fsrs.reps = 50;
  const unrelated = review(foreignBaseline, { eventId: 'unrelated-undone' });
  reject(payload([first.after], [first, unrelated, undo(unrelated)]));
});

test('event-chain validation rejects the entire restore before replacing any existing store', async () => {
  await clearUserData();
  await commitReview(first);
  const saved = await exportBackup();
  const corrupted = payload([structuredClone(second.after)], [first, structuredClone(second)]);
  corrupted.cards[0].skills.context = .75;
  await assert.rejects(restoreBackup(corrupted), /复习.*(?:链|词卡|调度)|词卡.*复习/);
  const remaining = await exportBackup();
  for (const store of ['cards', 'events', 'lists', 'settings', 'writings'])
    assert.deepEqual(remaining[store], saved[store]);
});

test('cloud sync rejects inconsistent event chains without advancing the saved revision', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync, readdirSync } = await import('node:fs');
  const { sqliteD1 } = await import('./sqlite-d1.mjs');
  const { env } = await import('./worker-env.mjs');
  const { requestHeaders } = await import('./request-headers.mjs');
  const { GET, POST } = await import('../app/api/sync/route.ts');
  const database = new DatabaseSync(':memory:');
  for (const migration of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort())
    database.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  const previousBinding = env.DB;
  const previousEmail = requestHeaders.get('oai-authenticated-user-email');
  env.DB = sqliteD1(database);
  requestHeaders.set('oai-authenticated-user-email', 'backup-chain@example.test');
  const request = (backup, baseRevision) => new Request('https://app.test/api/sync', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body: JSON.stringify({ schemaVersion: '1.2.0', baseRevision,
      clientUpdatedAt: clock.toISOString(), payload: backup }),
  });
  try {
    const backup = payload([second.after], [second, first]);
    assert.equal((await POST(request(backup, 0))).status, 200);
    const before = (await (await GET()).json()).state;
    // A parsed JSON backup has independent card/event objects; structuredClone
    // would preserve this fixture's shared references and change both snapshots.
    const corrupted = JSON.parse(JSON.stringify(backup)); corrupted.cards[0].skills.context = .75;
    const rejected = await POST(request(corrupted, 1));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'invalid_payload');
    assert.deepEqual((await (await GET()).json()).state, before);
  } finally {
    env.DB = previousBinding;
    if (previousEmail === null) requestHeaders.delete('oai-authenticated-user-email');
    else requestHeaders.set('oai-authenticated-user-email', previousEmail);
    database.close();
  }
});
