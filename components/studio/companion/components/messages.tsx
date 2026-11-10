import { memo, useEffect, useRef, useState } from "react";
import { AudioLines, BookOpen, Check, Copy, FileText, Headphones, Image as ImageIcon, Quote as QuoteIcon, RotateCcw } from "lucide-react";
import { MODEL_NAME } from "../routing";
import { paragraphLabel, type Quote } from "../selection";
import { statusLabel } from "../sources";
import { useStore } from "../store";
import type { Action, AssistantMessage, Message, UserMessage, ResultMessage } from "../types";
import { TraceGlyph } from "./icons";
import { Modal } from "./modal";
import { Thumb } from "./thumb";
import { QuotePreview } from "./composer";
import { AiProvenance } from "../../ai/ai-provenance";
import { chatToolSummary } from "@/lib/assistant/tool-trace";

type Place = "full" | "mini";
type Actions = Pick<ReturnType<typeof useStore>, "send" | "dispatch" | "runAction">;

export const MessageList = memo(function MessageList({ messages, conversationId, place }: { messages: Message[]; conversationId: string; place: Place }) {
  const { send, dispatch, runAction } = useStore();
  return <ol className={`thread thread-${place}`} aria-label="对话内容">
    {messages.map((message) => <MessageRow key={message.id} message={message} conversationId={conversationId} send={send} dispatch={dispatch} runAction={runAction} />)}
  </ol>;
});

const MessageRow = memo(function MessageRow({ message, conversationId, send, dispatch, runAction }: { message: Message; conversationId: string } & Actions) {
  return <li className={`message message-${message.role}`}>
    {message.role === "user" && <UserBubble message={message} />}
    {message.role === "assistant" && <AssistantReply message={message} conversationId={conversationId} send={send} dispatch={dispatch} runAction={runAction} />}
    {message.role === "result" && <PracticeResultCard message={message} conversationId={conversationId} send={send} runAction={runAction} />}
    {message.role === "voice" && <section className="voice-card" aria-label="语音记录"><p className="answer-source"><AudioLines size={15} aria-hidden="true" />语音对话</p>{message.captions.map((caption, index) => <p key={index}><strong>{caption.speaker === "user" ? "你" : "AI"}</strong>　{caption.text}</p>)}</section>}
  </li>;
});

function UserBubble({ message }: { message: UserMessage }) {
  const [preview, setPreview] = useState<Quote | null>(null);
  return <div className="user-turn">
    {message.quotes.map((quote) => <button key={quote.id} type="button" className="sent-quote" onClick={() => setPreview(quote)}>
      <QuoteIcon size={13} aria-hidden="true" /><span className="reading-text">{quote.text.replace(/\n+/g, " ")}</span>
      <span className="sent-quote-meta">{quote.title} · {paragraphLabel(quote)}</span>
    </button>)}
    {message.attachments.length > 0 && <ul className="sent-files" aria-label="附件">{message.attachments.map((attachment) => <li key={attachment.id} className={`sent-file status-${attachment.status}`}>
      {attachment.previewUrl ? <Thumb src={attachment.previewUrl} alt="" className="chip-thumb" /> : attachment.kind === "image" ? <ImageIcon size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
      <span><strong>{attachment.name}</strong><small>{statusLabel(attachment)}</small></span>
    </li>)}</ul>}
    {message.text && <p className="bubble">{message.via === "voice" && <AudioLines size={14} aria-label="语音" />}{message.text}</p>}
    <Modal open={preview !== null} onClose={() => setPreview(null)} title="引用">{preview && <QuotePreview quote={preview} />}</Modal>
  </div>;
}

function RichText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((paragraph, index) => {
    const lines = paragraph.split("\n");
    if (lines.every((line) => /^(?:· |[-*] |\d+[.)] )/.test(line))) return <ul key={index} className="plain-list">{lines.map((line, item) => <li key={item}>{line.replace(/^(?:· |[-*] |\d+[.)] )/, "")}</li>)}</ul>;
    return <p key={index}>{paragraph}</p>;
  })}</>;
}

function AssistantReply({ message, conversationId, send, dispatch, runAction }: { message: AssistantMessage; conversationId: string } & Actions) {
  const { words } = useStore();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const streaming = message.status === "streaming";
  const hasText = message.blocks.some(block => block.type === "text" && block.text);
  const lastText = message.blocks.findLastIndex(block => block.type === "text" && block.text);
  const progressLabel = message.progress?.phase === "tool" ? "正在使用学习工具" : message.progress?.phase === "verifying" ? "正在整理回答" : "思考中";
  const toolSummary = chatToolSummary(message.toolSteps ?? []);
  const modelName = MODEL_NAME[message.request.model] ?? message.request.model;
  const copy = async () => {
    const text = message.blocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch { dispatch({ type: "announce", text: "复制失败，请选择文字后复制。" }); }
  };
  return <div className="ai-turn" aria-busy={streaming} data-model={message.request.model} data-effort={message.request.reasoning.effort}>
    <span className="ai-mark" aria-hidden="true"><TraceGlyph size={18} /></span>
    <div className="ai-body">
      {streaming && !hasText && <p className="reply-pending" role="status"><span className="thinking-label">{progressLabel}</span><span className="thinking-caret" aria-hidden="true" /></p>}
      {message.reasoningSummary && <details className="reasoning-summary">
        <summary>思考摘要</summary>
        <div><p className="reasoning-note">模型提供的推理摘要 · AI 生成</p><RichText text={message.reasoningSummary} /></div>
      </details>}
      {message.blocks.map((block, index) => {
        if (block.type === "text") return <div className={`ai-text${streaming && index === lastText ? " is-revealing" : ""}`} key={index}><RichText text={block.text} /></div>;
        if (block.type === "actions") return <div className="companion-actions" key={index}>{block.actions.map((action) => <ActionCard key={action.id} action={action} onRun={() => runAction(action)} />)}</div>;
        if (block.type === "notice") return <div key={index} className={`inline-notice tone-${block.tone}`}><p>{block.text}</p></div>;
        return null;
      })}
      {message.blocks.some(block => block.type === "text" && block.text) && <>
        <p className="status-note">AI 生成内容 · 教材原文未核验{message.provenance?.userProvidedMaterial ? " · 引用、文章与附件按用户提供材料处理" : ""}</p>
        <AiProvenance result={message.provenance ?? {}} words={words} />
      </>}
      {message.status === "stopped" && <p className="status-note">已停止</p>}
      {message.status === "incomplete" && <button type="button" className="link-button" onClick={() => send(conversationId, { text: "继续刚才的回答", keepDraft: true })}>继续回答</button>}
      {!streaming && <div className="msg-meta">{toolSummary && <span className="tool-summary">{toolSummary}</span>}<span className="meta-model" aria-label={`回答模型：${modelName}`}>{modelName}</span><button type="button" className="icon-button small" aria-label={copied ? "已复制" : "复制回答文字"} onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button></div>}
    </div>
  </div>;
}

function ActionCard({ action, onRun }: { action: Action; onRun: () => void }) {
  const Icon = action.intent === "open-reading" ? BookOpen : action.intent === "start-dictation" ? Headphones : RotateCcw;
  return <button type="button" className="companion-action-card" onClick={onRun}>
    <Icon size={20} aria-hidden="true" /><span><strong>{action.label}</strong>{"wordIds" in action && action.wordIds && <small>{action.wordIds.length} 个词</small>}</span><span className="action-arrow" aria-hidden="true">↗</span>
  </button>;
}

function PracticeResultCard({ message, conversationId, send, runAction }: { message: ResultMessage; conversationId: string } & Pick<Actions, "send" | "runAction">) {
  const first = message.result.rounds[0] ?? [];
  const latest = new Map(message.result.rounds.flat().map((row) => [row.item.id, row]));
  const mistakes = [...latest.values()].filter((row) => !row.score.correct);
  const correct = first.filter((row) => row.score.correct).length;
  return <section className="companion-result-card" aria-label="练习结果">
    <p className="answer-source">练习结果 · {message.result.source}</p>
    <h3>{message.result.title}</h3>
    <p className="companion-result-score"><strong>{correct}<small> / {first.length}</small></strong><span>首次作答正确</span></p>
    {message.result.rounds.length > 1 && <p className="companion-result-detail">后续巩固 {message.result.rounds.slice(1).reduce((count, round) => count + round.length, 0)} 次</p>}
    {mistakes.length > 0 && <ul className="companion-result-mistakes">{mistakes.map((row) => <li key={row.item.id}><strong>{row.item.text}</strong><span>{row.answer ? `你的答案：${row.answer}` : "未能独立回忆"}</span></li>)}</ul>}
    <div className="companion-result-actions">
      {mistakes.length > 0 && <button type="button" className="button button-secondary" onClick={() => runAction({ id: `retry-${message.id}`, label: "只重练错项", title: "错项重练", intent: message.result.mode === "review" ? "start-review" : "start-dictation", minutes: 10, wordIds: mistakes.map((row) => row.item.id) })}>只重练错项</button>}
      <button type="button" className="button button-quiet" onClick={() => send(conversationId, { text: "根据刚才的实际练习结果，帮我分析问题并安排下一步", keepDraft: true })}>分析这次练习</button>
    </div>
  </section>;
}
