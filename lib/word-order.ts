import type { LexiconIndexEntry, SourcePosition } from "./lexicon";
import { BOOKS, type StudySelection } from "./study";

export type WordOrder = "textbook" | "az" | "za" | "random";
const alphabet = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const books = new Map(BOOKS.map((book, index) => [book.id, index]));

/** Fisher–Yates on a copy; the chosen order is stored for the whole round. */
export function shuffleWords<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function compareSources(a: SourcePosition, b: SourcePosition) {
  return (books.get(a.bookId) ?? 99) - (books.get(b.bookId) ?? 99)
    || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
    || (a.printedPage ?? Number.MAX_SAFE_INTEGER) - (b.printedPage ?? Number.MAX_SAFE_INTEGER);
}

export function orderWords(entries: readonly LexiconIndexEntry[], order: Exclude<WordOrder, "random">, selection: StudySelection = {}) {
  const sorted = [...entries];
  const compareAlphabet = (a: LexiconIndexEntry, b: LexiconIndexEntry) => alphabet.compare(a.headword, b.headword) || a.id.localeCompare(b.id);
  if (order !== "textbook") return sorted.sort((a, b) => compareAlphabet(a, b) * (order === "za" ? -1 : 1));
  const positions = new Map(entries.map(entry => [entry.id, entry.sources.filter(source =>
    (!selection.bookId || selection.bookId === "all" || source.bookId === selection.bookId)
    && (!selection.unit || selection.unit === "all" || source.unit === selection.unit),
  ).sort(compareSources)[0]]));
  return sorted.sort((a, b) => {
    const left = positions.get(a.id), right = positions.get(b.id);
    return (left && right ? compareSources(left, right) : left ? -1 : right ? 1 : 0) || compareAlphabet(a, b);
  });
}
