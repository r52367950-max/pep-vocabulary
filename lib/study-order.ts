import type { LexiconIndexEntry } from "./lexicon";

export type StudyOrder = "random" | "textbook";

function textbookPosition(entry: LexiconIndexEntry, bookId: string, unit: string) {
  const positions = entry.sources
    .filter(source => source.bookId === bookId && (unit === "all" || source.unit === unit))
    .map(source => source.textbookOrder)
    .filter((position): position is number => Number.isSafeInteger(position) && position! > 0);
  return positions.length ? Math.min(...positions) : undefined;
}

export function hasTextbookOrder(entries: readonly LexiconIndexEntry[], bookId: string, unit = "all") {
  return entries.length > 0 && entries.every(entry => textbookPosition(entry, bookId, unit) !== undefined);
}

/** Sort a copy, keeping a session's chosen membership independent of display order. */
export function orderStudyEntries(
  entries: readonly LexiconIndexEntry[], order: StudyOrder, bookId: string, unit = "all",
  random: () => number = Math.random,
) {
  const result = [...entries];
  if (order === "textbook" && hasTextbookOrder(result, bookId, unit)) {
    return result.sort((a, b) => textbookPosition(a, bookId, unit)! - textbookPosition(b, bookId, unit)!);
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
