"use client";

import { useEffect, useRef, useState } from "react";
import { Check, MessageCircle, Plus, Send } from "lucide-react";
import { feedbackTranscript, voiceRequest, type TranscriptTurn } from "@/lib/voice/client";

export type DiscussionMessage = { role: "user" | "assistant"; text: string };
export function PracticeDiscussion({ sessionKey, topicId, level, transcript, messages, onChange, configured, onRemember, remembered = [], memoryBusy = false }: {
  sessionKey: string; topicId: string; level: string; transcript: TranscriptTurn[]; messages: DiscussionMessage[];
  onChange: (messages: DiscussionMessage[]) => void; configured: boolean;
  onRemember: (text: string) => Promise<boolean>; remembered?: string[]; memoryBusy?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [memoryError, setMemoryError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => abortRef.current?.abort(), [sessionKey, transcript]);
  const ask = async (question: string) => {
    if (!question.trim() || inFlight.current || !configured) return;
    abortRef.current?.abort(); const abort = new AbortController(); abortRef.current = abort;
    inFlight.current = true; setBusy(true); setError(""); setMemoryError("");
    const next: DiscussionMessage[] = [...messages, { role: "user" as const, text: question.trim() }].slice(-19);
    let room = 11000;
    const context = next.slice().reverse().flatMap((item) => { const text = item.text.slice(-Math.min(3000, room)); room -= text.length; return text ? [{ ...item, text }] : []; }).reverse();
    try {
      const result = await voiceRequest<{ reply: string; memorySuggestions: string[] }>("/api/voice/discuss", { topicId, level, transcript: feedbackTranscript(transcript, 12000), messages: context }, abort.signal);
      if (abort.signal.aborted) return;
      onChange([...next, { role: "assistant", text: result.reply }]);
      setSuggestions(result.memorySuggestions || []); setDraft("");
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" }));
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "暂时无法回复，请重试。"); }
    finally { inFlight.current = false; if (!abort.signal.aborted) setBusy(false); }
  };
  return <section className="voice-discussion" aria-label="练习后对话">
    <div className="voice-section-heading"><h2><MessageCircle size={21} />聊聊刚才的练习</h2><span className="voice-muted">文字复盘</span></div>
    {!messages.length && <div className="voice-discussion-welcome"><p>刚才哪里说得顺，哪里还想再试一次？可以请我总结，也可以直接问一句话怎么表达。</p><div className="voice-discussion-starters">{["总结这次练习，给我一两条具体建议。", "选一句我说过的话，教我更自然的表达。"].map((question, index) => <button className="secondary" key={question} disabled={busy || !configured} onClick={() => void ask(question)}>{index === 0 ? "总结这次练习" : "改进一句表达"}</button>)}</div></div>}
    <div className="voice-discussion-messages" aria-live="polite" aria-busy={busy}>{messages.map((message, index) => <div className={`voice-discussion-message ${message.role}`} key={index}><span>{message.role === "user" ? "你" : "英语伙伴"}</span><p>{message.text}</p></div>)}{busy && <p className="voice-muted">正在想一想刚才的表达…</p>}<div ref={endRef} /></div>
    {suggestions.length > 0 && <div className="voice-memory-suggestions"><p>下次可以记住这些</p>{suggestions.map((note) => { const added = remembered.includes(note); return <button className="secondary" key={note} disabled={added || memoryBusy} onClick={async () => { if (await onRemember(note)) { setMemoryError(""); } else setMemoryError("未能保存这条记忆，请在学习记忆中重新读取后再试。"); }}>{added ? <Check size={16} /> : <Plus size={16} />}<span>{note}</span><small>{added ? "已记住" : "记住这条"}</small></button>; })}<small>由你确认后保存；你可以随时在学习记忆中编辑或删除。</small></div>}
    {(error || memoryError) && <p role="alert" className="voice-notice">{error || memoryError}</p>}
    <form className="voice-discussion-form" onSubmit={(event) => { event.preventDefault(); void ask(draft); }}><label htmlFor="voice-discussion-input">继续聊</label><div><textarea id="voice-discussion-input" rows={2} maxLength={1000} value={draft} disabled={busy} placeholder="例如：为什么这里用 would，而不是 will？" onChange={(event) => setDraft(event.target.value)} /><button type="submit" className="primary" disabled={busy || !configured || !draft.trim()} aria-label="发送复盘问题"><Send size={18} /></button></div></form>
    <p className="voice-muted">参考本次转写和已启用的学习记忆；转写有误时可先在下方修正。发送问题会使用文字模型额度，不能据此评价发音。</p>
  </section>;
}
