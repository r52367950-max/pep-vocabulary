import assert from "node:assert/strict";
import test from "node:test";
import {
  ACQUISITION_LIMITS,
  acknowledgeFsrsPromotion,
  getAcquisitionStats,
  getFsrsPromotionCandidates,
  getNextAcquisitionAction,
  restoreAcquisitionSession,
  serializeAcquisitionSession,
  startAcquisitionSession,
  submitAcquisitionResponse,
} from "../lib/acquisition.ts";

const startedAt = "2026-08-04T08:00:00.000Z";
const words = [
  { wordId: "pep-1e3e7e41accdc5f7", headword: "abandon", meaning: "舍弃；抛弃；放弃" },
  { wordId: "pep-07d418db40de3fe8", headword: "fault", meaning: "弱点；过错" },
];

function answerNext(session, response, now = startedAt) {
  const next = getNextAcquisitionAction(session, now);
  assert.equal(next.kind, "action");
  return submitAcquisitionResponse(session, {
    actionId: next.action.id,
    wordId: next.action.wordId,
    ...response(next),
  }, now);
}

test("acquisition follows preview, recall, spelling, production and delayed retest before FSRS", () => {
  let session = startAcquisitionSession(words, { sessionId: "acq-test", now: startedAt, delayMs: 60_000 });
  assert.deepEqual(session.queue.map((action) => `${action.stage}:${action.wordId}`), [
    `preview:${words[0].wordId}`,
    `preview:${words[1].wordId}`,
    `cue-recall:${words[0].wordId}`,
    `cue-recall:${words[1].wordId}`,
  ]);

  const original = session;
  ({ session } = answerNext(session, () => ({})));
  assert.equal(original.items[0].previewed, false, "state transitions must not mutate the persisted input");
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({ judgment: "pass" })));
  ({ session } = answerNext(session, () => ({ judgment: "pass" })));
  ({ session } = answerNext(session, (next) => ({ answer: next.item.headword })));
  ({ session } = answerNext(session, (next) => ({ answer: next.item.headword })));
  ({ session } = answerNext(session, (next) => ({
    answer: next.item.wordId === words[0].wordId
      ? "They will abandon the old plan today."
      : "This fault caused the whole system to stop.",
  })));
  ({ session } = answerNext(session, (next) => ({
    answer: next.item.wordId === words[0].wordId
      ? "They will abandon the old plan today."
      : "This fault caused the whole system to stop.",
  })));

  assert.deepEqual(getNextAcquisitionAction(session, startedAt), {
    kind: "waiting",
    resumeAt: "2026-08-04T08:01:00.000Z",
  });
  assert.deepEqual(getFsrsPromotionCandidates(session), [], "passing immediate steps must not create a review candidate");

  const retestAt = "2026-08-04T08:01:00.000Z";
  ({ session } = answerNext(session, (next) => ({ answer: next.item.headword }), retestAt));
  ({ session } = answerNext(session, (next) => ({ answer: next.item.headword }), retestAt));
  assert.equal(getNextAcquisitionAction(session, retestAt).kind, "complete");
  assert.deepEqual(getFsrsPromotionCandidates(session), [
    { wordId: words[0].wordId, acquiredAt: retestAt },
    { wordId: words[1].wordId, acquiredAt: retestAt },
  ]);

  session = acknowledgeFsrsPromotion(session, words[0].wordId, retestAt);
  assert.deepEqual(getFsrsPromotionCandidates(session), [{ wordId: words[1].wordId, acquiredAt: retestAt }]);
  const stats = getAcquisitionStats(session, retestAt);
  assert.deepEqual({ total: stats.total, graduated: stats.graduated, promoted: stats.promoted, needsSupport: stats.needsSupport }, {
    total: 2, graduated: 1, promoted: 1, needsSupport: 0,
  });
  assert.equal(stats.accuracy, 1);
});

test("repeated failure ends in needs-support and never becomes an FSRS review candidate", () => {
  let session = startAcquisitionSession([words[0]], {
    sessionId: "acq-failure",
    now: startedAt,
    delayMs: 30_000,
    maxAttemptsPerStage: 2,
  });
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({ judgment: "fail" })));
  let next = getNextAcquisitionAction(session, startedAt);
  assert.equal(next.kind, "action");
  assert.equal(next.action.stage, "preview");
  assert.equal(next.action.remediation, true);
  ({ session } = answerNext(session, () => ({})));
  const failed = answerNext(session, () => ({ judgment: "fail" }));
  session = failed.session;

  assert.equal(failed.outcome.needsSupport, true);
  assert.equal(getNextAcquisitionAction(session, startedAt).kind, "complete");
  assert.deepEqual(getFsrsPromotionCandidates(session), []);
  assert.deepEqual(getAcquisitionStats(session, startedAt).fsrsReadyWordIds, []);
  assert.throws(() => acknowledgeFsrsPromotion(session, words[0].wordId, startedAt), /尚未完成背诵/);
});

test("production has a bounded local gate and answers are not retained in recoverable progress", () => {
  let session = startAcquisitionSession([words[0]], { sessionId: "acq-production", now: startedAt, delayMs: 30_000 });
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({ judgment: "pass" })));
  ({ session } = answerNext(session, () => ({ answer: "abandon" })));
  let result = answerNext(session, () => ({ answer: "They changed the old plan today." }));
  session = result.session;
  assert.equal(result.outcome.reason, "production-missing-target");
  ({ session } = answerNext(session, () => ({})));
  const uniqueAnswer = "They decided to abandon the unusually expensive plan.";
  result = answerNext(session, () => ({ answer: uniqueAnswer }));
  session = result.session;
  assert.equal(result.outcome.reason, "valid-production");
  assert.doesNotMatch(serializeAcquisitionSession(session), /unusually expensive/);
  assert.equal(session.history.at(-1).responseLength, uniqueAnswer.length);
});

test("serialization restores a canonical bounded session and rejects tampering", () => {
  let session = startAcquisitionSession(words, { sessionId: "acq-restore", now: startedAt, delayMs: 60_000 });
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({ judgment: "pass" })));
  const serialized = serializeAcquisitionSession(session);
  const restored = restoreAcquisitionSession(serialized);
  assert.deepEqual(restored, session);
  assert.deepEqual(getNextAcquisitionAction(restored, startedAt), getNextAcquisitionAction(session, startedAt));

  const tampered = JSON.parse(serialized);
  tampered.queue[0].wordId = "unknown-word";
  assert.throws(() => restoreAcquisitionSession(tampered), /未知词条/);
  const forgedGraduation = JSON.parse(serializeAcquisitionSession(startAcquisitionSession([words[0]], {
    sessionId: "acq-forged",
    now: startedAt,
    delayMs: 60_000,
  })));
  forgedGraduation.updatedAt = "2026-08-04T08:01:00.000Z";
  forgedGraduation.items[0].status = "graduated";
  forgedGraduation.items[0].previewed = true;
  forgedGraduation.items[0].completed = {
    "cue-recall": true,
    spelling: true,
    production: true,
    "delayed-recall": true,
  };
  forgedGraduation.items[0].attempts = {
    "cue-recall": 1,
    spelling: 1,
    production: 1,
    "delayed-recall": 1,
  };
  forgedGraduation.items[0].correct = {
    "cue-recall": 1,
    spelling: 1,
    production: 1,
    "delayed-recall": 1,
  };
  forgedGraduation.items[0].graduatedAt = "2026-08-04T08:01:00.000Z";
  forgedGraduation.queue = [];
  assert.throws(() => restoreAcquisitionSession(forgedGraduation), /历史重放|历史长度|毕业时间/);
  const mismatchedReason = JSON.parse(serialized);
  mismatchedReason.history[0].reason = "delayed-recall-passed";
  assert.throws(() => restoreAcquisitionSession(mismatchedReason), /历史原因/);
  assert.throws(() => restoreAcquisitionSession("x".repeat(ACQUISITION_LIMITS.maxSerializedBytes + 1)), /过大/);
});

test("batch and response limits fail closed", () => {
  assert.throws(() => startAcquisitionSession([], { now: startedAt }), /每批/);
  assert.throws(() => startAcquisitionSession(Array.from({ length: 9 }, (_, index) => ({
    wordId: `word-${index}`, headword: `word${index}`, meaning: "含义",
  })), { now: startedAt }), /每批/);
  assert.throws(() => startAcquisitionSession([words[0], words[0]], { now: startedAt }), /重复词条/);
  assert.throws(() => startAcquisitionSession([{ ...words[0], meaning: "义".repeat(241) }], { now: startedAt }), /核心义/);

  let session = startAcquisitionSession([words[0]], { sessionId: "acq-answer-limit", now: startedAt, delayMs: 30_000 });
  ({ session } = answerNext(session, () => ({})));
  ({ session } = answerNext(session, () => ({ judgment: "pass" })));
  const next = getNextAcquisitionAction(session, startedAt);
  assert.equal(next.kind, "action");
  assert.throws(() => submitAcquisitionResponse(session, {
    actionId: next.action.id,
    wordId: next.action.wordId,
    answer: "a".repeat(ACQUISITION_LIMITS.maxHeadwordLength + 1),
  }, startedAt), /作答长度/);
});
