import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CircleUserRound, Minimize2, PanelLeft, Search, SquarePen, Undo2 } from "lucide-react";
import { hasDraftContent, useStore } from "../store";
import { Composer } from "./composer";
import { MessageList } from "./messages";
import { TemporaryIcon } from "./icons";
import { useDismiss } from "./popover";
import { withTransition } from "./transition";
import { VoiceStage } from "./live-voice-stage";

/** Openers written the way a learner would say them. */
export const SUGGESTIONS = [
  { label: "今天只有 15 分钟，怎么练", text: "我今天只有 15 分钟，帮我安排听写和复习" },
  { label: "这周哪些词老是错", text: "看看我这周的学习状态，哪些词反复出错" },
  { label: "陪我读一篇文章", text: "陪我读一篇文章" },
  { label: "两周后考试，排个复习表", text: "帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词" },
] as const;

/** The opening line states what the learner's own records say is waiting, when anything is. */
export function openingLine(study: { due: number; weak: number } | undefined): string {
  if (study && study.due > 0) return `今天有 ${study.due} 个词该复习了`;
  if (study && study.weak > 0) return `还有 ${study.weak} 个词不太稳`;
  return "想从哪儿开始？";
}
/** The list shows a search field once there is enough to search. */
const SEARCH_FROM = 6;
const dayLabel = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const timeLabel = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
type ConversationRow = { id: string; title: string; note: string; current: boolean; today: boolean };

export function ChatView() {
  const store = useStore();
  const { state, active, newConversation, dispatch, study } = store;
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
                  <h1 className="greeting">{active.temporary ? "临时对话" : openingLine(study)}</h1>
                  {active.temporary
                    ? <p className="hero-sub">不会保存</p>
                    : null}
                  <Composer conversationId={active.id} variant="hero" />
                  <ul className="suggestions" aria-label="可以这样开始">
                    {SUGGESTIONS.map(({ label, text }) => (
                      <li key={label}><button type="button" onClick={(event) => send(text, event.detail === 0)}>{label}</button></li>
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
  const collapse = useRef<HTMLButtonElement>(null);
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
  const choose = (id: string) => {
    if (id === active.id) { onClose(); return; }
    guard("切换到另一段对话", () => {
      dispatch({ type: "select", id });
      if (overlay()) onClose();
    });
  };

  // Typing changes the active draft on every key. The list depends only on saved conversations
  // and on other conversations' unsent drafts, so it is rebuilt when one of those changes, and
  // not at all while the panel is closed.
  const term = query.trim().toLowerCase(), activeId = active.id;
  const waitingDrafts = open ? state.conversations.filter((conversation) => !conversation.temporary && !conversation.messages.length && conversation.id !== activeId && hasDraftContent(state.drafts[conversation.id]))
    .map((conversation) => `${conversation.id}\u0000${state.drafts[conversation.id]?.text.slice(0, 24) ?? ""}`).join("\u0001") : "";
  const listed = useMemo(() => {
    if (!open) return { rows: [] as ConversationRow[], saved: 0 };
    const drafts = new Map(waitingDrafts ? waitingDrafts.split("\u0001").map((item) => item.split("\u0000") as [string, string]) : []);
    const visible = state.conversations.filter((conversation) => !conversation.temporary && (conversation.messages.length > 0 || drafts.has(conversation.id)));
    const matches = term ? visible.filter((conversation) => conversation.title.toLowerCase().includes(term) || conversation.messages.some((message) => message.role === "user" && message.text.toLowerCase().includes(term))) : visible;
    const today = new Date().toDateString();
    const rows = [...matches].sort((a, b) => b.updatedAt - a.updatedAt).map((conversation): ConversationRow => {
      const draftOnly = conversation.messages.length === 0, current = conversation.id === activeId, sameDay = new Date(conversation.updatedAt).toDateString() === today;
      return { id: conversation.id, current, today: sameDay,
        title: draftOnly ? drafts.get(conversation.id) || "未发送的草稿" : conversation.title,
        note: draftOnly ? "草稿" : current ? "当前" : (sameDay ? timeLabel : dayLabel).format(conversation.updatedAt) };
    });
    return { rows, saved: visible.length };
  }, [open, state.conversations, waitingDrafts, term, activeId]);
  const searchable = listed.saved >= SEARCH_FROM || term !== "";
  // Focus moves into the panel when it opens. A touch keyboard should not cover the list, so
  // only a keyboard-and-mouse device starts in the search field.
  useEffect(() => {
    if (!open) return;
    const target = window.matchMedia("(hover: hover) and (pointer: fine)").matches ? search.current ?? collapse.current : collapse.current;
    target?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={panel} className="conv-panel" aria-label="对话列表">
        <div className="panel-head">
          <button ref={collapse} type="button" className="icon-button" aria-label="收起对话列表" onClick={onClose}><PanelLeft size={19} aria-hidden="true" /></button>
          <span className="panel-title">对话</span>
          <button type="button" className="icon-button" aria-label="新对话" onClick={() => guard("开始新对话", () => { newConversation(false); if (overlay()) onClose(); })}><SquarePen size={18} aria-hidden="true" /></button>
        </div>
        {searchable && (
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input ref={search} type="search" value={query} placeholder="搜索对话" aria-label="搜索对话" onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
        {active.temporary && (
          <button type="button" className="conv-row is-current is-temp" onClick={onClose}>
            <TemporaryIcon size={16} /><span className="conv-title">临时对话</span>
          </button>
        )}
        <p id="conv-delete-hint" className="visually-hidden">长按、右键或按 Delete 键可以删除对话</p>
        <div className="conv-groups">
          {([["今天", listed.rows.filter((row) => row.today)], ["更早", listed.rows.filter((row) => !row.today)]] as const).map(([label, items]) => items.length > 0 && (
      <section key={label}>
        <h3>{label}</h3>
        <ul>
          {items.map((row) => (
            <li key={row.id} className={row.current ? "is-current" : ""}>
              {confirming === row.id ? (
                <div className="conv-confirm" role="group" aria-label={`删除「${row.title}」`}>
                  <span>删除这段对话？</span>
                  <button type="button" className="button button-danger small" onClick={() => { remove(row.id); setConfirming(null); (search.current ?? collapse.current)?.focus({ preventScroll: true }); }}>删除</button>
                  <button type="button" className="button button-quiet small" autoFocus onClick={() => { setConfirming(null); restoreFocus(row.id); }}>取消</button>
                </div>
              ) : (
                <button type="button" className="conv-row" data-conv={row.id} aria-current={row.current ? "true" : undefined}
                  aria-keyshortcuts="Delete" aria-describedby="conv-delete-hint" title="长按或右键可删除"
                  onPointerDown={(event) => startPress(row.id, event)} onPointerMove={movePress}
                  onPointerUp={endPress} onPointerCancel={() => { endPress(); press.current = null; }} onPointerLeave={endPress}
                  onContextMenu={(event) => { event.preventDefault(); endPress(); askDelete(row.id); }}
                  onKeyDown={(event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); askDelete(row.id); } }}
                  onClick={() => {
                    // The click that ends a long press only opened the delete prompt.
                    if (press.current?.fired) { press.current = null; return; }
                    press.current = null;
                    choose(row.id);
                  }}>
                  <span className="conv-title">{row.title}<small>{row.note}</small></span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    ))}
          {listed.rows.length === 0 && <p className="empty-note">{term ? "没有找到匹配的对话。" : "还没有保存的对话。"}</p>}
        </div>
        <button type="button" className="panel-account" onClick={() => { onClose(); dispatch({ type: "settings-open", section: "general" }); }}><CircleUserRound size={20} aria-hidden="true" /><span>我的学习</span></button>
      </aside>
    </>
  );
}
