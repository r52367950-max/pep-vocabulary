"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { listWritings, type WritingRecord } from "@/lib/storage";
import { latestVersion, suggestTargets, writingTitle } from "@/lib/writing";
import { StudioSymbol } from "../symbol";

/** Today's writing entry: recent words on a ruled line, a way back to an unfinished draft. */
export default function WritingCard({ data, onWrite }: {
  data: Vocabulary;
  onWrite: (options: { targets?: string[]; openId?: string | null }) => void;
}) {
  const targets = useMemo(() => suggestTargets(data.history.active, data.cards, data.byId, 6), [data.history, data.cards, data.byId]);
  const [records, setRecords] = useState<WritingRecord[]>([]);
  useEffect(() => {
    let active = true;
    listWritings().then((rows) => { if (active) setRecords(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, [data.history]);
  const draft = useMemo(() => records
    .filter((record) => { const last = latestVersion(record); return last && !last.review && last.text.trim(); })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0], [records]);

  return (
    <section className="practice-section" aria-labelledby="writing-title">
      <div className="section-heading"><h2 id="writing-title">写作</h2></div>
      <div className="writing-prompt">
        <div className="writing-prompt-copy">
          <strong>{targets.length ? "用最近学过的词写一段" : "写一段英语短文"}</strong>
          <small>{targets.length ? "写 80–120 词，用上下面的词。写完可以让 AI 批改。" : "学过一些词后，这里会推荐目标词。"}</small>
        </div>
        {targets.length > 0 && (
          <p className="writing-line" aria-label={`目标词：${targets.map((entry) => entry.headword).join("、")}`}>
            {targets.map((entry) => <span key={entry.id} className="english">{entry.headword}</span>)}
          </p>
        )}
        <button className="primary writing-start" onClick={() => onWrite({ targets: targets.map((entry) => entry.id) })}>
          <StudioSymbol name="write" size={18} />开始写作
        </button>
        {(draft || records.length > 0) && (
          <div className="writing-links">
            {draft && <button className="text-button" onClick={() => onWrite({ openId: draft.id })}>继续写《{writingTitle(draft)}》<ChevronRight size={14} aria-hidden="true" /></button>}
            <button className="text-button" onClick={() => onWrite({})}>写作记录 {records.length} 篇<ChevronRight size={14} aria-hidden="true" /></button>
          </div>
        )}
      </div>
    </section>
  );
}
