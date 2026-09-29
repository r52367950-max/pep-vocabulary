import assert from "node:assert/strict";
import test from "node:test";
import { activeReviews, ReviewHistory, studyStats } from "../lib/progress.ts";
import { restoreSession } from "../lib/session.ts";
import { markBackupExported, requestPersistentStorage, storageStatus, takeBackupReminder } from "../lib/persistence.ts";

const now = new Date(2026, 8, 29, 12, 0, 0);
const day = (offset) => {
  const date = new Date(now);
  date.setDate(date.getDate() - offset);
  return date.toLocaleDateString("sv-SE");
};
const days = Array.from({ length: 40 }, (_, i) => day(i));
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const review = (id, cardId, localDate, extra = {}) => ({
  eventType: "review", eventId: id, cardId, timestampUtc: "2026-09-29T00:00:00.000Z", localDate, timezone: "UTC",
  questionType: "spelling", skill: "spelling", rating: 3, correct: true, responseMs: 1500, hints: 0, errorType: null,
  before: null, after: { id: cardId }, schedulerLog: {}, ...extra,
});
const undo = (id, target, cardId, localDate) => review(id, cardId, localDate, { eventType: "undo", targetEventId: target });

function history(count, seed, undoRate = 0.15) {
  const next = random(seed);
  const events = [];
  for (let i = 0; i < count; i++) {
    const cardId = `w${Math.floor(next() * Math.max(5, count / 3))}`;
    const localDate = days[Math.floor(next() ** 2 * days.length)];
    if (events.length && next() < undoRate) {
      const target = events[Math.floor(next() * events.length)];
      events.push(undo(`u${i}`, next() < 0.1 ? `missing${i}` : target.eventId, target.cardId, localDate));
    } else events.push(review(`e${i}`, cardId, localDate, { correct: next() < 0.7, responseMs: Math.floor(next() * 400_000), before: next() < 0.5 ? null : { lastReviewed: "x" } }));
  }
  return events;
}
const comparable = ({ reviews, todayEvents, ...rest }) => ({ ...rest, reviews: [...reviews], todayEvents: [...todayEvents] });
const same = (built, events) => {
  assert.deepEqual(comparable(built.stats(now)), comparable(studyStats(events, now)));
  const expected = activeReviews(events);
  assert.deepEqual([...built.active], expected);
  assert.equal(built.learnedWords, new Set(expected.map((e) => e.cardId)).size);
  for (const key of days.slice(0, 8)) assert.equal(built.dayWords(key), new Set(expected.filter((e) => e.localDate === key).map((e) => e.cardId)).size);
  assert.deepEqual(built.recent(30), [...expected].reverse().slice(0, 30));
};

test("history stats equal studyStats for randomized histories with undo", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const events = history(60 + seed * 7, seed);
    same(ReviewHistory.from(events), events);
    let incremental = new ReviewHistory();
    events.forEach((event, i) => {
      incremental = incremental.append(event);
      if (i % 9 === 0) same(incremental, events.slice(0, i + 1));
    });
    same(incremental, events);
    // An undo can be read before its target when events come back in key order.
    const shuffled = [...events].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    same(ReviewHistory.from(shuffled), shuffled);
    let reordered = new ReviewHistory();
    for (const event of shuffled) reordered = reordered.append(event);
    same(reordered, shuffled);
  }
});

test("history handles change per append, cache stats per change, and ignore repeated ids", () => {
  const first = new ReviewHistory().append(review("a", "w1", days[0]));
  const stats = first.stats(now);
  assert.equal(first.stats(now), stats);
  const second = first.append(review("b", "w2", days[0]));
  assert.notEqual(second, first);
  assert.notEqual(second.stats(now), stats);
  assert.equal(second.stats(now).todayWords, 2);
  assert.equal(second.size, 2);
  const repeated = second.append(review("b", "w2", days[0]));
  assert.equal(repeated.size, 2);
  assert.equal(repeated.stats(now).todayEvents.length, 2);
  const undone = repeated.append(undo("u", "a", "w1", days[0]));
  assert.equal(undone.stats(now).todayWords, 1);
  assert.equal(undone.learnedWords, 1);
  assert.equal(ReviewHistory.from([review("a", "w1", days[0]), review("a", "w1", days[0])]).size, 1);
});

test("restoreSession reads a ReviewHistory like the event array", () => {
  const session = { id: "s", mode: "daily", title: "t", queue: ["a", "b", "c"], position: 1, startedAt: now.getTime() - 60_000, results: [{ wordId: "a", correct: true, rating: 3 }], retries: {} };
  const events = [review("s:0:0", "a", days[0], { timestampUtc: new Date(now.getTime() - 30_000).toISOString(), after: { id: "a" } })];
  const raw = JSON.stringify(session);
  const ids = new Set(session.queue);
  assert.deepEqual(restoreSession(raw, ids, ReviewHistory.from(events), now.getTime()), restoreSession(raw, ids, events, now.getTime()));
});

test("appending to a large history stays cheap", () => {
  const rows = [];
  for (const size of [10_000, 50_000, 100_000]) {
    const events = history(size, 7, 0.02);
    const extra = Array.from({ length: 200 }, (_, i) => review(`x${size}-${i}`, `w${i % 500}`, days[0]));
    const start = performance.now();
    let built = ReviewHistory.from(events);
    const loaded = performance.now() - start;
    const begin = performance.now();
    for (const event of extra) {
      built = built.append(event);
      built.stats(now);
    }
    const incremental = performance.now() - begin;
    // Old path: copy the array and recompute stats, on a shorter run scaled to 200 appends.
    let copy = events;
    const naiveRuns = 10;
    const naiveStart = performance.now();
    for (const event of extra.slice(0, naiveRuns)) {
      copy = [...copy, event];
      studyStats(copy, now);
    }
    const naive = ((performance.now() - naiveStart) / naiveRuns) * 200;
    rows.push({ events: size, "load ms": +loaded.toFixed(1), "200 appends+stats ms": +incremental.toFixed(2), "naive 200 (est) ms": +naive.toFixed(0) });
    if (size === 50_000) assert.ok(incremental < 150, `200 appends took ${incremental.toFixed(1)} ms`);
    same(built, [...events, ...extra]);
  }
  console.table(rows);
});

test("persistence helpers never throw without navigator.storage or localStorage", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const value of [undefined, {}, { storage: {} }, { storage: { persist: () => { throw new Error("denied"); }, persisted: async () => { throw new Error("denied"); }, estimate: async () => { throw new Error("denied"); } } }]) {
      Object.defineProperty(globalThis, "navigator", { value, configurable: true });
      assert.equal(await requestPersistentStorage(), false);
      assert.deepEqual(await storageStatus(), { persisted: null, usage: null, quota: null });
    }
    Object.defineProperty(globalThis, "navigator", { value: { storage: { persisted: async () => false, persist: async () => true, estimate: async () => ({ usage: 5, quota: 10 }) } }, configurable: true });
    assert.equal(await requestPersistentStorage(), true);
    assert.deepEqual(await storageStatus(), { persisted: false, usage: 5, quota: 10 });
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
  assert.doesNotThrow(() => markBackupExported());
  assert.equal(takeBackupReminder(), false);
});

test("backup reminder fires once per 14 days and not after a recent export", () => {
  const store = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } });
  try {
    const day0 = Date.parse("2026-09-01T00:00:00Z");
    assert.equal(takeBackupReminder(day0), true);
    assert.equal(takeBackupReminder(day0 + 86_400_000), false);
    assert.equal(takeBackupReminder(day0 + 15 * 86_400_000), true);
    markBackupExported(day0 + 20 * 86_400_000);
    assert.equal(takeBackupReminder(day0 + 30 * 86_400_000), false);
    assert.equal(takeBackupReminder(day0 + 40 * 86_400_000), true);
    assert.equal(store.get("pep-vocab-last-export"), String(day0 + 20 * 86_400_000));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});
