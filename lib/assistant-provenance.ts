import type { LexiconIndexEntry, SourcePosition } from "./lexicon";

export type AssistantEntryLocation = {
  wordId: string;
  headword: string;
  sources: Pick<SourcePosition, "bookId" | "volume" | "unit" | "printedPage">[];
};

/**
 * Answers and saved reviews may contain arbitrary origin/citation metadata.
 * Only current, formally released entries supply the locations shown beside AI
 * prose. A word's location never verifies a sentence attributed to its textbook.
 */
export function assistantEntryLocations(result: unknown, words: ReadonlyMap<string, LexiconIndexEntry>): AssistantEntryLocation[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const ids = (result as Record<string, unknown>).evidenceIds;
  if (!Array.isArray(ids)) return [];
  const entries: AssistantEntryLocation[] = [];
  const seen = new Set<string>();
  // Saved writing reviews allow at most 100 evidence IDs; current responses use
  // at most 12. Keep imported or older metadata from expanding this UI work.
  for (const id of ids.slice(0, 100)) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const entry = words.get(id);
    if (!entry || entry.id !== id || entry.flags?.formalReleaseEligible !== true) continue;
    const positions = new Set<string>();
    const sources: AssistantEntryLocation["sources"] = [];
    for (const source of entry.sources) {
      const position = { bookId: source.bookId, volume: source.volume, unit: source.unit, printedPage: source.printedPage };
      const key = JSON.stringify(position);
      if (positions.has(key)) continue;
      positions.add(key);
      sources.push(position);
      if (sources.length === 12) break;
    }
    if (!sources.length) continue;
    entries.push({ wordId: entry.id, headword: entry.headword, sources });
    if (entries.length === 12) break;
  }
  return entries;
}
