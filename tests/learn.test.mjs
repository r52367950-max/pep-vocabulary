import assert from "node:assert/strict";
import test from "node:test";
import { getEntryExample } from "../lib/questions.ts";
import { repairMeaning } from "../lib/lexicon.ts";
import {
  FLASH_DECK_SIZE,
  MATCH_PAIRS,
  MATCH_ROUNDS,
  QUIZ_MAX,
  buildFlashDeck,
  buildMatchRounds,
  buildQuizPlan,
  buildQuizQuestion,
  createRandom,
  decideFlash,
  flashDone,
  formatClock,
  learnPool,
  project,
  quizDistractorPool,
  quizKinds,
  quizLength,
  rubberband,
  scoreQuiz,
  shortMeaning,
  shuffle,
  springAt,
  startFlash,
  summarizeFlash,
  summarizeMatch,
  swipeDecision,
  undoFlash,
} from "../lib/learn.ts";
import { normalizeAnswer } from "../lib/questions.ts";
import { newStoredCard } from "../lib/scheduler.ts";

const now = new Date("2026-09-15T12:00:00Z");
const source = (bookId = "HS-R1", unit = "Unit 1", printedPage = 1) => ({
  bookId, unit, printedPage, volume: bookId,
});
const entry = (id, { page = 1, unit = "Unit 1", book = "HS-R1", meaning = `释义${id}`, headword = id, properName = false } = {}) => ({
  id, headword, lookup: headword, chineseCore: meaning, scopes: ["high-required"],
  sources: [source(book, unit, page)], partsOfSpeech: ["n"], britishIpa: "", americanIpa: "", tier: "A",
  flags: { highFrequencyContinuation: false, highValue: false, properName, formalReleaseEligible: true },
});
const card = (id, status, due = now.toISOString(), lastReviewed = "2026-09-14T12:00:00Z") => ({
  ...newStoredCard(id, now), status, due, lastReviewed: status === "unseen" ? null : lastReviewed,
});
const cardsOf = (...list) => new Map(list.map((c) => [c.id, c]));
const ids = (list) => list.map((item) => item.id);
const selection = { bookId: "HS-R1", unit: "Unit 1" };

test("seeded shuffles are deterministic and keep every item", () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const a = shuffle(items, createRandom("seed"));
  assert.deepEqual(a, shuffle(items, createRandom("seed")));
  assert.notDeepEqual(a, shuffle(items, createRandom("other")));
  assert.deepEqual([...a].sort((x, y) => x - y), items);
  assert.deepEqual(items, Array.from({ length: 30 }, (_, i) => i), "input is not mutated");
});

test("the shared pool drops paused cards, proper names and other units, in page order", () => {
  const entries = [
    entry("late", { page: 9 }), entry("early", { page: 2 }), entry("paused"),
    entry("London", { properName: true }), entry("elsewhere", { unit: "Unit 2" }),
    entry("other-book", { book: "HS-R2" }),
  ];
  const pool = learnPool(entries, cardsOf(card("paused", "paused")), selection);
  assert.deepEqual(ids(pool), ["early", "late"]);
});

test("flash deck: unseen words first, then weak or due, then the rest", () => {
  const entries = ["known", "weak", "fresh-b", "due-old", "due-new", "fresh-a", "paused", "future"]
    .map((id, i) => entry(id, { page: i + 1 }));
  entries.push(entry("Paris", { properName: true, page: 0 }));
  const cards = cardsOf(
    card("known", "mastered", "2026-12-01T00:00:00Z"),
    card("weak", "weak", "2026-12-01T00:00:00Z"),
    card("due-old", "learning", "2026-09-01T00:00:00Z"),
    card("due-new", "learning", "2026-09-14T00:00:00Z"),
    card("paused", "paused"),
    card("future", "learning", "2026-10-01T00:00:00Z"),
    card("fresh-b", "unseen"),
  );
  const deck = buildFlashDeck(entries, cards, { ...selection, now });
  assert.deepEqual(ids(deck), ["fresh-b", "fresh-a", "due-old", "due-new", "weak", "known", "future"]);
  assert.equal(buildFlashDeck(entries, cards, { ...selection, now, limit: 3 }).length, 3);
  // Words already seen this sitting sink to the end, so "another set" moves on.
  const next = buildFlashDeck(entries, cards, { ...selection, now, exclude: new Set(["fresh-b", "fresh-a"]) });
  assert.deepEqual(ids(next).slice(0, 2), ["due-old", "due-new"]);
  assert.deepEqual(ids(next).slice(-2), ["fresh-b", "fresh-a"]);
  const many = Array.from({ length: 50 }, (_, i) => entry(`w${i}`, { page: i }));
  assert.equal(buildFlashDeck(many, new Map(), { ...selection, now }).length, FLASH_DECK_SIZE);
});

test("flash reducer: 再看看 returns once near the end, and undo reverses it exactly", () => {
  let state = startFlash([{ id: "a" }, { id: "b" }, { id: "c" }]);
  state = decideFlash(state, false); // a: again
  assert.deepEqual(state.queue.map((item) => item.key), ["a", "b", "c", "a#again"]);
  const beforeUndo = state;
  state = undoFlash(state);
  assert.deepEqual(state, startFlash([{ id: "a" }, { id: "b" }, { id: "c" }]));
  state = decideFlash(beforeUndo, true); // b: known
  state = decideFlash(state, false); // c: again
  state = decideFlash(state, false); // a again: still unsure, but no third showing
  assert.equal(state.queue.length, 5);
  state = decideFlash(state, true); // c again
  assert.ok(flashDone(state));
  assert.deepEqual(decideFlash(state, true), state, "a finished deck ignores further decisions");
  assert.deepEqual(summarizeFlash(state), { known: ["b"], review: ["a", "c"] });
  const undone = undoFlash(state);
  assert.equal(undone.position, 4);
  assert.equal(undone.queue[undone.position].key, "c#again", "the last card comes back to the top");
  assert.equal(undone.queue.length, 5, "undoing a second look keeps the deck");
  assert.deepEqual(undoFlash(startFlash([{ id: "x" }])), startFlash([{ id: "x" }]));
});

test("short meanings drop POS labels, notes and broken brackets", () => {
  assert.equal(shortMeaning("成年人 adj. 成年的；成熟的"), "成年人");
  assert.equal(shortMeaning("前进；发展 vi. 前进；发展 vt. 发展；促进"), "前进；发展");
  assert.equal(shortMeaning("n. 行政, 管理, 政府机关\\n[化] 给药"), "行政；管理");
  assert.equal(shortMeaning("尤指外语）流利的；熟练的"), "流利的；熟练的");
  assert.equal(shortMeaning("滥用；虐待；辱骂 /bjuz/ vt. 滥用"), "滥用；虐待");
  assert.equal(shortMeaning("吸引；引起……的注意（或兴趣）"), "吸引；引起……的注意");
  const long = shortMeaning("一二三四五六七八九十一二三四五六七八九十");
  assert.ok(long.length <= 14 && long.endsWith("…"));
});

test("match rounds: at most 6 pairs and 3 rounds, unique meanings and words, seeded", () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(`w${i}`, { meaning: `意思${i}` }));
  // Near-duplicates: the same gloss, a shared sense, and a repeated headword.
  entries.push(entry("dup-meaning", { meaning: "意思1" }));
  entries.push(entry("shared-sense", { meaning: "意思2；别的" }));
  entries.push(entry("dup-word", { headword: "W3", meaning: "另一个" }));
  const rounds = buildMatchRounds(entries, new Map(), { ...selection, seed: 7 });
  assert.equal(rounds.length, MATCH_ROUNDS);
  const all = rounds.flatMap((round) => round.pairs);
  const senses = all.flatMap((pair) => pair.meaning.split("；").map(normalizeAnswer));
  assert.equal(new Set(senses).size, senses.length, "no two tiles share a sense");
  assert.equal(new Set(all.map((pair) => normalizeAnswer(pair.headword))).size, all.length);
  for (const round of rounds) {
    assert.ok(round.pairs.length <= MATCH_PAIRS && round.pairs.length >= 4);
    assert.deepEqual([...round.left].sort(), ids(round.pairs).sort());
    assert.deepEqual([...round.right].sort(), ids(round.pairs).sort());
    assert.ok(round.left.some((id, i) => round.right[i] !== id), "columns are shuffled independently");
  }
  assert.deepEqual(rounds, buildMatchRounds(entries, new Map(), { ...selection, seed: 7 }));
  assert.notDeepEqual(rounds, buildMatchRounds(entries, new Map(), { ...selection, seed: 8 }));
});

test("match rounds shrink for small units and need at least four words", () => {
  const make = (n) => Array.from({ length: n }, (_, i) => entry(`w${i}`, { meaning: `意思${i}` }));
  assert.deepEqual(buildMatchRounds(make(3), new Map(), { ...selection, seed: 1 }), []);
  const paused = cardsOf(card("w0", "paused"));
  assert.deepEqual(buildMatchRounds(make(4), paused, { ...selection, seed: 1 }), [], "paused words do not count");
  assert.deepEqual(buildMatchRounds(make(4), new Map(), { ...selection, seed: 1 }).map((r) => r.pairs.length), [4]);
  assert.deepEqual(buildMatchRounds(make(7), new Map(), { ...selection, seed: 1 }).map((r) => r.pairs.length), [6]);
  assert.deepEqual(buildMatchRounds(make(8), new Map(), { ...selection, seed: 1 }).map((r) => r.pairs.length), [4, 4]);
  assert.deepEqual(buildMatchRounds(make(13), new Map(), { ...selection, seed: 1 }).map((r) => r.pairs.length), [5, 4, 4]);
  assert.deepEqual(buildMatchRounds(make(40), new Map(), { ...selection, seed: 1 }).map((r) => r.pairs.length), [6, 6, 6]);
});

test("match summary counts both confused words once, and the clock reads mm:ss", () => {
  const rounds = buildMatchRounds(
    Array.from({ length: 12 }, (_, i) => entry(`w${i}`, { meaning: `意思${i}` })),
    new Map(), { ...selection, seed: 3 },
  );
  const summary = summarizeMatch(rounds, [{ left: "w1", right: "w2" }, { left: "w2", right: "w1" }, { left: "w3", right: "w1" }]);
  assert.equal(summary.pairs, 12);
  assert.equal(summary.mistakes, 3);
  assert.deepEqual(summary.mismatchedIds, ["w1", "w2", "w3"]);
  assert.equal(summary.accuracy, 80);
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(65_400), "01:05");
  assert.equal(formatClock(-5), "00:00");
  assert.equal(formatClock(NaN), "00:00");
});

test("quiz length is capped at 40 and never exceeds the selection", () => {
  assert.equal(quizLength(10, 25), 10);
  assert.equal(quizLength(20, 12), 12);
  assert.equal(quizLength("all", 12), 12);
  assert.equal(quizLength("all", 500), QUIZ_MAX);
  assert.equal(quizLength(10, 0), 0);
  const entries = Array.from({ length: 60 }, (_, i) => entry(`word${String.fromCharCode(97 + (i % 26))}${i}`));
  entries.push(entry("Tokyo", { properName: true }));
  const plan = buildQuizPlan(entries, new Map(), { ...selection, length: "all", seed: 5 });
  assert.equal(plan.length, QUIZ_MAX);
  assert.equal(new Set(ids(plan)).size, plan.length, "each word is asked once");
  assert.ok(!ids(plan).includes("Tokyo"));
  assert.deepEqual(plan, buildQuizPlan(entries, new Map(), { ...selection, length: "all", seed: 5 }));
  assert.equal(buildQuizPlan(entries, new Map(), { ...selection, length: 10, seed: 5 }).length, 10);
});

test("quiz plan mixes kinds and only asks what each word supports", () => {
  const entries = [
    entry("challenge", { meaning: "挑战" }), // has a reviewed sentence context
    entry("prefer … to …", { meaning: "喜欢……多于……" }), // not spellable
    ...Array.from({ length: 12 }, (_, i) => entry(`word${String.fromCharCode(97 + i)}`, { meaning: `意思${i}` })),
  ];
  assert.deepEqual(quizKinds(entries[0]), ["meaning-choice", "listening-choice", "spelling", "context-choice"]);
  assert.deepEqual(quizKinds(entries[1], false), ["meaning-choice"]);
  const plan = buildQuizPlan(entries, new Map(), { ...selection, length: "all", seed: 11 });
  const kinds = new Map(plan.map((item) => [item.id, item.kind]));
  assert.equal(kinds.get("challenge"), "context-choice");
  assert.ok(["meaning-choice", "listening-choice"].includes(kinds.get("prefer … to …")));
  const counts = plan.reduce((map, item) => map.set(item.kind, (map.get(item.kind) || 0) + 1), new Map());
  assert.ok(counts.get("meaning-choice") >= 3 && counts.get("listening-choice") >= 3 && counts.get("spelling") >= 3);
  const silent = buildQuizPlan(entries, new Map(), { ...selection, length: "all", seed: 11, audio: false });
  assert.ok(silent.every((item) => item.kind !== "listening-choice"), "no listening without speech");
});

test("quiz questions carry no hints, and meaning choice shows the word", () => {
  const pool = Array.from({ length: 8 }, (_, i) => entry(`word${String.fromCharCode(97 + i)}`, { meaning: `意思${i}` }));
  pool.push(entry("Alberta", { meaning: "艾伯塔省（加拿大省份）" }));
  const distractors = quizDistractorPool(pool);
  assert.ok(!distractors.some((item) => item.id === "Alberta"), "capitalised names are not distractors");
  const target = pool[0];
  const meaning = buildQuizQuestion(target, "meaning-choice", distractors);
  assert.equal(meaning.prompt, target.headword);
  assert.equal(meaning.answer, target.chineseCore);
  assert.equal(meaning.audio, false);
  assert.equal(meaning.inputMode, "choice");
  assert.ok(meaning.choices.includes(target.chineseCore) && meaning.choices.length === 4);
  assert.equal(meaning.hint, undefined);
  const listening = buildQuizQuestion(target, "listening-choice", distractors);
  assert.equal(listening.audio, true);
  assert.equal(listening.hint, undefined);
  const spelling = buildQuizQuestion(target, "spelling", distractors);
  assert.equal(spelling.answer, target.headword);
  assert.equal(spelling.hint, undefined);
  const context = buildQuizQuestion(entry("challenge", { meaning: "挑战" }), "context-choice", distractors);
  assert.equal(context.type, "context-choice");
  assert.ok(context.prompt.includes("____") && context.choices.includes("challenge"));
  assert.equal(context.hint, undefined);
  // Without distractors, meaning choice falls back to spelling rather than to audio.
  assert.equal(buildQuizQuestion(target, "meaning-choice", [target]).type, "spelling");
});

test("quiz scoring counts correct answers and lists each wrong word once", () => {
  const score = scoreQuiz([
    { id: "a", correct: true }, { id: "b", correct: false }, { id: "c", correct: true },
    { id: "d", correct: true }, { id: "b", correct: false },
  ]);
  assert.deepEqual(score, { correct: 3, total: 5, percent: 60, wrongIds: ["b"] });
  assert.deepEqual(scoreQuiz([]), { correct: 0, total: 0, percent: 0, wrongIds: [] });
});

test("swipe physics: projected momentum decides, and the spring settles", () => {
  assert.ok(Math.abs(project(1000) - 499) < 1e-9);
  assert.equal(swipeDecision(0, 0, 360), 0);
  assert.equal(swipeDecision(140, 0, 360), 1, "past 35% of the width");
  assert.equal(swipeDecision(-140, 0, 360), -1);
  assert.equal(swipeDecision(30, 400, 360), 1, "a short flick carries");
  assert.equal(swipeDecision(200, -800, 360), -1, "a flick back reverses the decision");
  assert.equal(swipeDecision(200, -300, 360), 0, "pulling back toward the centre cancels");
  const start = springAt(100, 0, 0.4, 0);
  assert.equal(start.x, 100);
  assert.equal(start.v, 0);
  const late = springAt(100, 500, 0.4, 2);
  assert.ok(Math.abs(late.x) < 0.01 && Math.abs(late.v) < 0.1);
  for (let t = 0; t <= 2; t += 0.02) assert.ok(springAt(100, 0, 0.4, t).x >= 0, "critically damped: no overshoot");
  assert.ok(Math.abs(rubberband(50, 300)) < 50 && rubberband(-50, 300) < 0);
  assert.equal(rubberband(10, 0), 0);
});

test("card examples tolerate malformed open examples in the lexicon (also used by the practice session)", () => {
  const word = entry("album", { meaning: "专辑" });
  const detail = (openExample) => ({ ...word, openExample });
  assert.equal(getEntryExample(word, detail({ source: "Title of album", text: "Made in the A.M." })), undefined);
  assert.equal(getEntryExample(word, detail(null)), undefined);
  assert.deepEqual(getEntryExample(word, detail("We listened to the new album together.")), {
    en: "We listened to the new album together.", source: "开放词典例句",
  });
  assert.equal(getEntryExample(entry("challenge")).source, "词迹原创");
});

test("meanings that lost the opening bracket of a leading note are repaired for display", () => {
  assert.equal(repairMeaning("源自拉丁语）上午；午前"), "（源自拉丁语）上午；午前");
  assert.equal(repairMeaning("喻）（希腊神话） 阿喀琉斯的脚跟"), "（喻）（希腊神话） 阿喀琉斯的脚跟");
  assert.equal(repairMeaning("（艺术）研究院"), "（艺术）研究院");
  assert.equal(repairMeaning("上午 (a.m.)"), "上午 (a.m.)");
  assert.equal(repairMeaning(": 美国 ) 国家航空与航天局"), ": 美国 ) 国家航空与航天局");
});
