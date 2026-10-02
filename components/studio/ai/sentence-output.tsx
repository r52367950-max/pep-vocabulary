"use client";

import { useState } from "react";
import { Check, PenLine, Sparkles } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { localSentenceCheck } from "@/lib/questions";
import { scheduleReview } from "@/lib/scheduler";
import { createLocalId } from "@/lib/storage";
import { AiStatus, SentenceCheckView } from "./ai-views";
import { useAssistant } from "./use-assistant";

/**
 * Optional production step after a correct answer on a familiar word: write a sentence,
 * check it locally (and with AI when enabled), then record it as one "output" review.
 * It commits through the same card + event transaction as every other answer.
 */
export default function SentenceOutput({ entry, data, generation, eventPrefix, sourceLine }: {
  entry: LexiconIndexEntry; data: Vocabulary; generation: string; eventPrefix: string; sourceLine: string;
}) {
  const [open, setOpen] = useState(false);
  const [sentence, setSentence] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const check = useAssistant<{ verdict?: string }>("check-sentence", data);
  const local = sentence.trim() ? localSentenceCheck(sentence, entry.headword) : null;
  const verdict = check.state.status === "done" ? check.state.value.result.verdict : null;
  const ready = Boolean(local?.hasTarget && local.completeEnough);

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    // A sentence the AI marked for revision counts as effortful; otherwise as recalled.
    const rating = verdict === "needs-revision" ? 2 : 3;
    try {
      const { event } = scheduleReview({
        stored: data.cards.get(entry.id) || null, cardId: entry.id, rating, retention: data.settings.desiredRetention,
        skill: "output", questionType: "sentence-output", correct: true, responseMs: 0, hints: 0, errorType: null,
        prompt: `用 ${entry.headword} 造句`, answerGiven: sentence.trim(), expectedAnswer: null, sourceLine,
      });
      await data.saveReview({ ...event, eventType: "review", eventId: `${eventPrefix}:output:${createLocalId()}` }, generation);
      setSaved(true);
    } catch {
      data.notify("造句没有保存，可能另一页面刚更新了这个词。可以重试。");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return (
    <button className="text-button sentence-open" onClick={() => setOpen(true)}>
      <PenLine size={15} aria-hidden="true" />用它造个句（可选）
    </button>
  );
  if (saved) return <p className="feedback-good sentence-saved"><Check size={16} aria-hidden="true" /> 造句已记入“表达”练习。</p>;
  return (
    <div className="sentence-output">
      <label className="ai-field">
        <span>用 <strong className="english">{entry.headword}</strong> 写一个句子</span>
        <textarea lang="en" className="english" rows={2} maxLength={600} value={sentence} spellCheck={false} autoFocus
          onChange={(event) => { setSentence(event.target.value); if (check.state.status !== "idle") check.cancel(); }} />
      </label>
      {local && <p className="ai-note" data-tone={ready ? "good" : "maybe"}>{local.message}</p>}
      {check.state.status === "done" && <SentenceCheckView result={check.state.value.result} words={data.byId} />}
      <AiStatus state={check.state} onCancel={check.cancel} onRetry={() => check.run({ wordId: entry.id, sentence })} />
      <div className="sentence-actions">
        {data.settings.aiEnabled && check.state.status !== "loading" && check.state.status !== "done" && (
          <button className="secondary" disabled={!ready} onClick={() => check.run({ wordId: entry.id, sentence })}><Sparkles size={15} aria-hidden="true" />AI 检查</button>
        )}
        <button className="secondary" disabled={!ready || saving} onClick={save}>{saving ? "正在保存…" : "记入表达练习"}</button>
      </div>
    </div>
  );
}
