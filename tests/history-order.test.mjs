import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { activeOf, activeReviews, ReviewHistory, studyStats } from "../lib/progress.ts";
import { headwordLookup, summarizeMistakes } from "../lib/mistakes.ts";
import { suggestTargets } from "../lib/writing.ts";
import { buildLearnerProfile } from "../lib/learner-profile.ts";
import { clearUserData, getAll, putOne } from "../lib/storage.ts";

const now = new Date("2026-10-02T12:00:00Z");
const review = (eventId, timestampUtc, extra = {}) => ({
  eventType: "review", eventId, cardId: eventId, timestampUtc,
  localDate: "2026-10-02", timezone: "UTC", questionType: "spelling", skill: "spelling",
  rating: 1, correct: false, responseMs: 1000, hints: 0, errorType: "spelling",
  answerGiven: "", expectedAnswer: "answer", before: null, after: { id: eventId }, schedulerLog: {},
  ...extra,
});
const undo = (eventId, targetEventId, timestampUtc) => review(eventId, timestampUtc, { eventType: "undo", targetEventId });
const ids = (events) => events.map((event) => event.eventId);
const lookup = new Map();
const entry = (id, headword = id) => ({ id, headword, flags: { properName: false } });
// Independent oracle: absolute time, then deterministic event ID order, never arrival or key order.
const ordered = (events) => [...events].sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
  || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
const comparableStats = ({ reviews, todayEvents, ...rest }) => ({ ...rest, reviews: [...reviews], todayEvents: [...todayEvents] });

test("IndexedDB key order cannot hide a recent mistake or choose an old recent review", async (t) => {
  await clearUserData();
  t.after(() => clearUserData());
  const newer = review("a-random-new-id", "2026-10-01T10:00:00Z");
  const older = review("z-random-old-id", "2026-09-01T10:00:00Z");
  await putOne("events", older);
  await putOne("events", newer);
  const persisted = await getAll("events");
  assert.deepEqual(ids(persisted), [newer.eventId, older.eventId], "reproduces getAll key order");
  const history = ReviewHistory.from(persisted);
  assert.deepEqual(ids(history.recent(1)), [newer.eventId]);
  const summary = summarizeMistakes(history.active, lookup, Date.parse("2026-09-28T00:00:00Z"));
  assert.deepEqual(ids(summary.recent.map((item) => item.event)), [newer.eventId]);
  assert.equal(summary.counts.recall, 1);
  assert.deepEqual(await getAll("events"), persisted, "analysis must leave persisted events unchanged");
});

test("raw-array activeOf compatibility includes chronology and undo without changing input", () => {
  const older = review("z-old", "2026-09-29T09:00:00Z", { eventType: undefined });
  const middle = review("m-undone", "2026-09-30T09:00:00Z");
  const newer = review("a-new", "2026-10-01T09:00:00Z");
  const events = [newer, undo("u", middle.eventId, "2026-10-01T10:00:00Z"), middle, older];
  const original = structuredClone(events);
  const expected = [older, newer];
  assert.deepEqual(activeOf(events), expected);
  assert.deepEqual(activeReviews(events), expected);
  assert.deepEqual(ReviewHistory.from(events).active, expected);
  assert.equal(ReviewHistory.from(events).active[0], older, "original event objects are retained");
  assert.deepEqual(events, original);
  assert.deepEqual(ReviewHistory.from(events).events, events, "audit load order stays intact");
});

test("absolute timestamps and event IDs decide chronology across offsets and ties", () => {
  const events = [
    review("z-earlier", "2026-10-01T03:00:00+02:00"), // 01:00 UTC
    review("a-later", "2026-10-01T00:30:00-02:00"), // 02:30 UTC
    review("tie-z", "2026-10-01T01:00:00Z"),
    review("tie-a", "2026-09-30T20:00:00-05:00"),
  ];
  const expected = ordered(events);
  for (const input of [events, [...events].reverse(), [events[2], events[0], events[3], events[1]]]) {
    assert.deepEqual(ReviewHistory.from(input).active, expected);
    assert.deepEqual(ReviewHistory.from(input).recent(4), [...expected].reverse());
    assert.deepEqual(activeOf(input), expected);
    let incremental = new ReviewHistory();
    for (const event of input) incremental = incremental.append(event);
    assert.deepEqual(incremental.active, expected);
  }
});

test("late arrival, clock rollback, duplicate IDs and early undo preserve history indexes", () => {
  const first = review("first", "2026-10-02T10:00:00Z");
  const newest = review("newest", "2026-10-02T12:00:00Z");
  let history = ReviewHistory.from([newest, first]);
  const events = [newest, first];
  const changes = [
    review("late", "2026-10-02T11:00:00Z"),
    review("clock-rollback", "2026-10-02T09:00:00Z"),
    undo("early-undo", "arrives-after-undo", "2026-10-02T08:00:00Z"),
    review("arrives-after-undo", "2026-10-02T07:00:00Z"),
    undo("late-undo", "late", "2026-10-02T06:00:00Z"),
    review("normal-append", "2026-10-02T13:00:00Z"),
  ];
  for (const event of changes) {
    events.push(event);
    history = history.append(event);
    const expected = ordered(events.filter((item) => item.eventType !== "undo"
      && !events.some((candidate) => candidate.eventType === "undo" && candidate.targetEventId === item.eventId)));
    assert.deepEqual(history.active, expected);
    assert.deepEqual(history.recent(3), [...expected].reverse().slice(0, 3));
    assert.deepEqual(comparableStats(history.stats(now)), comparableStats(studyStats(events, now)));
    assert.deepEqual(history.stats(now).todayEvents, expected);
    assert.deepEqual(history.events, events);
  }
  const version = history.version;
  const stats = history.stats(now);
  history = history.append({ ...first, timestampUtc: "2027-01-01T00:00:00Z" });
  assert.equal(history.version, version);
  assert.equal(history.stats(now), stats);
  assert.equal(history.size, events.length);
  const duplicate = { ...first, timestampUtc: "2026-01-01T00:00:00Z" };
  assert.deepEqual(ReviewHistory.from([...events, duplicate]).active, history.active, "first ID wins before sorting");
});

test("mistake time windows and confusion order accept unsorted raw reviews and offset dates", () => {
  const events = [review("new", "2026-10-01T10:00:00Z"), review("old", "2026-09-01T10:00:00Z")];
  const summary = summarizeMistakes(events, lookup, Date.parse("2026-09-28T00:00:00Z"));
  assert.deepEqual(ids(summary.recent.map((item) => item.event)), ["new"]);
  assert.deepEqual(ids(summarizeMistakes(events, lookup, Date.parse(events[0].timestampUtc)).recent.map((item) => item.event)), ["new"], "since includes its exact boundary");
  const pairs = [
    review("a", "2026-10-01T00:30:00-02:00", { answerGiven: "beta", cardId: "a" }),
    review("c", "2026-10-01T03:00:00+02:00", { answerGiven: "delta", cardId: "c" }),
  ];
  const words = headwordLookup([entry("b", "beta"), entry("d", "delta")]);
  assert.deepEqual(summarizeMistakes(pairs, words).confusions.map((pair) => pair.cardId), ["a", "c"]);
});

test("writing targets and learner profile select the actual newest mistakes", () => {
  const newer = review("a-new", "2026-10-01T09:00:00Z", { cardId: "word", answerGiven: "answe", expectedAnswer: "answer" });
  const older = review("z-old", "2026-09-01T09:00:00Z", { cardId: "word" });
  const distinctOld = review("z-old-other", "2026-09-01T08:00:00Z", { cardId: "older-word" });
  const middle = review("m-middle", "2026-09-30T09:00:00Z");
  const events = [newer, middle, older, distinctOld];
  const byId = new Map([entry("word"), entry(middle.cardId), entry(distinctOld.cardId)].map((word) => [word.id, word]));
  assert.deepEqual(suggestTargets(events, new Map(), byId, 1).map((word) => word.id), ["word"]);
  assert.deepEqual(suggestTargets(events, new Map(), byId, 2).map((word) => word.id), ["word", "m-middle"]);
  for (const reviews of [events, ReviewHistory.from(events).active]) {
    const profile = buildLearnerProfile({ reviews, cards: new Map(), lookup, now });
    assert.deepEqual(profile.recentMistakes.map((mistake) => mistake.kind), ["near-miss", "recall", "recall", "recall"]);
    assert.equal(profile.weakWords.find((word) => word.id === "word").lastKind, "near-miss");
  }
});

test("normal chronological appends never re-sort the existing history", (t) => {
  const base = Date.parse("2026-09-01T00:00:00Z");
  const events = Array.from({ length: 20_000 }, (_, i) => review(`base-${i}`, new Date(base + i * 1000).toISOString(), { correct: true }));
  let history = ReviewHistory.from(events);
  let sorts = 0;
  let parses = 0;
  const originalSort = Array.prototype.sort;
  const originalParse = Date.parse;
  Array.prototype.sort = function (...args) { sorts++; return originalSort.apply(this, args); };
  Date.parse = (...args) => { parses++; return originalParse(...args); };
  t.after(() => { Array.prototype.sort = originalSort; Date.parse = originalParse; });
  for (let i = 0; i < 200; i++) history = history.append(review(`next-${i}`, new Date(base + (events.length + i) * 1000).toISOString()));
  assert.equal(sorts, 0);
  assert.ok(parses <= 800, `200 appends parsed ${parses} timestamps; work must not scale with 20,000 stored events`);
  assert.equal(history.size, 20_200);
  assert.equal(history.recent(1)[0].eventId, "next-199");
});
