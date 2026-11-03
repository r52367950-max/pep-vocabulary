"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { contextStillCurrent, learningContextStore, refreshLearningContext, type LearningMemory } from "@/lib/learning-context-client";
import { captureWritingContext, writingContextCurrent, type WritingContext } from "@/lib/writing-context";
import { validWritingHandwritingAssessment, type WritingHandwritingAssessment } from "@/lib/writing-recognition";
import { compressDictationPhoto } from "@/lib/image-input";
import "./handwriting-upload.css";

type Recognition = { operationId: string; text: string; uncertainSpans: { text: string; reason: string }[]; requiresConfirmation: true; handwriting: WritingHandwritingAssessment };
export function HandwritingAssessment({ assessment }: { assessment: WritingHandwritingAssessment }) {
  return <section className="handwriting-assessment" aria-label="书写评价">
    <div className="handwriting-heading"><strong>书写评价</strong><span>{assessment.score === null ? "照片不足以评分" : `${assessment.score} / ${assessment.outOf}`}</span></div>
    <p className="ai-note">书写单独评分。</p>
    <p>{assessment.summary}</p>
    {assessment.photoQuality.issues.length > 0 && <p className="ai-note">照片情况：{assessment.photoQuality.issues.join("；")}</p>}
    <details><summary>查看书写建议</summary><dl>{assessment.dimensions.map(item => <div key={item.id}><dt>{({ legibility: "字迹辨识", "size-spacing": "大小与间距", "baseline-lines": "基线与行距", "layout-neatness": "布局与整洁" })[item.id]} · {item.score === null ? "暂不评分" : `${item.score} / 5`}</dt><dd>{item.evidence} {item.suggestion}</dd></div>)}</dl></details>
  </section>;
}

export default function HandwritingUpload({ temporary, disabled, hasText, onBusy, onConfirm }: { temporary: boolean; disabled: boolean; hasText: boolean; onBusy: (busy: boolean) => void; onConfirm: (text: string, assessment: WritingHandwritingAssessment, context: WritingContext) => Promise<void> }) {
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "loading" | "confirm">("idle");
  const [result, setResult] = useState<Recognition | null>(null), [text, setText] = useState("");
  const [sent, setSent] = useState(false), [importing, setImporting] = useState(false);
  const [error, setError] = useState(""), [confirmed, setConfirmed] = useState(false);
  const input = useRef<HTMLInputElement>(null), sequence = useRef(0), locked = useRef(false), alive = useRef(true);
  const controller = useRef<AbortController | null>(null), memory = useRef<LearningMemory | null>(null), context = useRef<WritingContext | null>(null);
  const reset = useCallback(() => { sequence.current++; controller.current?.abort(); controller.current = null; locked.current = false; memory.current = null; context.current = null; setPhoto(null); setResult(null); setText(""); setError(""); setConfirmed(false); setSent(false); setImporting(false); setPhase("idle"); onBusy(false); if (input.current) input.current.value = ""; }, [onBusy]);
  // This counter intentionally invalidates asynchronous work on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; controller.current?.abort(); onBusy(false); }; }, [onBusy]);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);
  useEffect(() => learningContextStore.subscribe(() => { if (memory.current && !contextStillCurrent(memory.current, temporary)) reset(); }), [temporary, reset]);
  const choose = async (file?: File) => {
    reset(); if (!file) return;
    const request = sequence.current; setPhase("preparing"); onBusy(true);
    try { const blob = await compressDictationPhoto(file); if (!alive.current || request !== sequence.current) return; setPhoto({ blob, url: URL.createObjectURL(blob) }); setPhase("ready"); }
    catch (cause) { if (alive.current && request === sequence.current) { setError(cause instanceof Error ? cause.message : "照片读取失败。"); setPhase("idle"); onBusy(false); } }
  };
  const recognize = async () => {
    if (!photo || locked.current || disabled) return;
    locked.current = true; setSent(true); const request = sequence.current, abort = new AbortController(); controller.current = abort; setError(""); setPhase("loading");
    const timeout = setTimeout(() => abort.abort(), 90_000);
    try {
      const policy = await refreshLearningContext(abort.signal); memory.current = policy; context.current = captureWritingContext();
      if (!contextStillCurrent(policy, temporary)) throw new Error("学习模式已改变，请重新选图。");
      const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("照片读取失败。")); reader.readAsDataURL(photo.blob); });
      if (abort.signal.aborted || request !== sequence.current) return;
      const operationId = crypto.randomUUID();
      const response = await fetch("/api/writing/recognize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, signal: abort.signal, body: JSON.stringify({ image, operationId, temporary, accountScope: policy.accountScope, contextRevision: policy.revision, contextVersion: policy.contextVersion }) });
      const answer = await response.json();
      if (!response.ok) throw new Error(typeof answer?.error === "string" ? answer.error : answer?.error?.message || "识别未完成，请重新选图。");
      await refreshLearningContext(abort.signal);
      if (!alive.current || request !== sequence.current || abort.signal.aborted || !contextStillCurrent(policy, temporary)) return;
      if (answer.operationId !== operationId || answer.requiresConfirmation !== true || typeof answer.text !== "string" || answer.text.length > 8000 || !validWritingHandwritingAssessment(answer.handwriting) || !Array.isArray(answer.uncertainSpans) || answer.uncertainSpans.length > 100 || answer.uncertainSpans.some((item: unknown) => !item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string" || typeof (item as { reason?: unknown }).reason !== "string")) throw new Error("识别结果不完整，请重新选图。");
      setResult(answer); setText(answer.text); setPhase("confirm");
    } catch (cause) { if (alive.current && request === sequence.current) { setError(abort.signal.aborted ? "识别已停止或超时，请重新选图后再试。" : cause instanceof Error ? cause.message : "识别失败。"); setPhase("ready"); } }
    finally { clearTimeout(timeout); if (request === sequence.current) controller.current = null; }
  };
  return <section className="handwriting-upload" aria-label="手写作文上传">
    <input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择手写作文照片" onChange={event => void choose(event.target.files?.[0])} />
    {phase === "idle" ? <button className="text-button" disabled={disabled} onClick={() => input.current?.click()}><Camera size={17} aria-hidden="true" />上传手写作文</button> : <>
      <div className="handwriting-heading"><strong>手写作文</strong><button className="text-button" onClick={reset}>取消</button></div>
      {/* Local object URL preview; no remote image optimization. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {photo && <img className="handwriting-preview" src={photo.url} alt="本次手写作文照片" />}
      {(phase === "preparing" || phase === "loading") && <p role="status">{phase === "preparing" ? "正在本机处理照片…" : "正在逐字识别与评价书写…"}</p>}
      {phase === "ready" && <><p className="ai-note">上传清晰完整的作文照片，保留原稿拼写。照片仅用于本次识别，不保存；识别使用 AI 接口额度。</p><div className="handwriting-actions">{!sent && <button className="secondary" disabled={disabled} onClick={() => void recognize()}>识别原稿</button>}<button className="text-button" onClick={() => input.current?.click()}>重新选图</button></div></>}
      {phase === "confirm" && result && <>
        <label className="ai-field"><span>核对识别文字</span><textarea rows={9} value={text} maxLength={8000} lang="en" spellCheck={false} onChange={event => { setText(event.target.value); setConfirmed(false); }} /></label>
        <p className="ai-note">只修正识别错误，保留原稿的拼写、语法与标点。确认后才导入正文，再进行内容批改。</p>
        {result.uncertainSpans.length > 0 && <p className="ai-note">请重点核对：{result.uncertainSpans.map(item => `${item.text}（${item.reason}）`).join("；")}</p>}
        <HandwritingAssessment assessment={result.handwriting} />
        <label className="handwriting-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>我已对照原稿核对文字{hasText ? "；导入后原正文保留为旧版" : ""}</span></label>
        <button className="primary" disabled={!confirmed || !text.trim() || importing} onClick={async () => {
          if (!context.current || !writingContextCurrent(context.current) || controller.current) return;
          const request = sequence.current, abort = new AbortController(); controller.current = abort; setImporting(true);
          try { await onConfirm(text, result.handwriting, context.current); if (alive.current && request === sequence.current) reset(); }
          catch (cause) { if (alive.current && request === sequence.current) setError(cause instanceof Error ? cause.message : "导入未完成。"); }
          finally { if (request === sequence.current) { controller.current = null; setImporting(false); } }
        }}>确认文字，导入正文</button>
      </>}
    </>}
    {error && <p className="ai-status is-error" role="alert">{error}</p>}
  </section>;
}
