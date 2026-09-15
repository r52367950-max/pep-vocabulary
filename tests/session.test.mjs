import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { advanceSession, restoreSession, sessionEventId } from "../lib/session.ts";
import { scheduleReview } from "../lib/scheduler.ts";
import { clearUserData, commitReview, getAll, getOne } from "../lib/storage.ts";

const now = Date.parse("2026-09-15T12:00:00Z");
const makeSession = (queue = ["a", "b", "c", "d", "e", "f"]) => ({
  id: "session-test", mode: "daily", title: "今日学习", queue, position: 0,
  startedAt: now - 600_000, results: [], retries: {},
});
function review(session, { correct = true, hints = 0, rating, stored = null, cardId = session.queue[session.position] } = {}) {
  const result = scheduleReview({
    stored, cardId, rating: rating ?? (correct ? hints ? 2 : 3 : 1), retention: 0.9,
    skill: "spelling", questionType: "spelling", correct, hints, responseMs: 1000,
    errorType: correct ? null : "spelling", answerGiven: correct ? cardId : "wrong", expectedAnswer: cardId,
    now: new Date(session.startedAt + (session.position + 1) * 1000 + (session.revision || 0) * 100),
  });
  return { ...result.event, eventType: "review", eventId: sessionEventId(session) };
}
const restore = (session, events = [], time = now, validIds = new Set(session.queue)) => restoreSession(JSON.stringify(session), validIds, events, time);

// A hinted correct answer needs retrieval practice too, but neither case should
// cause an unbounded loop when the repeated attempt is also wrong.
test("wrong or hinted words recur once, after intervening words, without mutating the checkpoint", () => {
  for (const firstAttempt of [{ correct: false }, { correct: true, hints: 1 }, { correct: true, rating: 1 }]) {
    const original = makeSession();
    const snapshot = structuredClone(original);
    let state = advanceSession(original, review(original, firstAttempt));
    assert.deepEqual(original, snapshot);
    assert.deepEqual(state.queue, ["a", "b", "c", "d", "a", "e", "f"]);
    assert.equal(state.results[0].retry, false);
    while (state.position < 4) state = advanceSession(state, review(state));
    state = advanceSession(state, review(state, { correct: false }));
    assert.equal(state.queue.filter(id => id === "a").length, 2);
    assert.equal(state.results[4].retry, true);
    assert.equal(state.retries.a, 1);
  }
});

test("refresh repairs committed reviews missing from a stale checkpoint and never advances twice", () => {
  const checkpoint = makeSession();
  const first = review(checkpoint, { correct: false });
  const afterFirst = advanceSession(checkpoint, first);
  const second = review(afterFirst);
  const repaired = restore(checkpoint, [first, second]);
  assert.equal(repaired.position, 2);
  assert.deepEqual(repaired.queue, ["a", "b", "c", "d", "a", "e", "f"]);
  assert.equal(repaired.results.length, 2);
  assert.deepEqual(restore(repaired, [first, second]), repaired);
  assert.equal(sessionEventId(repaired), "session-test:2:0");
});

test("a committed undo repairs the old checkpoint and the next answer has a new, usable event id", async () => {
  await clearUserData();
  const original = makeSession(["a", "b"]);
  const first = review(original, { correct: false });
  await commitReview(first);
  const staleAfterSubmit = advanceSession(original, first);
  const undo = { ...first, eventType: "undo", eventId: "undo-committed-before-checkpoint", targetEventId: first.eventId, timestampUtc: new Date(original.startedAt + 2000).toISOString() };
  await commitReview(undo);
  assert.equal(await getOne("cards", "a"), undefined);
  const repaired = restore(staleAfterSubmit, [first, undo]);
  assert.equal(repaired.position, 0);
  assert.equal(repaired.revision, 1);
  assert.deepEqual(repaired.queue, ["a", "b"]);
  const second = review(repaired);
  assert.notEqual(second.eventId, first.eventId);
  await commitReview(second);
  assert.equal((await getAll("events")).length, 3);
  assert.equal((await getOne("cards", "a")).id, "a");
  const afterSecond = advanceSession(repaired, second);
  assert.deepEqual(restore(afterSecond, [first, undo, second]), afterSecond);
});

test("a normal undo revision also repairs a newly submitted answer while keeping earlier reviews", () => {
  const initial = makeSession();
  const a = review(initial);
  const beforeB = advanceSession(initial, a);
  const b = review(beforeB, { correct: false });
  const undo = { ...b, eventType: "undo", eventId: "undo-b", targetEventId: b.eventId };
  const afterUndo = { ...beforeB, revision: 1 };
  const correctedB = review(afterUndo);
  const recovered = restore(afterUndo, [a, b, undo, correctedB]);
  assert.equal(recovered.position, 2);
  assert.equal(recovered.revision, 1);
  assert.deepEqual(recovered.results.map(result => [result.wordId, result.correct]), [["a", true], ["b", true]]);
  assert.equal(recovered.queue.filter(id => id === "b").length, 1);
  assert.equal(sessionEventId(recovered), "session-test:2:1");
});

test("corrupt, inconsistent, unknown-word and expired checkpoints are rejected", () => {
  const valid = makeSession();
  const broken = [
    null,
    { ...valid, id: "bad:id" },
    { ...valid, mode: "unknown" },
    { ...valid, queue: ["a", "missing"] },
    { ...valid, position: 1 },
    { ...valid, position: -1 },
    { ...valid, revision: -1 },
    { ...valid, revision: 0.5 },
    { ...valid, retries: [] },
    { ...valid, retries: { a: 2 } },
    { ...valid, queue: ["a", "a"] },
    { ...valid, queue: ["a", "a"], retries: { a: 1 } },
    { ...valid, position: 1, results: [{ wordId: "b", correct: true, answer: "b", expected: "b", retry: false }] },
    { ...valid, position: 1, results: [{ wordId: "a", correct: true, answer: "a", expected: "a", retry: true }] },
    { ...valid, finishedAt: "invalid" },
    { ...valid, finishedAt: now - 1000 },
    { ...valid, startedAt: now + 1 },
    { ...valid, startedAt: now - 86_400_001 },
  ];
  for (const checkpoint of broken) assert.equal(restoreSession(JSON.stringify(checkpoint), new Set(valid.queue), [], now), null);
  for (const raw of [null, "", "{", "x".repeat(150_001)]) assert.equal(restoreSession(raw, new Set(valid.queue), [], now), null);
  assert.equal(restore(valid, [], NaN), null);
  assert.ok(restore(valid));
});

test("foreign, misordered, missing-history and future reviews cannot move a checkpoint incorrectly", () => {
  const state = makeSession();
  const first = review(state);
  assert.deepEqual(restore(state, [{ ...first, eventId: "other-session:0:0" }]), { ...state, revision: 0 });
  assert.equal(restore(state, [{ ...first, cardId: "b" }]), null);
  assert.equal(restore(state, [{ ...first, timestampUtc: new Date(now + 1).toISOString() }]), null);
  assert.equal(restore(advanceSession(state, first), []), null);
  assert.throws(() => advanceSession(state, { ...first, cardId: "b" }));
  assert.throws(() => advanceSession(state, { ...first, eventType: "undo" }));
});

test("a full 200-word plan remains recoverable after retries grow its queue beyond 200 steps", () => {
  let state = makeSession(Array.from({ length: 200 }, (_, i) => `word-${i}`));
  const events = [];
  const validIds = new Set(state.queue);
  for (let i = 0; i < 180; i++) {
    const event = review(state, { correct: false });
    events.push(event);
    state = advanceSession(state, event);
  }
  assert.ok(state.queue.length > 200 && state.queue.length <= 400);
  assert.equal(state.position, 180);
  const recovered = restore(state, events, now, validIds);
  assert.equal(recovered.position, 180);
  assert.deepEqual(recovered.queue, state.queue);
  assert.ok([...validIds].every(id => state.queue.filter(word => word === id).length <= 2));
});

test("a fully committed session is not offered as unfinished after refresh", () => {
  const checkpoint = makeSession(["a", "b"]);
  const first = review(checkpoint);
  const next = advanceSession(checkpoint, first);
  const last = review(next);
  const finished = advanceSession(next, last);
  assert.equal(finished.position, finished.queue.length);
  assert.equal(finished.finishedAt, Date.parse(last.timestampUtc));
  assert.equal(restore(checkpoint, [first, last]), null);
  assert.equal(restore(finished, [first, last]), null);
  assert.throws(() => advanceSession(finished, last));
});
