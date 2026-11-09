import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BarChart3, BookOpen, CalendarRange, Clock, Minimize2, PanelLeft, Search, SquarePen, Undo2 } from "lucide-react";
import { hasDraftContent, useStore } from "../store";
import type { Conversation } from "../types";
import { Composer } from "./composer";
import { MessageList } from "./messages";
import { TemporaryIcon } from "./icons";
import { useDismiss } from "./popover";
import { withTransition } from "./transition";
import { VoiceStage } from "./voice-stage";

export const SUGGESTIONS = [
  { icon: Clock, label: "安排 15 分钟听写", text: "我今天只有 15 分钟，帮我安排听写和复习" },
  { icon: BarChart3, label: "看看这周学习", text: "看看我这周的学习状态" },
  { icon: BookOpen, label: "陪我读一篇文章", text: "陪我读一篇文章" },
  { icon: CalendarRange, label: "安排两周复习", text: "帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词" },
] as const;


export function ChatView() {
  const store = useStore();
  const { state, active, newConversation, dispatch } = store;
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, setPending] = useState<null | { label: string; run: () => void }>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const empty = active.messages.length === 0;
  const returnTo = state.conversations.find((conversation) => conversation.id === state.returnToId);

  /** Leaving a temporary conversation that has content asks first, because it is discarded. */
  const guard = (label: string, run: () => void) => {
    if (active.temporary && active.messages.length > 0) setPending({ label, run });
    else run();
  };

  const lastMessage = active.messages.at(-1);
  const revealed = lastMessage?.role === "assistant" ? lastMessage.revealed + lastMessage.blocks.length : 0;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [active.id, active.messages.length, revealed]);
  useEffect(() => { stick.current = true; }, [active.id]);

  // A suggestion sends at once; the cursor follows only when it was chosen from the keyboard.
  const send = (text: string, fromKeyboard: boolean) => withTransition(() => {
    const outcome = store.send(active.id, { text, keepDraft: true });
    if (outcome.ok && fromKeyboard) dispatch({ type: "focus-composer" });
  });

  return (
    <section className={`chat${panelOpen ? " panel-open" : ""}`} aria-label="AI 对话">
      <ConversationPanel open={panelOpen} onClose={() => { setPanelOpen(false); toggle.current?.focus({ preventScroll: true }); }} guard={guard} />
      <div className="chat-main">
        {state.voiceOpen ? <VoiceStage key={active.id} conversationId={active.id} /> : (
          <>
            {/* Left: moving between conversations. Right: actions on this one, then leaving the page. */}
            <header className="chat-top">
              <button ref={toggle} type="button" className="icon-button" aria-label={panelOpen ? "收起对话列表" : "展开对话列表"} aria-expanded={panelOpen} title="对话列表" onClick={() => setPanelOpen((value) => !value)}>
                <PanelLeft size={19} aria-hidden="true" />
              </button>
              <div className="top-title">
                {!empty && !active.temporary && <span className="title-text">{active.title}</span>}
                {returnTo && returnTo.id !== active.id && (
                  <button type="button" className="return-chip" onClick={() => dispatch({ type: "select", id: returnTo.id })}>
                    <Undo2 size={14} aria-hidden="true" /><span>回到刚才的对话</span>
                  </button>
                )}
              </div>
              <div className="top-cluster">
                <button type="button" className="icon-button" aria-label="新对话" title="新对话" disabled={empty && !active.temporary && !hasDraftContent(state.drafts[active.id])}
                  onClick={() => guard("开始新对话", () => newConversation(false))}>
                  <SquarePen size={18} aria-hidden="true" />
                </button>
                <button type="button" className={`temp-toggle${active.temporary ? " is-on" : ""}`} aria-pressed={active.temporary}
                  aria-label={active.temporary ? "临时对话已开启，点按退出" : "开始临时对话"} title={active.temporary ? "退出临时对话" : "临时对话：不保存"}
                  onClick={() => active.temporary ? guard("退出临时对话", () => newConversation(false)) : newConversation(true)}>
                  <TemporaryIcon size={19} />
                  {active.temporary && <span>临时对话</span>}
                </button>
                <span className="top-divider" aria-hidden="true" />
                <button type="button" className="icon-button" aria-label="收起为小窗，回到学习页" title="收起为小窗"
                  onClick={() => guard("收起为小窗", () => { dispatch({ type: "view", view: state.lastLearnView }); dispatch({ type: "mini", open: true }); })}>
                  <Minimize2 size={18} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="chat-scroll" ref={scroller} onScroll={(event) => {
              const element = event.currentTarget;
              stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}>
              {empty ? (
                <div className="hero">
                  <h1 className="greeting">{active.temporary ? "临时对话" : "今天想学什么？"}</h1>
                  {active.temporary
                    ? <p className="hero-sub">不会保存</p>
                    : null}
                  <Composer conversationId={active.id} variant="hero" />
                  <ul className="suggestions" aria-label="可以这样开始">
                    {SUGGESTIONS.map(({ icon: Icon, label, text }) => (
                      <li key={label}><button type="button" onClick={(event) => send(text, event.detail === 0)}><Icon size={16} aria-hidden="true" />{label}</button></li>
                    ))}
                  </ul>
                </div>
              ) : (
                <MessageList messages={active.messages} conversationId={active.id} place="full" />
              )}
            </div>
            {!empty && (
              <div className="chat-dock">
                <Composer conversationId={active.id} variant="dock" />
              </div>
            )}
          </>
        )}
      </div>
      {pending && (
        <div className="confirm-layer" role="alertdialog" aria-modal="false" aria-labelledby="leave-temp-title">
          <div className="confirm-box">
            <h2 id="leave-temp-title">{pending.label}，并清除这段临时对话？</h2>
            <div className="confirm-actions">
              <button type="button" className="button button-quiet" autoFocus onClick={() => setPending(null)}>留在这里</button>
              <button type="button" className="button button-danger" onClick={() => { const run = pending.run; setPending(null); run(); }}>清除并离开</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ConversationPanel({ open, onClose, guard }: { open: boolean; onClose: () => void; guard: (label: string, run: () => void) => void }) {
  const { state, active, dispatch, newConversation, remove } = useStore();
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // Delete is a secondary action: long press (touch or mouse), right click, or the Delete key.
  const press = useRef<{ id: string; timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const endPress = () => { if (press.current) clearTimeout(press.current.timer); };
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer); }, []);
  const askDelete = (id: string) => { setConfirming(id); navigator.vibrate?.(10); };
  const startPress = (id: string, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    endPress();
    const timer = setTimeout(() => { if (press.current) { press.current.fired = true; askDelete(id); } }, 500);
    press.current = { id, timer, x: event.clientX, y: event.clientY, fired: false };
  };
  const movePress = (event: ReactPointerEvent) => {
    const current = press.current;
    if (current && !current.fired && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) { endPress(); press.current = null; }
  };
  const restoreFocus = (id: string) => requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-conv="${id}"]`)?.focus({ preventScroll: true }));
  const overlay = () => !window.matchMedia("(min-width: 1280px)").matches;
  useDismiss(open, panel, () => { if (overlay()) onClose(); });
  useEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);

  const visible = state.conversations.filter((conversation) => !conversation.temporary && (conversation.messages.length > 0 || (conversation.id !== active.id && hasDraftContent(state.drafts[conversation.id]))));
  const term = query.trim().toLowerCase();
  const matches = term ? visible.filter((conversation) => conversation.title.toLowerCase().includes(term) || conversation.messages.some((message) => message.role === "user" && message.text.toLowerCase().includes(term))) : visible;
  const sorted = [...matches].sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date().toDateString();
  const groups: [string, Conversation[]][] = [
    ["今天", sorted.filter((conversation) => new Date(conversation.updatedAt).toDateString() === today)],
    ["更早", sorted.filter((conversation) => new Date(conversation.updatedAt).toDateString() !== today)],
  ];
  const choose = (id: string) => {
    if (id === active.id) { onClose(); return; }
    guard("切换到另一段对话", () => {
      dispatch({ type: "select", id });
      if (overlay()) onClose();
    });
  };

  return (
    <>
      <div className="panel-scrim" hidden={!open} onClick={onClose} aria-hidden="true" />
      <aside ref={panel} className="conv-panel" aria-label="对话列表" hidden={!open}>
        <div className="panel-head">
          <button type="button" className="icon-button" aria-label="收起对话列表" onClick={onClose}><PanelLeft size={19} aria-hidden="true" /></button>
          <span className="panel-title">对话</span>
          <button type="button" className="icon-button" aria-label="新对话" onClick={() => guard("开始新对话", () => { newConversation(false); if (overlay()) onClose(); })}><SquarePen size={18} aria-hidden="true" /></button>
        </div>
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <input ref={search} type="search" value={query} placeholder="搜索对话" aria-label="搜索对话" onChange={(event) => setQuery(event.target.value)} />
        </label>
        {active.temporary && (
          <button type="button" className="conv-row is-current is-temp" onClick={onClose}>
            <TemporaryIcon size={16} /><span className="conv-title">临时对话</span>
          </button>
        )}
        <p id="conv-delete-hint" className="visually-hidden">长按、右键或按 Delete 键可以删除对话</p>
        <div className="conv-groups">
          {groups.map(([label, items]) => items.length > 0 && (
            <section key={label}>
              <h3>{label}</h3>
              <ul>
                {items.map((conversation) => {
                  const draftOnly = conversation.messages.length === 0;
                  return (
                    <li key={conversation.id} className={conversation.id === active.id ? "is-current" : ""}>
                      {confirming === conversation.id ? (
                        <div className="conv-confirm" role="group" aria-label={`删除「${conversation.title}」`}>
                          <span>删除这段对话？</span>
                          <button type="button" className="button button-danger small" onClick={() => { remove(conversation.id); setConfirming(null); search.current?.focus({ preventScroll: true }); }}>删除</button>
                          <button type="button" className="button button-quiet small" autoFocus onClick={() => { setConfirming(null); restoreFocus(conversation.id); }}>取消</button>
                        </div>
                      ) : (
                        <button type="button" className="conv-row" data-conv={conversation.id} aria-current={conversation.id === active.id ? "true" : undefined}
                          aria-keyshortcuts="Delete" aria-describedby="conv-delete-hint" title="长按或右键可删除"
                          onPointerDown={(event) => startPress(conversation.id, event)} onPointerMove={movePress}
                          onPointerUp={endPress} onPointerCancel={() => { endPress(); press.current = null; }} onPointerLeave={endPress}
                          onContextMenu={(event) => { event.preventDefault(); endPress(); askDelete(conversation.id); }}
                          onKeyDown={(event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); askDelete(conversation.id); } }}
                          onClick={() => {
                            // The click that ends a long press only opened the delete prompt.
                            if (press.current?.fired) { press.current = null; return; }
                            press.current = null;
                            choose(conversation.id);
                          }}>
                          <span className="conv-title">{draftOnly ? state.drafts[conversation.id]?.text.slice(0, 24) || "未发送的草稿" : conversation.title}
                            <small>{conversation.sample ? "示例" : draftOnly ? "草稿" : conversation.id === active.id ? "当前" : new Date(conversation.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small>
                          </span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {sorted.length === 0 && <p className="empty-note">{term ? "没有找到匹配的对话。" : "还没有保存的对话。"}</p>}
        </div>
      </aside>
    </>
  );
}
