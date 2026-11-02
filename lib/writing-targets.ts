import type { LexiconIndexEntry } from "./lexicon";

export type TargetWordScope = "all" | "learned" | "selected";
export const MAX_WRITING_TARGETS = 20;

const normalizeSearch = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en");

/** Search the complete index before the view pages its results. */
export function searchTargetWords(entries: readonly LexiconIndexEntry[], {
  query = "", scope = "all", bookId = "all", learnedIds = new Set<string>(), selectedIds = new Set<string>(),
}: {
  query?: string;
  scope?: TargetWordScope;
  bookId?: string;
  learnedIds?: ReadonlySet<string>;
  selectedIds?: ReadonlySet<string>;
} = {}): LexiconIndexEntry[] {
  const search = normalizeSearch(query);
  return entries.flatMap((entry, index) => {
    if (scope === "learned" && !learnedIds.has(entry.id)) return [];
    if (scope === "selected" && !selectedIds.has(entry.id)) return [];
    if (bookId !== "all" && !entry.sources.some(source => source.bookId === bookId)) return [];
    const headword = normalizeSearch(entry.headword), lookup = normalizeSearch(entry.lookup);
    const meaning = normalizeSearch(entry.chineseCore);
    const rank = !search || headword === search || lookup === search ? 0
      : headword.startsWith(search) || lookup.startsWith(search) ? 1
        : headword.includes(search) || lookup.includes(search) ? 2
          : meaning.includes(search) ? 3 : -1;
    return rank < 0 ? [] : [{ entry, rank, index }];
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map(result => result.entry);
}

/** Draft selection is independent of the current query or result page. */
export function toggleTargetWord(draft: ReadonlySet<string>, id: string, existingIds: ReadonlySet<string>): Set<string> {
  const next = new Set(draft);
  if (existingIds.has(id)) return next;
  if (next.has(id)) next.delete(id);
  else if (existingIds.size + [...next].filter(value => !existingIds.has(value)).length < MAX_WRITING_TARGETS) next.add(id);
  return next;
}

/** Preserve stable IDs and existing targets; only emit valid, new additions. */
export function targetWordAdditions(existingIds: ReadonlySet<string>, draft: Iterable<string>, validIds: ReadonlySet<string>): string[] {
  return [...new Set(draft)].filter(id => !existingIds.has(id) && validIds.has(id)).slice(0, Math.max(0, MAX_WRITING_TARGETS - existingIds.size));
}

export function mergeTargetIds(existing: Iterable<string>, added: Iterable<string>, byId: ReadonlyMap<string, unknown>): string[] {
  return [...new Set([...existing, ...added])].filter(id => byId.has(id)).slice(0, MAX_WRITING_TARGETS);
}
