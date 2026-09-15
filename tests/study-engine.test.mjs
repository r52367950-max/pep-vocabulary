import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { blankTarget, buildQuestion, getEntryExample, gradeQuestion, localSentenceCheck, normalizeAnswer } from "../lib/questions.ts";
import { BOOKS, buildStudyQueue, effectiveRating, getBookUnits, selectEntries, summarizeStudy } from "../lib/study.ts";
import { READINGS, ORIGINAL_EXAMPLES, findReadingTargets, readingWordCount } from "../lib/reading.ts";
import { newStoredCard, scheduleReview } from "../lib/scheduler.ts";

const now = new Date("2026-09-15T12:00:00Z");
const source = (bookId, unit = "Unit 1", printedPage = 1) => ({ bookId, unit, printedPage, volume: bookId });
const entry = (id, sources = [source("HS-R1")], headword = id) => ({
  id, headword, lookup: headword, chineseCore: `中文释义${id === "apple" ? "苹果" : ""}`,
  scopes: ["high-required"], sources, partsOfSpeech: [], britishIpa: "", americanIpa: "", tier: "A",
  flags: { highFrequencyContinuation: false, highValue: false, properName: false, formalReleaseEligible: true },
});
const card = (id, status, due = now.toISOString(), overrides = {}) => ({
  ...newStoredCard(id, now), status, due,
  lastReviewed: status === "unseen" ? null : "2026-09-14T12:00:00Z", ...overrides,
});
const ids = (entries) => entries.map((entry) => entry.id);

test("book and unit must match the same source, with exact unit names", () => {
  const cross = entry("cross", [source("HS-R1", "Unit 1"), source("HS-R2", "Unit 2")]);
  const exact = entry("exact", [source("HS-R1", "Unit 2")]);
  const wrongUnit = entry("ten", [source("HS-R1", "Unit 12")]);
  const entries = [cross, exact, wrongUnit, exact];
  assert.deepEqual(ids(selectEntries(entries, { bookId: "HS-R1", unit: "Unit 2" })), ["exact"]);
  assert.deepEqual(ids(selectEntries(entries, { bookIds: ["HS-R2"], unit: "Unit 2" })), ["cross"]);
  assert.deepEqual(selectEntries(entries, { bookIds: [] }), []);
  assert.deepEqual(selectEntries(entries, { bookId: "missing" }), []);
  assert.deepEqual(ids(selectEntries(entries, { bookId: "HS-R1", bookIds: [] })), ["cross", "exact", "ten"]);
});

test("unit menus preserve Welcome/Starter units and sort numbered units naturally", () => {
  const units = ["Unit 10", "Unit 2", "Starter Unit 2", "Welcome Unit", "Unit 1", "Starter Unit 1"];
  const entries = units.map((unit) => entry(unit, [source("HS-R1", unit)]));
  entries.push(entry("other", [source("HS-R2", "Unit 3")]));
  assert.deepEqual(getBookUnits(entries, "HS-R1"), ["Welcome Unit", "Starter Unit 1", "Starter Unit 2", "Unit 1", "Unit 2", "Unit 10"]);
});

test("daily queues prioritise overdue cards, respect scope and cap new words", () => {
  const entries = ["new-a", "due-recent", "paused", "new-b", "due-old", "future", "unseen"].map((id) => entry(id));
  entries.push(entry("other-book", [source("HS-R2")]));
  const cards = [
    card("due-recent", "learning", "2026-09-15T09:00:00Z"), card("due-old", "weak", "2026-09-13T09:00:00Z"),
    card("paused", "paused"), card("future", "learning", "2026-10-01T00:00:00Z"),
    card("unseen", "unseen"), card("other-book", "weak", "2026-09-01T00:00:00Z"),
  ];
  const options = { bookId: "HS-R1", mode: "daily", limit: 6, newLimit: 1, now };
  assert.deepEqual(ids(buildStudyQueue(entries, cards, options)), ["due-old", "due-recent", "new-a"]);
  assert.deepEqual(buildStudyQueue(entries, new Map(cards.map((c) => [c.id, c])), options), buildStudyQueue(entries, cards, options));
  assert.deepEqual(ids(buildStudyQueue(entries, cards, { ...options, limit: 1 })), ["due-old"]);
});

test("due backlog uses the time budget before adding new material", () => {
  const entries = ["due", "new"].map((id) => entry(id));
  assert.deepEqual(ids(buildStudyQueue(entries, [card("due", "learning")], { now, dailyMinutes: 1, newLimit: 20 })), ["due"]);
  assert.deepEqual(buildStudyQueue(entries, [], { now, newLimit: 0 }), []);
  assert.deepEqual(buildStudyQueue(entries, [], { now, limit: NaN }), []);
  assert.deepEqual(buildStudyQueue(entries, [], { now: new Date("invalid") }), []);
});

test("review only excludes new, future, paused and invalid-date cards", () => {
  const entries = ["due", "future", "paused", "new", "invalid"].map((id) => entry(id));
  const cards = [card("due", "learning"), card("future", "learning", "2026-10-01T00:00:00Z"), card("paused", "paused"), card("invalid", "learning", "invalid")];
  assert.deepEqual(ids(buildStudyQueue(entries, cards, { mode: "review", now })), ["due"]);
});

test("mistake practice uses current weak state and does not revive historical mistakes", () => {
  const entries = ["weak", "recovered", "new", "paused"].map((id) => entry(id));
  const cards = [card("weak", "weak", "2026-09-16T00:00:00Z"), card("recovered", "learning"), card("paused", "paused")];
  const queue = buildStudyQueue(entries, cards, { now, mode: "mistakes", mistakeIds: new Set(["recovered", "new", "paused"]) });
  assert.deepEqual(new Set(ids(queue)), new Set(["weak", "new"]));
});

test("dictation includes due, current mistakes and a bounded number of new words", () => {
  const entries = ["new-a", "new-b", "new-c", "known", "weak", "due"].map((id) => entry(id));
  const cards = [card("due", "learning"), card("weak", "weak", "2026-10-01T00:00:00Z"), card("known", "learning", "2026-10-01T00:00:00Z")];
  assert.deepEqual(ids(buildStudyQueue(entries, cards, { now, mode: "dictation", limit: 10, newLimit: 1 })), ["due", "weak", "new-a", "known"]);
});

test("context queues contain words with usable examples, plus explicitly verified external examples", () => {
  const entries = [entry("observe"), entry("lantern"), entry("no-context")];
  assert.deepEqual(ids(buildStudyQueue(entries, [], { now, mode: "context" })), ["observe"]);
  assert.deepEqual(ids(buildStudyQueue(entries, [], { now, mode: "context", contextIds: new Set(["lantern"]) })), ["lantern", "observe"]);
});

test("new practice excludes known and paused words, and progress uses the same scope", () => {
  const entries = ["new", "unseen", "known", "paused", "weak"].map((id) => entry(id));
  entries.push({ ...entry("name"), flags: { properName: true } });
  entries.push(entry("other", [source("HS-R2")]));
  const cards = [card("unseen", "unseen"), card("known", "mastered", "2026-10-01T00:00:00Z"), card("paused", "paused"), card("weak", "weak")];
  assert.deepEqual(ids(buildStudyQueue(entries, cards, { mode: "new", now, bookId: "HS-R1" })), ["new", "unseen"]);
  assert.deepEqual(summarizeStudy(entries, cards, { now, bookId: "HS-R1" }), { total: 5, new: 2, due: 1, weak: 1, learned: 2, mastered: 1, paused: 1 });
});

test("definitions and unrelated examples cannot become fake context exercises", () => {
  const lantern = entry("lantern");
  for (const openExample of [null, "", "   ", "The sun sets beside the river.", "lantern"]) {
    const detail = { ...lantern, englishCore: "A lantern is a lamp with a transparent case.", openExample };
    const question = buildQuestion(lantern, detail, "context-choice", [lantern]);
    assert.equal(question.type, "spelling");
    assert.equal(question.skill, "spelling");
    assert.equal(question.requestedType, "context-choice");
    assert.ok(question.fallbackReason);
    assert.equal(getEntryExample(lantern, detail), undefined);
    assert.doesNotMatch(question.prompt, /lantern/i);
  }
});

test("real external examples mask every complete target occurrence without substring matches", () => {
  const lantern = entry("lantern");
  const question = buildQuestion(lantern, { ...lantern, openExample: "A lantern stood beside another lantern." }, "context-choice", [lantern]);
  assert.equal(question.type, "context-gap");
  assert.equal(question.skill, "context");
  assert.equal(question.prompt, "A ____ stood beside another ____.");
  assert.equal(gradeQuestion(question, "LANTERN"), true);
  assert.equal(blankTarget("The theater opens every evening.", "he"), null);
  assert.equal(blankTarget("Ice cream is best when the ice cream is fresh.", "ice cream"), "____ is best when the ____ is fresh.");
  assert.equal(blankTarget("He said hello.", "he"), "____ said hello.");
});

test("unavailable advanced exercises change their actual type and scored skill", () => {
  const lantern = entry("lantern");
  for (const requested of ["word-form", "family-conversion", "confusable", "natural-expression", "textbook-context", "collocation-gap"]) {
    const question = buildQuestion(lantern, undefined, requested, [lantern]);
    assert.equal(question.type, "spelling", requested);
    assert.equal(question.skill, "spelling", requested);
    assert.equal(question.requestedType, requested);
  }
  assert.equal(buildQuestion(lantern, undefined, "paragraph-retell", [lantern]).type, "sentence-output");
  assert.equal(buildQuestion(lantern, undefined, "phrase-dictation", [lantern]).type, "dictation");
  assert.equal(buildQuestion(lantern, undefined, "listening-choice", [lantern]).type, "dictation");
});

test("phrase gaps practise a real phrase and never display a repeated answer token", () => {
  const phrase = entry("take part in");
  const question = buildQuestion(phrase, undefined, "collocation-gap", []);
  assert.equal(question.prompt, "take part ____");
  assert.equal(question.answer, "in");
  assert.equal(question.skill, "collocation");
  assert.equal(gradeQuestion(question, "on"), false);
  assert.equal(buildQuestion(entry("from time to time"), undefined, "collocation-gap", []).type, "spelling");
});

test("answer normalization handles typography without removing meaningful punctuation", () => {
  assert.equal(normalizeAnswer("  ＩＣＥ   ＣＲＥＡＭ  "), "ice cream");
  const question = buildQuestion(entry("ice cream"), undefined, "spelling", []);
  assert.equal(gradeQuestion(question, "ＩＣＥ   ＣＲＥＡＭ"), true);
  for (const response of ["ice!cream", "ice-cream", "ice, cream", "ice cream.", "", "!!!"]) assert.equal(gradeQuestion(question, response), false, response);
  const contraction = buildQuestion(entry("can't"), undefined, "dictation", []);
  assert.equal(gradeQuestion(contraction, "CAN’T"), true);
  assert.equal(gradeQuestion(contraction, "cant"), false);
  assert.equal(normalizeAnswer("well‑being"), "well-being");
});

test("objective errors and hinted responses cannot receive an inflated review rating", () => {
  const question = buildQuestion(entry("apple"), undefined, "spelling", []);
  const correct = gradeQuestion(question, "pear");
  const rating = effectiveRating({ rating: 4, correct, hints: 0 });
  const result = scheduleReview({ stored: null, cardId: "apple", rating, correct, hints: 0, skill: question.skill, questionType: question.type, retention: 0.9, responseMs: 1000, errorType: "spelling", now });
  assert.equal(result.event.rating, 1);
  assert.equal(result.after.status, "weak");
  assert.equal(result.after.skills.spelling, 0);
  assert.equal(effectiveRating({ rating: 4, correct: true, hints: 1 }), 2);
  assert.equal(effectiveRating({ rating: 3, correct: null, hints: 1 }), 2);
  assert.equal(effectiveRating({ rating: 4, correct: true, hints: 0 }), 4);
});

test("sentence length hints do not pretend to verify grammar or correctness", () => {
  assert.equal(localSentenceCheck("I went to the theater yesterday.", "he").hasTarget, false);
  assert.equal(localSentenceCheck("He, however, preferred the other book.", "he").hasTarget, true);
  const question = buildQuestion(entry("apple"), undefined, "sentence-output", []);
  assert.equal(gradeQuestion(question, "Apple apple apple apple apple."), null);
  assert.match(localSentenceCheck("Apple apple apple apple apple.", "apple").message, /仍需自行核对/);
});

test("six original readings have translations, supported target words and answer explanations", async () => {
  const index = JSON.parse(await readFile(new URL("../public/data/v1/index.json", import.meta.url), "utf8"));
  const books = new Set(BOOKS.map((book) => book.id));
  assert.ok(index.flatMap((entry) => entry.sources).every((source) => books.has(source.bookId)));
  assert.equal(READINGS.length, 6);
  for (const article of READINGS) {
    assert.ok(readingWordCount(article) >= 80 && readingWordCount(article) <= 130, article.title);
    assert.match(article.source, /原创.*非教材原文/);
    assert.ok(article.paragraphs.every((paragraph) => paragraph.en && paragraph.zh));
    assert.equal(findReadingTargets(article, index).length, article.targets.length, article.title);
    assert.ok(article.questions.length >= 2);
    for (const question of article.questions) {
      assert.ok(question.options[question.answerIndex]);
      assert.ok(question.explanation);
      assert.equal(new Set(question.options).size, question.options.length);
    }
  }
});

test("original context examples have one correct choice and do not expose it in the prompt", () => {
  assert.ok(ORIGINAL_EXAMPLES.length >= 30 && ORIGINAL_EXAMPLES.length <= 60);
  for (const example of ORIGINAL_EXAMPLES) {
    const question = buildQuestion(entry(example.word), undefined, "context-choice", []);
    assert.equal(question.type, "context-choice", example.word);
    assert.equal(question.exampleSource, "词迹原创");
    assert.equal(question.choices.length, 4, example.word);
    assert.equal(question.choices.filter((choice) => gradeQuestion(question, choice)).length, 1, example.word);
    assert.equal(blankTarget(question.prompt, example.word), null, example.word);
    assert.equal(gradeQuestion(question, example.word), true);
    assert.ok(question.hint && !question.support.includes(example.word));
  }
});
