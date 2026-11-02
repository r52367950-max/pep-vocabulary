"use client";

import type { LexiconIndexEntry } from "@/lib/lexicon";
import { assistantEntryLocations } from "@/lib/assistant-provenance";

/** Also applies to earlier answers and reviews without server provenance. */
export function AiProvenance({ result, words }: {
  result: Record<string, unknown>;
  words: ReadonlyMap<string, LexiconIndexEntry>;
}) {
  const entries = assistantEntryLocations(result, words);
  if (!entries.length) return null;
  return (
    <div className="ai-provenance">
      <details>
        <summary>词条收录位置</summary>
        <ul className="ai-bullets">
          {entries.map((entry) => (
            <li key={entry.wordId}>
              <strong className="english" lang="en">{entry.headword}</strong>{"："}
              {entry.sources.map((source) => `${source.volume} · ${source.unit}${source.printedPage !== null ? ` · p.${source.printedPage}` : ""}`).join("；")}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
