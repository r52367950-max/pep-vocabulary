"use client";

import type { LexiconIndexEntry } from "@/lib/lexicon";
import { assistantEntryLocations } from "@/lib/assistant-provenance";

/** Also applies to earlier answers and reviews without server provenance. */
export function AiProvenance({ result, words }: {
  result: Record<string, unknown>;
  words: ReadonlyMap<string, LexiconIndexEntry>;
}) {
  const entries = assistantEntryLocations(result, words);
  return (
    <div className="ai-provenance">
      <p className="ai-note">AI 生成 · 教材引文未核验</p>
      {entries.length > 0 && (
        <details>
          <summary>词条收录位置</summary>
          <p className="ai-note">这些位置说明目标词收录在哪里，不代表回答中的句子来自教材。</p>
          <ul className="ai-bullets">
            {entries.map((entry) => (
              <li key={entry.wordId}>
                <strong className="english" lang="en">{entry.headword}</strong>{"："}
                {entry.sources.map((source) => `${source.volume} · ${source.unit}${source.printedPage !== null ? ` · p.${source.printedPage}` : ""}`).join("；")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
