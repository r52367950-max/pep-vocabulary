import { useEffect, useLayoutEffect, useRef } from "react";
import { ChevronDown, Maximize2, SquarePen } from "lucide-react";
import { useStore } from "../store";
import { Composer } from "./composer";
import { TemporaryIcon, TraceGlyph } from "./icons";
import { MessageList } from "./messages";

const CONTEXT_SUGGESTIONS: Record<string, { label: string; text: string }[]> = {
  reading: [
    { label: "这篇的生词有哪些", text: "这篇文章里有哪些需要先认识的词？" },
    { label: "读完安排 10 分钟练习", text: "读完这篇，帮我安排 10 分钟练习" },
  ],
  dictation: [
    { label: "听写时容易错什么", text: "看看我最近听写容易错在哪里" },
  ],
  default: [
    { label: "安排 15 分钟", text: "我今天只有 15 分钟，帮我安排" },
    { label: "看看这周学习", text: "看看我这周的学习状态" },
  ],
};

/** The corner launcher: small, round and quiet; it toggles the in-place window. */
export function Launcher() {
  const { state, dispatch } = useStore();
  const open = state.miniOpen;
  return (
    <button type="button" className={`launcher${open ? " is-open" : ""}`} aria-expanded={open} aria-controls="mini-panel"
      aria-label={open ? "收起 AI 小窗" : "问 AI（在这一页提问）"} title={open ? "收起" : "问 AI"}
      onClick={() => { dispatch({ type: "mini", open: !open }); if (!open) dispatch({ type: "focus-composer" }); }}>
      {open ? <ChevronDown size={20} aria-hidden="true" /> : <TraceGlyph size={22} />}
    </button>
  );
}

export function MiniPanel() {
  const { state, active, dispatch, newConversation, openChat, send, currentArticle } = useStore();
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const empty = active.messages.length === 0;
  const last = active.messages.at(-1);
  const progress = last?.role === "assistant" ? last.revealed + last.blocks.length : 0;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active.id, active.messages.length, progress]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !panel.current?.contains(document.activeElement) || document.querySelector(".popover, dialog[open]")) return;
      dispatch({ type: "mini", open: false });
      document.querySelector<HTMLElement>(".launcher")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dispatch]);
  const view = state.view === "reading" && currentArticle ? "reading" : state.view === "dictation" ? "dictation" : "default";
  const context = view === "reading" && currentArticle ? `正在读：${currentArticle.title}` : view === "dictation" ? "正在听写" : null;

  return (
    <section ref={panel} id="mini-panel" className="mini-panel" aria-label="AI 小窗">
      <header className="mini-head">
        <span className="mini-title">
          {active.temporary ? <TemporaryIcon size={16} /> : <TraceGlyph size={16} />}
          <span>{active.temporary ? "临时对话" : empty ? "问 AI" : active.title}</span>
        </span>
        <button type="button" className="icon-button small" aria-label="新对话" title="新对话" disabled={empty && !active.temporary} onClick={() => newConversation(false)}><SquarePen size={16} aria-hidden="true" /></button>
        <button type="button" className="icon-button small" aria-label="展开为完整对话" title="展开" onClick={() => openChat()}><Maximize2 size={16} aria-hidden="true" /></button>
        <button type="button" className="icon-button small" aria-label="收起小窗" title="收起" onClick={() => { dispatch({ type: "mini", open: false }); document.querySelector<HTMLElement>(".launcher")?.focus(); }}><ChevronDown size={18} aria-hidden="true" /></button>
      </header>
      <div className="mini-scroll" ref={scroller}>
        {empty ? (
          <div className="mini-empty">
            <p className="mini-greeting">{context ?? "在这一页问点什么"}</p>
            <ul className="suggestions compact">
              {CONTEXT_SUGGESTIONS[view].map((item) => <li key={item.label}><button type="button" onClick={() => send(active.id, { text: item.text, keepDraft: true })}>{item.label}</button></li>)}
            </ul>
          </div>
        ) : (
          <MessageList messages={active.messages} conversationId={active.id} place="mini" />
        )}
      </div>
      <div className="mini-dock">
        <Composer conversationId={active.id} variant="mini" />
      </div>
    </section>
  );
}
