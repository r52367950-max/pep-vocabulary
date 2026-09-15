import type { LexiconIndexEntry } from "./lexicon";
import { findOriginalExample } from "./examples";
import type { StoredCard } from "./storage";

export type StudyBook = {
  id: string;
  label: string;
  shortLabel: string;
  level: "high" | "middle" | "curriculum";
};
export const BOOKS: readonly StudyBook[] = [
  {
    id: "HS-R1",
    label: "高中 · 必修第一册",
    shortLabel: "必修一",
    level: "high",
  },
  {
    id: "HS-R2",
    label: "高中 · 必修第二册",
    shortLabel: "必修二",
    level: "high",
  },
  {
    id: "HS-R3",
    label: "高中 · 必修第三册",
    shortLabel: "必修三",
    level: "high",
  },
  {
    id: "HS-S1",
    label: "高中 · 选择性必修第一册",
    shortLabel: "选必一",
    level: "high",
  },
  {
    id: "HS-S2",
    label: "高中 · 选择性必修第二册",
    shortLabel: "选必二",
    level: "high",
  },
  {
    id: "HS-S3",
    label: "高中 · 选择性必修第三册",
    shortLabel: "选必三",
    level: "high",
  },
  {
    id: "HS-S4",
    label: "高中 · 选择性必修第四册",
    shortLabel: "选必四",
    level: "high",
  },
  {
    id: "JH-7A",
    label: "初中 · 七年级上册",
    shortLabel: "七上",
    level: "middle",
  },
  {
    id: "JH-7B",
    label: "初中 · 七年级下册",
    shortLabel: "七下",
    level: "middle",
  },
  {
    id: "JH-8A",
    label: "初中 · 八年级上册",
    shortLabel: "八上",
    level: "middle",
  },
  {
    id: "JH-8B",
    label: "初中 · 八年级下册",
    shortLabel: "八下",
    level: "middle",
  },
  {
    id: "JH-9",
    label: "初中 · 九年级全一册",
    shortLabel: "九年级",
    level: "middle",
  },
  {
    id: "STD-HS",
    label: "高中课程标准词汇",
    shortLabel: "课标词汇",
    level: "curriculum",
  },
];

export type StudySelection = {
  /** A specific book takes precedence over bookIds. "all" means no single-book override. */
  bookId?: string;
  bookIds?: readonly string[];
  unit?: string;
};
export type StudyMode =
  | "daily"
  | "review"
  | "mistakes"
  | "dictation"
  | "context"
  | "new";
export type CardCollection =
  | ReadonlyMap<string, StoredCard>
  | readonly StoredCard[];
export type StudyQueueOptions = StudySelection & {
  mode?: StudyMode;
  limit?: number;
  newLimit?: number;
  dailyMinutes?: number;
  now?: Date;
  /** For an in-session failure that has not been committed yet. Recovered cards stay recovered. */
  mistakeIds?: ReadonlySet<string>;
  /** Include these entries when the caller has loaded and verified an external example. */
  contextIds?: ReadonlySet<string>;
  includeProperNames?: boolean;
};

function bookFilter(selection: StudySelection): ReadonlySet<string> | null {
  return selection.bookId && selection.bookId !== "all"
    ? new Set([selection.bookId])
    : selection.bookIds !== undefined
      ? new Set(selection.bookIds)
      : null;
}

export function selectEntries(
  entries: readonly LexiconIndexEntry[],
  selection: StudySelection = {},
): LexiconIndexEntry[] {
  const books = bookFilter(selection);
  const unit =
    selection.unit && selection.unit !== "all" ? selection.unit : null;
  const seen = new Set<string>();
  return entries.filter((entry) => {
    // The book and unit must belong to the SAME source record. A word appearing
    // in book A / Unit 1 and book B / Unit 2 does not belong to book A / Unit 2.
    if (
      (books || unit) &&
      !entry.sources.some(
        (source) =>
          (!books || books.has(source.bookId)) &&
          (!unit || source.unit === unit),
      )
    )
      return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

const unitCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
function compareUnits(a: string, b: string) {
  const rank = (unit: string) =>
    unit.startsWith("Welcome") ? 0 : unit.startsWith("Starter") ? 1 : 2;
  return rank(a) - rank(b) || unitCollator.compare(a, b);
}

export function getBookUnits(
  entries: readonly LexiconIndexEntry[],
  bookId = "all",
): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.sources
          .filter((source) => bookId === "all" || source.bookId === bookId)
          .map((source) => source.unit),
      ),
    ),
  ].sort(compareUnits);
}

function asCardMap(cards: CardCollection): ReadonlyMap<string, StoredCard> {
  return Array.isArray(cards)
    ? new Map(cards.map((card) => [card.id, card]))
    : (cards as ReadonlyMap<string, StoredCard>);
}
function unseen(card: StoredCard | undefined) {
  return !card || card.status === "unseen";
}
function due(card: StoredCard | undefined, now: number) {
  return Boolean(
    card &&
      card.status !== "paused" &&
      card.status !== "unseen" &&
      Date.parse(card.due) <= now,
  );
}
function boundedCount(
  value: number | undefined,
  fallback: number,
  maximum = 200,
) {
  return value === undefined
    ? fallback
    : Number.isFinite(value)
      ? Math.max(0, Math.min(maximum, Math.floor(value)))
      : 0;
}

export function buildStudyQueue(
  entries: readonly LexiconIndexEntry[],
  cards: CardCollection,
  options: StudyQueueOptions = {},
): LexiconIndexEntry[] {
  const cardMap = asCardMap(cards);
  const mode = options.mode || "daily";
  const now = (options.now || new Date()).getTime();
  const limit = boundedCount(options.limit, 20);
  if (!limit || !Number.isFinite(now)) return [];
  const selected = selectEntries(entries, options).filter(
    (entry) =>
      cardMap.get(entry.id)?.status !== "paused" &&
      (options.includeProperNames || !entry.flags.properName) &&
      (mode !== "context" ||
        Boolean(findOriginalExample(entry.headword)) ||
        options.contextIds?.has(entry.id)),
  );
  const selectedBooks = bookFilter(options);
  const position = (entry: LexiconIndexEntry) =>
    entry.sources.find(
      (source) =>
        (!selectedBooks || selectedBooks.has(source.bookId)) &&
        (!options.unit ||
          options.unit === "all" ||
          options.unit === source.unit),
    );
  const bookOrder = new Map(BOOKS.map((book, index) => [book.id, index]));
  const sourceOrder = (a: LexiconIndexEntry, b: LexiconIndexEntry) => {
    const left = position(a),
      right = position(b);
    return (
      (bookOrder.get(left?.bookId || "") ?? 99) -
        (bookOrder.get(right?.bookId || "") ?? 99) ||
      compareUnits(left?.unit || "", right?.unit || "") ||
      (left?.printedPage ?? Infinity) - (right?.printedPage ?? Infinity) ||
      Number(b.flags.highValue) - Number(a.flags.highValue) ||
      unitCollator.compare(a.headword, b.headword)
    );
  };
  const dueOrder = (a: LexiconIndexEntry, b: LexiconIndexEntry) =>
    Date.parse(cardMap.get(a.id)!.due) - Date.parse(cardMap.get(b.id)!.due) ||
    sourceOrder(a, b);
  const isMistake = (entry: LexiconIndexEntry) => {
    const card = cardMap.get(entry.id);
    return (
      card?.status === "weak" ||
      (unseen(card) && Boolean(options.mistakeIds?.has(entry.id)))
    );
  };
  const dueEntries = selected
    .filter((entry) => due(cardMap.get(entry.id), now))
    .sort(dueOrder);
  if (mode === "review") return dueEntries.slice(0, limit);
  if (mode === "mistakes") {
    return selected
      .filter(isMistake)
      .sort(
        (a, b) =>
          Number(due(cardMap.get(b.id), now)) -
            Number(due(cardMap.get(a.id), now)) ||
          (cardMap.get(a.id)?.lastReviewed || "").localeCompare(
            cardMap.get(b.id)?.lastReviewed || "",
          ) ||
          sourceOrder(a, b),
      )
      .slice(0, limit);
  }
  let newBudget = Math.min(limit, boundedCount(options.newLimit, 8));
  if (mode === "daily" && options.dailyMinutes !== undefined) {
    const availableMinutes = Math.max(
      0,
      options.dailyMinutes - dueEntries.length * 0.6,
    );
    newBudget = Number.isFinite(availableMinutes)
      ? Math.min(newBudget, Math.floor(availableMinutes / 1.5))
      : 0;
  }
  const newEntries = selected
    .filter((entry) => unseen(cardMap.get(entry.id)))
    .sort(sourceOrder)
    .slice(0, newBudget);
  if (mode === "new") return newEntries;
  if (mode === "daily") return [...dueEntries, ...newEntries].slice(0, limit);

  // A deliberate dictation/context session can revisit known material. Keep due
  // work first, then weak words and budgeted new words, then other known words.
  const queued = new Set(dueEntries.map((entry) => entry.id));
  const weakEntries = selected
    .filter(
      (entry) =>
        isMistake(entry) &&
        !unseen(cardMap.get(entry.id)) &&
        !queued.has(entry.id),
    )
    .sort(sourceOrder);
  for (const entry of [...weakEntries, ...newEntries]) queued.add(entry.id);
  const knownEntries = selected
    .filter((entry) => !unseen(cardMap.get(entry.id)) && !queued.has(entry.id))
    .sort((a, b) => {
      const skill = mode === "dictation" ? "listening" : "context";
      return (
        (cardMap.get(a.id)?.skills[skill] || 0) -
          (cardMap.get(b.id)?.skills[skill] || 0) || sourceOrder(a, b)
      );
    });
  return [...dueEntries, ...weakEntries, ...newEntries, ...knownEntries].slice(
    0,
    limit,
  );
}

export type StudySummary = {
  total: number;
  new: number;
  due: number;
  weak: number;
  learned: number;
  mastered: number;
  paused: number;
};
export function summarizeStudy(
  entries: readonly LexiconIndexEntry[],
  cards: CardCollection,
  options: StudySelection & { now?: Date } = {},
): StudySummary {
  const cardMap = asCardMap(cards),
    now = (options.now || new Date()).getTime();
  const result: StudySummary = {
    total: 0,
    new: 0,
    due: 0,
    weak: 0,
    learned: 0,
    mastered: 0,
    paused: 0,
  };
  for (const entry of selectEntries(entries, options)) {
    if (entry.flags.properName) continue;
    const card = cardMap.get(entry.id);
    result.total += 1;
    if (unseen(card)) result.new += 1;
    else if (card?.status === "paused") result.paused += 1;
    else result.learned += 1;
    if (due(card, now)) result.due += 1;
    if (card?.status === "weak") result.weak += 1;
    if (card?.status === "mastered") result.mastered += 1;
  }
  return result;
}

/** A wrong objective answer cannot be promoted by a later self-rating. */
export function effectiveRating({
  rating,
  correct,
  hints = 0,
}: {
  rating: 1 | 2 | 3 | 4;
  correct: boolean | null;
  hints?: number;
}): 1 | 2 | 3 | 4 {
  if (correct === false || rating === 1) return 1;
  if (![1, 2, 3, 4].includes(rating)) return 1;
  return hints > 0 ? (Math.min(rating, 2) as 1 | 2) : rating;
}
