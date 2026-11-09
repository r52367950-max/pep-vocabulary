"use client";

import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { compareDictation, type DictationItem } from "@/lib/voice/dictation";
import { contextStillCurrent, learningContextStore, refreshLearningContext, type LearningMemory } from "@/lib/learning-context-client";
import { voiceRequest } from "@/lib/voice/client";
import { compressDictationPhoto } from "@/lib/image-input";
import "./paper-dictation.css";

type Row = { label: string; text: string; uncertain: boolean; itemId: string };
export type PaperDictationGrade = { correct: number; total: number; assisted: true };
export type PaperDictationProps = { items: DictationItem[]; heardItemIds: string[]; temporary: boolean; accountScope?: string; contextEpoch: number; onGraded?: (grade: PaperDictationGrade) => void };

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("照片读取失败。"));
    reader.readAsDataURL(blob);
  });
}
export function PaperDictation(props: PaperDictationProps) {
  const key = JSON.stringify([props.contextEpoch, props.accountScope, props.temporary, props.items.map(item => [item.id, item.text])]);
  return <PaperSession key={key} {...props} />;
}
function PaperSession({ items, heardItemIds, temporary, accountScope, onGraded }: PaperDictationProps) {
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "loading" | "confirm" | "graded">("idle");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ number: number; correct: boolean; expected: string; answer: string }[]>([]);
  // A photo is sent for recognition at most once. The ref closes the gate synchronously
  // against repeated clicks; the state hides the action once the gate is closed.
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0), locked = useRef(false), request = useRef<AbortController | null>(null);
  const memory = useRef<LearningMemory | null>(null);
  const alive = useRef(true), gradedOnce = useRef(false);
  const heard = new Set(heardItemIds);
  const eligible = items.filter(item => heard.has(item.id));
  const reset = () => {
    sequence.current++;
    request.current?.abort();
    locked.current = false;
    setSent(false);
    memory.current = null;
    gradedOnce.current = false;
    setPhoto(null);
    setRows([]);
    setResults([]);
    setPhase("idle");
    setError("");
    if (input.current) input.current.value = "";
  };
  // After unmount `alive` stops every pending continuation from touching state.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);
  useEffect(() => learningContextStore.subscribe(() => { if (memory.current && !contextStillCurrent(memory.current, temporary)) reset(); }), [temporary]);
  const choose = async (file?: File) => {
    reset();
    if (!file) return;
    const generation = sequence.current;
    setPhase("preparing");
    try {
      const blob = await compressDictationPhoto(file);
      if (!alive.current || generation !== sequence.current) return;
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setPhase("ready");
    } catch (cause) {
      if (alive.current && generation === sequence.current) {
        setError(cause instanceof Error ? cause.message : "无法读取照片，请换一张。");
        setPhase("idle");
      }
    }
  };
  const recognize = async () => {
    if (!photo || locked.current || phase !== "ready" || !eligible.length) return;
    locked.current = true;
    setSent(true);
    const generation = sequence.current, controller = new AbortController();
    request.current = controller;
    setPhase("loading");
    setError("");
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const context = await refreshLearningContext(controller.signal);
      memory.current = context;
      if (accountScope && context.accountScope !== accountScope) throw new Error("账户已改变，请重新选图。");
      if (!contextStillCurrent(context, temporary)) throw new Error("学习模式已改变，请重新选图。");
      const image = await dataURL(photo.blob);
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      const response = await voiceRequest<{ rows: Omit<Row, "itemId">[]; requiresConfirmation: boolean }>("/api/voice/dictation-recognize", {
        image,
        operationId: crypto.randomUUID(),
        temporary,
        accountScope: context.accountScope,
        contextRevision: context.revision,
        contextVersion: context.contextVersion,
      }, controller.signal);
      await refreshLearningContext(controller.signal);
      if (!alive.current || generation !== sequence.current || controller.signal.aborted || !contextStillCurrent(context, temporary)) return;
      if (
        response.requiresConfirmation !== true || !Array.isArray(response.rows) || !response.rows.length || response.rows.length > 30 ||
        response.rows.some(row => typeof row.text !== "string" || row.text.length > 1000 || typeof row.label !== "string" || typeof row.uncertain !== "boolean")
      ) throw new Error("没有获得可确认的文字，请换一张清晰照片。");
      setRows(response.rows.map(row => {
        const number = /^\s*(\d+)\s*[.、:：)]?\s*$/.exec(row.label)?.[1];
        const item = number ? items[Number(number) - 1] : undefined;
        return { ...row, itemId: item && heard.has(item.id) ? item.id : "" };
      }));
      setPhase("confirm");
    } catch (cause) {
      if (alive.current && generation === sequence.current) {
        setError(controller.signal.aborted
          ? "识别已停止或超时。未自动重试，已处理的请求仍可能计费。请重新选图后再尝试。"
          : (cause instanceof Error ? cause.message : "识别失败，请重新选图后再尝试。"));
        setPhase("ready");
      }
    } finally {
      clearTimeout(timeout);
      // The gate stays closed: choose the photo again for another paid attempt.
      if (generation === sequence.current) request.current = null;
    }
  };
  const selected = rows.filter(row => row.itemId);
  const duplicate = new Set(selected.map(row => row.itemId)).size !== selected.length;
  const grade = () => {
    if (gradedOnce.current || phase !== "confirm" || !selected.length || duplicate || !memory.current || !contextStillCurrent(memory.current, temporary)) return;
    const graded = selected.flatMap(row => {
      const item = items.find(item => item.id === row.itemId && heard.has(item.id));
      return item ? [{ number: items.indexOf(item) + 1, correct: compareDictation(item.text, row.text).correct, expected: item.text, answer: row.text }] : [];
    });
    if (graded.length !== selected.length) { setError("题目范围已改变，请重新核对题号。"); return; }
    gradedOnce.current = true;
    setResults(graded);
    setPhase("graded");
    setPhoto(null);
    onGraded?.({ correct: graded.filter(row => row.correct).length, total: graded.length, assisted: true });
  };
  const updateRow = (index: number, patch: Partial<Row>) => setRows(old => old.map((item, i) => i === index ? { ...item, ...patch } : item));
  return (
    <section className="paper-dictation" aria-label="纸上听写批改">
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="选择听写照片"
        onChange={event => void choose(event.target.files?.[0])}
      />
      {phase === "idle" ? (
        <button type="button" className="text-button" disabled={!eligible.length} onClick={() => input.current?.click()}>
          <Camera size={17} aria-hidden="true" />拍照批改
        </button>
      ) : (
        <>
          <div className="paper-heading">
            <strong>纸上听写</strong>
            <button type="button" className="text-button" onClick={reset}>{phase === "graded" ? "完成" : "取消"}</button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview; it never leaves the device and has nothing to optimise. */}
          {photo && <img className="paper-preview" src={photo.url} alt="本次听写答卷预览" />}
          {(phase === "preparing" || phase === "loading") && (
            <p role="status">{phase === "preparing" ? "正在本机压缩照片…" : "正在识别文字，尚未判分…"}</p>
          )}
          {phase === "ready" && (
            <>
              <p className="dictation-note">识别这张听写照片，使用已配置模型的额度。</p>
              <div className="paper-actions">
                {!sent && <button type="button" className="primary" onClick={() => void recognize()}>识别文字</button>}
                <button type="button" className="text-button" onClick={() => input.current?.click()}>重新选图</button>
              </div>
            </>
          )}
          {phase === "confirm" && (
            <>
              <p>核对文字与对应题号，保留原来的拼写，然后确认批改。</p>
              <div className="paper-rows">
                {rows.map((row, index) => (
                  <div className="paper-row" key={index}>
                    <label>
                      <span>第 {index + 1} 行{row.uncertain ? " · 识别不确定" : ""}</span>
                      <textarea
                        aria-label={`第 ${index + 1} 行识别文字`}
                        value={row.text}
                        maxLength={1000}
                        onChange={event => updateRow(index, { text: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>对应题号{row.label ? `（原标记 ${row.label}）` : ""}</span>
                      <select aria-label={`第 ${index + 1} 行对应题号`} value={row.itemId} onChange={event => updateRow(index, { itemId: event.target.value })}>
                        <option value="">不计入</option>
                        {eligible.map(item => <option value={item.id} key={item.id}>第 {items.indexOf(item) + 1} 题</option>)}
                      </select>
                    </label>
                  </div>
                ))}
              </div>
              {duplicate && <p role="alert">同一道题只能对应一行，请调整题号。</p>}
              <button type="button" className="primary" disabled={!selected.length || duplicate} onClick={grade}>
                确认文字与题号，批改 {selected.length} 题
              </button>
            </>
          )}
          {phase === "graded" && (
            <div aria-live="polite">
              <p>已核对 {results.length} 题，答对 {results.filter(row => row.correct).length} 题。</p>
              <ul className="paper-results">
                {results.map(row => (
                  <li key={row.number}>
                    <strong>第 {row.number} 题 · {row.correct ? "正确" : "需订正"}</strong>
                    <span>你的作答：<span lang="en">{row.answer || "（空白）"}</span></span>
                    {!row.correct && <span>参考答案：<span lang="en">{row.expected}</span></span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="dictation-notice">{error}</p>}
    </section>
  );
}
