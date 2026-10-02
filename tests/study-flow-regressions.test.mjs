import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { gradeQuestion } from "../lib/questions.ts";
import { scheduleReview } from "../lib/scheduler.ts";
import { clearUserData, commitReview, getAll, getOne } from "../lib/storage.ts";
import { prepareStudyQuestion } from "../lib/study-question.ts";
import { studyShortcut } from "../lib/study-controls.ts";

const now = new Date("2026-10-02T12:00:00Z");
const entry = {
  id: "ability", headword: "ability", lookup: "ability", chineseCore: "能力；才能",
  scopes: ["high-required"], sources: [{ bookId: "HS-R1", unit: "Unit 1", printedPage: 1 }],
  partsOfSpeech: ["n"], britishIpa: "", americanIpa: "", tier: "A",
  flags: { properName: false, highValue: false },
};
const base = {
  stepId: "study:0:0", session: { mode: "daily", results: [] }, entry,
  detail: undefined, card: undefined, pool: [entry], ready: true,
};
const review = (stored, skill = "meaning", extra = {}) => scheduleReview({
  stored, cardId: entry.id, rating: 3, retention: .9, skill,
  questionType: skill === "output" ? "sentence-output" : "meaning-recall",
  correct: true, responseMs: 1000, hints: 0, errorType: null, now, ...extra,
});
function familiarCard() {
  const first = review(null).after;
  return review(first, "spelling").after;
}

test("optional sentence output cannot replace the displayed question or its committed grading metadata", async () => {
  await clearUserData();
  const first = review(null, "meaning", { now: new Date(now.getTime() - 120000) });
  await commitReview(first.event);
  const second = review(first.after, "spelling", { now: new Date(now.getTime() - 60000) });
  await commitReview(second.event);
  const snapshot = prepareStudyQuestion(null, { ...base, card: second.after });
  assert.equal(snapshot.question.type, "spelling", "missing context is honestly downgraded");
  assert.equal(gradeQuestion(snapshot.question, "ability"), true);

  const output = review(second.after, "output", { answerGiven: "I have the ability to learn English." });
  await commitReview(output.event);
  const latest = await getOne("cards", entry.id);
  assert.equal(latest.fsrs.reps, 3);
  const same = prepareStudyQuestion(snapshot, { ...base, card: latest });
  assert.equal(same, snapshot);
  const { question } = same;
  const main = review(latest, question.skill, {
    questionType: question.type, prompt: question.prompt, answerGiven: "ability",
    expectedAnswer: question.answer, correct: gradeQuestion(question, "ability"),
  });
  await commitReview(main.event);
  assert.equal(main.event.before.fsrs.reps, 3, "the main review still uses the latest card");
  assert.equal(main.after.fsrs.reps, 4);
  assert.equal(main.event.questionType, "spelling");
  assert.equal(main.event.skill, "spelling");
  assert.equal(main.event.expectedAnswer, "ability");
  assert.equal(main.event.correct, true);
  assert.equal((await getAll("events")).length, 4);
});

test("late card updates and dictionary details cannot change an active exercise; the next step uses them", () => {
  const card = familiarCard();
  assert.equal(prepareStudyQuestion(null, { ...base, card, ready: false }), null);
  const snapshot = prepareStudyQuestion(null, { ...base, card });
  const detail = { id: entry.id, openExample: "Her ability to learn new languages is impressive." };
  const changedCard = review(card, "output").after;
  assert.equal(prepareStudyQuestion(snapshot, { ...base, card: changedCard, detail }), snapshot);
  assert.equal(snapshot.question.type, "spelling");
  assert.equal(snapshot.question.answer, "ability");
  const next = prepareStudyQuestion(snapshot, { ...base, stepId: "study:1:0", card: changedCard, detail });
  assert.equal(next.question.type, "meaning-recall");
  const undo = prepareStudyQuestion(next, { ...base, stepId: "study:0:1", card, detail });
  assert.equal(undo.question.type, "context-gap", "an undone position is a fresh question checkpoint");
  assert.match(undo.question.prompt, /____/);
});

test("normal question rotation, deliberate modes and retries keep their current behavior", () => {
  let card;
  assert.equal(prepareStudyQuestion(null, { ...base, card }).question.type, "meaning-recall");
  card = review(null).after;
  assert.equal(prepareStudyQuestion(null, { ...base, card }).question.type, "spelling");
  card = familiarCard();
  for (const [mode, expected] of [["dictation", "dictation"], ["context", "spelling"], ["mistakes", "spelling"]])
    assert.equal(prepareStudyQuestion(null, { ...base, card, session: { mode, results: [] } }).question.type, expected);
  assert.equal(prepareStudyQuestion(null, {
    ...base, card: review(card).after, session: { mode: "daily", results: [{ wordId: entry.id }] },
  }).question.type, "spelling");
});

const key = (value, extra = {}) => ({
  key: value, code: value === " " ? "Space" : `Key${value.toUpperCase()}`,
  repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, ...extra,
});
const controls = { revealed: true, correct: true, busy: false, editing: false, button: true };

test("rating, playback and undo shortcuts work on the auto-focused rating button", () => {
  for (const value of ["1", "2", "3", "4"])
    assert.deepEqual(studyShortcut(key(value), controls), { action: "rate", rating: Number(value) });
  assert.deepEqual(studyShortcut(key("R"), controls), { action: "play" });
  assert.deepEqual(studyShortcut(key("z"), controls), { action: "undo" });
  assert.equal(studyShortcut(key(" "), controls), null, "Space on a button must activate only its native click");
  assert.equal(studyShortcut(key("Enter"), controls), null);
  assert.deepEqual(studyShortcut(key(" "), { ...controls, button: false }), { action: "rate", rating: 3 });
  assert.deepEqual(studyShortcut(key(" "), { ...controls, button: false, correct: false }), { action: "rate", rating: 1 });
  assert.deepEqual(studyShortcut(key(" "), { ...controls, button: false, revealed: false }), { action: "check" });
});

test("study shortcuts preserve editing, composition, held-key and modifier protections", () => {
  for (const value of ["1", "r", "z", " "]) {
    for (const flag of ["repeat", "isComposing", "ctrlKey", "metaKey", "altKey"])
      assert.equal(studyShortcut(key(value, { [flag]: true }), controls), null);
    assert.equal(studyShortcut(key(value), { ...controls, busy: true }), null);
    assert.equal(studyShortcut(key(value), { ...controls, editing: true }), null);
  }
  assert.equal(studyShortcut(key("1"), { ...controls, revealed: false }), null);
});
