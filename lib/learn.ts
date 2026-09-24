import type { LexiconIndexEntry } from "./lexicon";
import type { StoredCard } from "./storage";
import { findOriginalExample } from "./examples";
import { buildQuestion, normalizeAnswer, type Question } from "./questions";
import { BOOKS, getBookUnits, selectEntries } from "./study";

/**
 * Exposure, game and self-test tools. Nothing here writes a review or moves the
 * FSRS schedule; words that need work are handed to the regular practice session.
 */
export type LearnMode = "cards" | "match" | "quiz";
export type LearnSelection = { bookId: string; unit: string };
export type LearnCards = ReadonlyMap<string, StoredCard>;

// ---------------------------------------------------------------------------
// Deterministic randomness, so every builder can be replayed in a test.

export function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast and good enough for shuffling a word list. */
export function createRandom(seed: string | number): () => number {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// The shared word pool: the textbook selection, in the order the book prints it.

const bookOrder = new Map(BOOKS.map((book, index) => [book.id, index]));
const headwordCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function textbookOrder(
  entries: readonly LexiconIndexEntry[],
  selection: LearnSelection,
) {
  const book = selection.bookId || "all";
  const unit = selection.unit || "all";
  const unitRank = new Map(
    getBookUnits(entries, book).map((value, index) => [value, index]),
  );
  const place = (entry: LexiconIndexEntry) =>
    entry.sources.find(
      (source) =>
        (book === "all" || source.bookId === book) &&
        (unit === "all" || source.unit === unit),
    );
  return (a: LexiconIndexEntry, b: LexiconIndexEntry) => {
    const left = place(a);
    const right = place(b);
    return (
      (bookOrder.get(left?.bookId ?? "") ?? 99) -
        (bookOrder.get(right?.bookId ?? "") ?? 99) ||
      (unitRank.get(left?.unit ?? "") ?? 999) -
        (unitRank.get(right?.unit ?? "") ?? 999) ||
      (left?.printedPage ?? Infinity) - (right?.printedPage ?? Infinity) ||
      headwordCollator.compare(a.headword, b.headword)
    );
  };
}

/** Selection minus paused cards and proper names, exactly like buildStudyQueue. */
export function learnPool(
  entries: readonly LexiconIndexEntry[],
  cards: LearnCards,
  selection: LearnSelection,
): LexiconIndexEntry[] {
  return selectEntries(entries, selection)
    .filter(
      (entry) =>
        cards.get(entry.id)?.status !== "paused" && !entry.flags.properName,
    )
    .sort(textbookOrder(entries, selection));
}

export function isUnseen(card: StoredCard | undefined) {
  return !card || card.status === "unseen" || !card.lastReviewed;
}

// ---------------------------------------------------------------------------
// 词卡速记: a first-exposure deck, and a small reducer for sorting it.

export const FLASH_DECK_SIZE = 20;

/**
 * Up to `limit` words: never-reviewed first (textbook order), then weak or due
 * (most overdue first), then everything else. Words in `exclude` (already seen in
 * this sitting) sink below all of those, so "another set" moves on through the unit.
 */
export function buildFlashDeck(
  entries: readonly LexiconIndexEntry[],
  cards: LearnCards,
  options: LearnSelection & {
    now?: Date;
    limit?: number;
    exclude?: ReadonlySet<string>;
  },
): LexiconIndexEntry[] {
  const now = (options.now ?? new Date()).getTime();
  const limit = Math.max(
    0,
    Math.min(200, Math.floor(options.limit ?? FLASH_DECK_SIZE) || 0),
  );
  const ranked = learnPool(entries, cards, options).map((entry, order) => {
    const card = cards.get(entry.id);
    const due = card ? Date.parse(card.due) : NaN;
    const base = isUnseen(card)
      ? 0
      : card!.status === "weak" || due <= now
        ? 1
        : 2;
    return {
      entry,
      order,
      due,
      tier: options.exclude?.has(entry.id) ? base + 3 : base,
    };
  });
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.tier % 3 === 1 ? a.due - b.due : 0) ||
      a.order - b.order,
  );
  return ranked.slice(0, limit).map((item) => item.entry);
}

export type FlashItem = { id: string; key: string; repeat: boolean };
export type FlashDecision = { id: string; known: boolean; repeat: boolean };
export type FlashState = {
  queue: FlashItem[];
  position: number;
  decisions: FlashDecision[];
};

export function startFlash(deck: readonly { id: string }[]): FlashState {
  return {
    queue: [...new Set(deck.map((entry) => entry.id))].map((id) => ({
      id,
      key: id,
      repeat: false,
    })),
    position: 0,
    decisions: [],
  };
}

export const flashDone = (state: FlashState) =>
  state.position >= state.queue.length;

/** "再看看" on a first pass sends the card to the back of the deck once more. */
export function decideFlash(state: FlashState, known: boolean): FlashState {
  const item = state.queue[state.position];
  if (!item) return state;
  const queue =
    !known && !item.repeat
      ? [...state.queue, { id: item.id, key: `${item.id}#again`, repeat: true }]
      : state.queue;
  return {
    queue,
    position: state.position + 1,
    decisions: [
      ...state.decisions,
      { id: item.id, known, repeat: item.repeat },
    ],
  };
}

export function undoFlash(state: FlashState): FlashState {
  const last = state.decisions[state.decisions.length - 1];
  if (!last || state.position === 0) return state;
  const queue =
    !last.known && !last.repeat
      ? state.queue.filter((item) => !(item.repeat && item.id === last.id))
      : state.queue;
  return {
    queue,
    position: state.position - 1,
    decisions: state.decisions.slice(0, -1),
  };
}

/** A word counts as "再看看" if it was not recognised on first sight. */
export function summarizeFlash(state: FlashState) {
  const first = state.decisions.filter((decision) => !decision.repeat);
  return {
    known: first.filter((d) => d.known).map((d) => d.id),
    review: first.filter((d) => !d.known).map((d) => d.id),
  };
}

// ---------------------------------------------------------------------------
// 配对消除: rounds of English/Chinese pairs with unambiguous meanings.

export const MATCH_PAIRS = 6;
export const MATCH_ROUNDS = 3;
export const MATCH_MIN_WORDS = 4;

const POS = "(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|interj|aux|abbr|pl)";
const LEADING_POS = new RegExp(`^(?:${POS}\\.\\s*(?:&\\s*)?)+`, "i");
const INNER_POS = new RegExp(`\\s+${POS}\\.(?=\\s|&|$)`, "i");
const INLINE_IPA = /\s*\/[^/\s][^/]{0,40}\//;
const LINE_BREAK = /\\n|\n/;
const BRACKET_NOTE = /\[[^\]]*\]/g;
const PAREN_NOTE = /（[^（）]*）|\([^()]*\)/g;
const SENSE_SPLIT = /[；;，,]/;

function cleanSense(value: string) {
  let sense = value.trim();
  // Source glosses sometimes lose an opening bracket: "尤指外语）流利的".
  const close = sense.search(/[）)]/);
  const open = sense.search(/[（(]/);
  if (close >= 0 && (open < 0 || close < open))
    sense = sense.slice(close + 1).trim();
  const bare = sense.replace(PAREN_NOTE, "").replace(/\s+/g, "").trim();
  return bare || sense.replace(/\s+/g, "");
}

/** A compact gloss for a tile: first one or two senses, no POS labels or notes. */
export function shortMeaning(chineseCore: string, max = 14): string {
  let text = (chineseCore || "").split(LINE_BREAK)[0];
  text = text.replace(LEADING_POS, "");
  const cut = [INNER_POS, INLINE_IPA]
    .map((pattern) => text.search(pattern))
    .filter((index) => index > 0);
  if (cut.length) text = text.slice(0, Math.min(...cut));
  const senses = text
    .replace(BRACKET_NOTE, "")
    .split(SENSE_SPLIT)
    .map(cleanSense)
    .filter(Boolean);
  if (!senses.length) return (chineseCore || "").trim().slice(0, max);
  let result = senses[0];
  if (result.length > max) return `${result.slice(0, max - 1)}…`;
  for (const sense of senses.slice(1, 2)) {
    if (result.length + 1 + sense.length > max) break;
    result += `；${sense}`;
  }
  return result;
}

export type MatchPair = { id: string; headword: string; meaning: string };
export type MatchRound = {
  pairs: MatchPair[];
  /** English column order (ids). */
  left: string[];
  /** Chinese column order (ids), shuffled independently. */
  right: string[];
};

export function buildMatchRounds(
  entries: readonly LexiconIndexEntry[],
  cards: LearnCards,
  options: LearnSelection & {
    seed: string | number;
    pairs?: number;
    rounds?: number;
  },
): MatchRound[] {
  const random = createRandom(options.seed);
  const perRound = Math.max(
    MATCH_MIN_WORDS,
    Math.min(MATCH_PAIRS, options.pairs ?? MATCH_PAIRS),
  );
  const maxRounds = Math.max(
    1,
    Math.min(MATCH_ROUNDS, options.rounds ?? MATCH_ROUNDS),
  );
  const taken = new Set<string>();
  const words = new Set<string>();
  const picked: MatchPair[] = [];
  for (const entry of shuffle(learnPool(entries, cards, options), random)) {
    if (picked.length >= perRound * maxRounds) break;
    const meaning = shortMeaning(entry.chineseCore);
    const word = normalizeAnswer(entry.headword);
    // Any shared sense makes two tiles ambiguous, not only identical glosses.
    const keys = [
      normalizeAnswer(entry.chineseCore),
      normalizeAnswer(meaning),
      ...meaning.split("；").map(normalizeAnswer),
    ].filter(Boolean);
    if (!word || !keys.length || words.has(word)) continue;
    if (keys.some((key) => taken.has(key))) continue;
    keys.forEach((key) => taken.add(key));
    words.add(word);
    picked.push({ id: entry.id, headword: entry.headword, meaning });
  }
  if (picked.length < MATCH_MIN_WORDS) return [];
  let rounds = Math.min(maxRounds, Math.ceil(picked.length / perRound));
  while (rounds > 1 && Math.floor(picked.length / rounds) < MATCH_MIN_WORDS)
    rounds -= 1;
  const total = Math.min(picked.length, rounds * perRound);
  const result: MatchRound[] = [];
  let offset = 0;
  for (let round = 0; round < rounds; round++) {
    const size =
      Math.floor(total / rounds) + (round < total % rounds ? 1 : 0);
    const pairs = picked.slice(offset, offset + size);
    offset += size;
    const left = shuffle(
      pairs.map((pair) => pair.id),
      random,
    );
    let right = shuffle(left, random);
    // Never line a pair up straight across from itself in every row.
    if (right.every((id, index) => id === left[index]))
      right = [...right.slice(1), right[0]];
    result.push({ pairs, left, right });
  }
  return result;
}

export type MatchMistake = { left: string; right: string };

export function summarizeMatch(
  rounds: readonly MatchRound[],
  mistakes: readonly MatchMistake[],
) {
  const pairs = rounds.reduce((sum, round) => sum + round.pairs.length, 0);
  return {
    pairs,
    mistakes: mistakes.length,
    accuracy: pairs
      ? Math.round((pairs / (pairs + mistakes.length)) * 100)
      : 0,
    /** Both words in a wrong pairing were confused with each other. */
    mismatchedIds: [
      ...new Set(mistakes.flatMap((mistake) => [mistake.left, mistake.right])),
    ],
  };
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.min(99, Math.floor(seconds / 60));
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 单元自测: mixed objective questions built with the existing question engine.

export const QUIZ_MAX = 40;
export type QuizLength = 10 | 20 | "all";
export type QuizKind =
  | "meaning-choice"
  | "listening-choice"
  | "spelling"
  | "context-choice";
export const QUIZ_KIND_LABEL: Record<QuizKind, string> = {
  "meaning-choice": "看英文选词义",
  "listening-choice": "听音选义",
  spelling: "看中文拼写",
  "context-choice": "语境选词",
};
const QUIZ_PREFERENCE: readonly QuizKind[] = [
  "meaning-choice",
  "listening-choice",
  "spelling",
  "context-choice",
];
const SPELLABLE = /^[A-Za-z]+(?:[ '’-][A-Za-z]+)*$/;

export function quizLength(length: QuizLength, available: number) {
  const count = Math.max(0, Math.floor(available) || 0);
  return Math.min(QUIZ_MAX, length === "all" ? count : Math.min(length, count));
}

/** Only question kinds that can be asked fairly, without hints or free writing. */
export function quizKinds(entry: LexiconIndexEntry, audio = true): QuizKind[] {
  return QUIZ_PREFERENCE.filter((kind) =>
    kind === "listening-choice"
      ? audio
      : kind === "spelling"
        ? SPELLABLE.test(entry.headword.trim())
        : kind === "context-choice"
          ? Boolean(findOriginalExample(entry.headword))
          : true,
  );
}

export type QuizItem = { id: string; kind: QuizKind };

export function buildQuizPlan(
  entries: readonly LexiconIndexEntry[],
  cards: LearnCards,
  options: LearnSelection & {
    length: QuizLength;
    seed: string | number;
    audio?: boolean;
  },
): QuizItem[] {
  const random = createRandom(options.seed);
  const pool = shuffle(learnPool(entries, cards, options), random);
  const used = new Map<QuizKind, number>();
  const count = (kind: QuizKind) => used.get(kind) ?? 0;
  return pool.slice(0, quizLength(options.length, pool.length)).map((entry) => {
    const kinds = quizKinds(entry, options.audio !== false);
    const least = Math.min(...kinds.map(count));
    const candidates = kinds.filter((kind) => count(kind) === least);
    // Reviewed sentence contexts are scarce, so use one whenever it is due a turn.
    const kind = candidates.includes("context-choice")
      ? "context-choice"
      : candidates[Math.floor(random() * candidates.length)];
    used.set(kind, count(kind) + 1);
    return { id: entry.id, kind };
  });
}

/**
 * Distractor candidates for choice questions. Place and organisation names in the
 * index are not always flagged as proper names, but they are capitalised, and an
 * option like “艾伯塔省” is too easy to rule out.
 */
export function quizDistractorPool(entries: readonly LexiconIndexEntry[]) {
  return entries.filter(
    (entry) => !entry.flags.properName && !/^\p{Lu}/u.test(entry.headword),
  );
}

/** A self-test question: no hints, objective grading. */
export function buildQuizQuestion(
  entry: LexiconIndexEntry,
  kind: QuizKind,
  pool: LexiconIndexEntry[],
): Question {
  const strip = (question: Question): Question => ({
    ...question,
    hint: undefined,
  });
  if (kind === "meaning-choice") {
    const base = buildQuestion(entry, undefined, "listening-choice", pool);
    if (base.type !== "listening-choice")
      return strip(buildQuestion(entry, undefined, "spelling", pool));
    return strip({
      ...base,
      label: QUIZ_KIND_LABEL["meaning-choice"],
      skill: "meaning",
      prompt: entry.headword,
      support: null,
      audio: false,
    });
  }
  return strip(buildQuestion(entry, undefined, kind, pool));
}

export type QuizAnswer = {
  id: string;
  kind: QuizKind;
  correct: boolean;
  given: string;
  expected: string;
};

export function scoreQuiz(
  answers: readonly Pick<QuizAnswer, "id" | "correct">[],
) {
  const correct = answers.filter((answer) => answer.correct).length;
  const total = answers.length;
  return {
    correct,
    total,
    percent: total ? Math.round((correct / total) * 100) : 0,
    wrongIds: [
      ...new Set(
        answers.filter((answer) => !answer.correct).map((answer) => answer.id),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Motion math for the swipe deck (Designing Fluid Interfaces, WWDC 2018).

/** Where a flick would come to rest, like scroll deceleration. */
export function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a soft boundary. */
export function rubberband(offset: number, dimension: number, constant = 0.55) {
  if (dimension <= 0) return 0;
  return (
    (offset * dimension * constant) / (dimension + constant * Math.abs(offset))
  );
}

/**
 * A critically damped spring (damping ratio 1) evaluated in closed form.
 * `displacement` is measured from the target; velocity is in units per second.
 */
export function springAt(
  displacement: number,
  velocity: number,
  response: number,
  seconds: number,
) {
  const omega = (2 * Math.PI) / Math.max(0.01, response);
  const b = velocity + omega * displacement;
  const decay = Math.exp(-omega * seconds);
  return {
    x: (displacement + b * seconds) * decay,
    v: (velocity - omega * b * seconds) * decay,
  };
}

/**
 * Commit a swipe when its projected resting point clears the threshold; the
 * direction comes from that projection, so a flick back toward centre cancels.
 */
export function swipeDecision(
  offset: number,
  velocity: number,
  width: number,
  threshold = 0.35,
): -1 | 0 | 1 {
  const end = offset + project(velocity);
  if (Math.abs(end) <= width * threshold) return 0;
  return end > 0 ? 1 : -1;
}
