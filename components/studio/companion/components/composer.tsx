import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, AudioLines, Check, ChevronDown, FileText, Image as ImageIcon, Plus, Quote as QuoteIcon, Square, X } from "lucide-react";
import { classifyTask, MODEL_IDS, MODEL_NAME, MODEL_USE, resolveRoute, routeTable, type Fallback, type ModelChoice } from "../routing";
import { paragraphLabel, quoteContext, type Quote } from "../selection";
import { attachmentText, formatBytes, statusLabel, type Attachment } from "../sources";
import { useStore } from "../store";
import { Popover } from "./popover";
import { Modal } from "./modal";
import { Thumb } from "./thumb";
import { withTransition } from "./transition";

type Preview = { kind: "quote"; quote: Quote } | { kind: "attachment"; attachment: Attachment } | null;

/** Prefilled question when a quote arrives from the reading toolbar; selected so typing replaces it. */
export const QUOTE_PREFILL = "这段在说什么？";
const handledFocus = new WeakMap<object, { generation: number; nonce: number }>();

export function Composer({ conversationId, variant, placeholder }: {
  conversationId: string;
  variant: "hero" | "dock" | "mini";
  placeholder?: string;
}) {
  const store = useStore();
  const { state, dispatch, currentArticle } = store;
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const draft = state.drafts[conversationId];
  const notice = state.notices[conversationId];
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState("");
  const [preview, setPreview] = useState<Preview>(null);
  const [dragging, setDragging] = useState(false);
  const streaming = conversation?.messages.some((message) => message.role === "assistant" && message.status === "streaming") ?? false;

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, variant === "mini" ? 160 : 240)}px`;
  }, [draft?.text, variant]);
  // Only an explicit request (send from the centred box, "ask AI", opening the small window) moves
  // the cursor here; switching pages or conversations never does.
  const focusNonce = state.focusNonce;
  const generation = state.generation;
  const focusOwner = store.getState;
  useEffect(() => {
    const element = area.current;
    const previous = handledFocus.get(focusOwner);
    if (!element || focusNonce === 0 || (previous?.generation === generation && focusNonce <= previous.nonce)) return;
    handledFocus.set(focusOwner, { generation, nonce: focusNonce });
    element.focus({ preventScroll: true });
    if (element.value === QUOTE_PREFILL) element.select();
    else element.setSelectionRange(element.value.length, element.value.length);
  }, [focusNonce, generation, focusOwner]);

  if (!conversation || !draft) return null;
  const available = store.articleAvailable(conversation, draft);
  const sourceCount = (draft.includeRecords ? 1 : 0) + (available && draft.includeArticle ? 1 : 0);

  // A quote kept from the previous answer is context, not something to send on its own.
  const hasContent = Boolean(draft.text.trim() || draft.attachments.length || draft.quotes.some((quote) => !quote.carried));

  const submit = (fallback?: Fallback) => {
    if (streaming) return;
    const run = () => {
      const outcome = store.send(conversationId, { fallback, articleAvailable: available });
      if (outcome.ok) dispatch({ type: "focus-composer" });
    };
    // The centred box hands over to the docked one; animate that move when motion is allowed.
    if (variant === "hero") withTransition(run); else run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (event.shiftKey && !modifier) return;
    if (state.settings.sendMode === "mod-enter" && !modifier) return;
    event.preventDefault();
    submit();
  };

  const addFiles = (files: File[]) => store.addFiles(conversationId, files);
  const removeAttachment = (attachment: Attachment) => store.removeAttachment(conversationId, attachment);
  const removeQuote = (quote: Quote) => {
    dispatch({ type: "draft", id: conversationId, patch: (latest) => ({ quotes: latest.quotes.filter((item) => item.id !== quote.id) }) });
    dispatch({ type: "announce", text: "已移除引用" });
  };
  const pick = (kind: "image" | "file") => {
    setAccept(kind === "image" ? "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" : ".txt,.md,.markdown,.csv,.pdf,.docx,text/plain,text/markdown,text/csv,application/pdf");
    requestAnimationFrame(() => fileInput.current?.click());
  };
  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const classification = classifyTask({ text: draft.text, hasQuote: draft.quotes.length > 0 });
  const table = routeTable(state.settings.complexPlanTier);
  const route = resolveRoute(classification, { conversation: conversation.model, preference: state.settings.routePreference }, table);

  return (
    <div className={`composer composer-${variant}${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {(draft.quotes.length > 0 || draft.attachments.length > 0) && (
        <ul className="chip-row" aria-label="这条消息的来源">
          {draft.quotes.map((quote) => (
            <li key={quote.id} className="source-chip quote-chip">
              <button type="button" className="chip-main" onClick={() => setPreview({ kind: "quote", quote })} aria-label={`查看引用：${quote.text.slice(0, 40)}`}>
                <QuoteIcon size={14} aria-hidden="true" />
                <span className="chip-text"><span className="chip-kicker">{quote.carried ? "继续追问" : "引用"} · {paragraphLabel(quote)}</span>{quote.text.replace(/\n+/g, " ")}</span>
              </button>
              <button type="button" className="chip-remove" aria-label="移除这段引用" onClick={() => removeQuote(quote)}><X size={14} aria-hidden="true" /></button>
            </li>
          ))}
          {draft.attachments.map((attachment) => (
            <li key={attachment.id} className={`source-chip file-chip status-${attachment.status}`}>
              <button type="button" className="chip-main" onClick={() => setPreview({ kind: "attachment", attachment })} aria-label={`查看附件 ${attachment.name}：${statusLabel(attachment)}`}>
                {attachment.previewUrl ? <Thumb src={attachment.previewUrl} alt="" className="chip-thumb" /> : attachment.kind === "image" ? <ImageIcon size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
                <span className="chip-text"><span className="chip-kicker">{statusLabel(attachment)}</span>{attachment.name}</span>
              </button>
              <button type="button" className="chip-remove" aria-label={`移除附件 ${attachment.name}`} onClick={() => removeAttachment(attachment)}><X size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="visually-hidden" htmlFor={`composer-${conversationId}-${variant}`}>消息</label>
      <textarea
        id={`composer-${conversationId}-${variant}`}
        ref={area}
        rows={1}
        value={draft.text}
        placeholder={placeholder ?? (draft.quotes.length ? "关于这段，你想问什么？" : "问一个词、一段话，或说说今天想练什么")}
        onChange={(event) => dispatch({ type: "draft", id: conversationId, patch: { text: event.target.value } })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        enterKeyHint={state.settings.sendMode === "enter" ? "send" : "enter"}
      />
      {notice && (
        <div className="composer-notice" role="alert">
          <p>{notice.message}</p>
          <div className="notice-actions">
            {notice.alternatives.map((fallback) => (
              <button key={fallback.label} type="button" className="button button-quiet" onClick={() => submit(fallback)}>{fallback.label}</button>
            ))}
            <button type="button" className="icon-button small" aria-label="关闭提示" onClick={() => dispatch({ type: "notice", id: conversationId, notice: undefined })}><X size={15} aria-hidden="true" /></button>
          </div>
        </div>
      )}
      <div className="composer-bar">
        <Popover label="来源" placement={variant === "hero" ? "bottom" : "top"} triggerClass="bar-button" triggerLabel={`来源，已附带 ${sourceCount} 项学习资料`}
          trigger={<><Plus size={17} aria-hidden="true" /><span className="bar-label">来源</span>{sourceCount > 0 && <span className="count">{sourceCount}</span>}</>}>
          {(close) => (
            <div className="source-menu">
              <p className="menu-title">添加到这条消息</p>
              <div className="menu-actions">
                <button type="button" className="menu-item" onClick={() => { close(); pick("image"); }}><ImageIcon size={17} aria-hidden="true" /><span>图片</span></button>
                <button type="button" className="menu-item" onClick={() => { close(); pick("file"); }}><FileText size={17} aria-hidden="true" /><span>文件</span></button>
              </div>
              <p className="menu-title">附带的学习资料</p>
              <label className="switch-row">
                <span>学习记录</span>
                <input type="checkbox" role="switch" checked={draft.includeRecords} onChange={(event) => dispatch({ type: "draft", id: conversationId, patch: { includeRecords: event.target.checked } })} />
                <span className="switch" aria-hidden="true" />
              </label>
              <label className={`switch-row${available ? "" : " is-disabled"}`}>
                <span>当前文章全文{available && <small>{currentArticle?.title}</small>}</span>
                <input type="checkbox" role="switch" disabled={!available} checked={available && draft.includeArticle} onChange={(event) => dispatch({ type: "draft", id: conversationId, patch: { includeArticle: event.target.checked } })} />
                <span className="switch" aria-hidden="true" />
              </label>
            </div>
          )}
        </Popover>
        <span className="bar-spacer" />
        <Popover label="模型" placement={variant === "hero" ? "bottom" : "top"} align="end" triggerClass={`bar-button route-button route-${route.source}`}
          triggerLabel={route.source === "auto" ? "模型：自动" : `模型：${MODEL_NAME[route.model]}`}
          trigger={<><span>{route.source === "auto" ? "自动" : MODEL_NAME[route.model]}</span><ChevronDown size={14} aria-hidden="true" /></>}>
          {(close) => <RouteMenu conversationId={conversationId} selected={conversation.model ?? state.settings.routePreference} close={close} />}
        </Popover>
        {/* One round button: stop while answering, send when there is something to send, otherwise voice. */}
        {streaming ? (
          <button type="button" className="send-button is-stop" aria-label="停止回答" onClick={() => store.stop(conversationId)}><Square size={13} fill="currentColor" aria-hidden="true" /></button>
        ) : hasContent ? (
          <button type="button" className="send-button" aria-label="发送" onClick={() => submit()}><ArrowUp size={18} aria-hidden="true" /></button>
        ) : (
          <button type="button" className="send-button is-voice" aria-label="语音会话" title="语音会话" onClick={() => dispatch({ type: "voice-open", open: true })}><AudioLines size={18} aria-hidden="true" /></button>
        )}
      </div>
      <input ref={fileInput} type="file" multiple hidden accept={accept} onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
      <Modal open={preview !== null} onClose={() => setPreview(null)} title={preview?.kind === "quote" ? "引用" : "附件"}>
        {preview?.kind === "quote" && <QuotePreview quote={preview.quote} />}
        {preview?.kind === "attachment" && <AttachmentPreview attachment={draft.attachments.find((item) => item.id === preview.attachment.id) ?? preview.attachment} />}
      </Modal>
    </div>
  );
}

function RouteMenu({ conversationId, selected, close }: { conversationId: string; selected: ModelChoice; close: () => void }) {
  const { dispatch } = useStore();
  const choose = (choice: ModelChoice) => {
    dispatch({ type: "conversation-model", id: conversationId, model: choice });
    dispatch({ type: "announce", text: choice === "auto" ? "这段对话改为自动选择模型" : `这段对话使用 ${MODEL_NAME[choice]}` });
    close();
  };
  return (
    <div className="route-menu">
      <p className="menu-title">模型</p>
      <div className="route-options" role="radiogroup" aria-label="这段对话的模型">
        <button type="button" role="radio" aria-checked={selected === "auto"} className="route-option" onClick={() => choose("auto")}>
          <span><strong>自动</strong><small>按问题选择</small></span>{selected === "auto" && <Check size={16} aria-hidden="true" />}
        </button>
        {MODEL_IDS.map((model) => (
          <button key={model} type="button" role="radio" aria-checked={selected === model} className="route-option" onClick={() => choose(model)}>
            <span><strong>{MODEL_NAME[model]}</strong><small>{MODEL_USE[model]}</small></span>{selected === model && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function QuotePreview({ quote }: { quote: Quote }) {
  const { currentArticle } = useStore();
  const context = quoteContext(currentArticle, quote);
  return (
    <div className="quote-preview">
      <p className="preview-meta">{quote.title} · {quote.author} · {paragraphLabel(quote)}</p>
      <blockquote className="reading-text">
        {context.before && <span className="context">{context.before}</span>}
        <mark>{quote.text}</mark>
        {context.after && <span className="context">{context.after}</span>}
      </blockquote>
    </div>
  );
}

export function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const text = attachmentText.get(attachment.id);
  return (
    <div className="attachment-preview">
      <p className="preview-meta">{attachment.name} · {formatBytes(attachment.size)}</p>
      <p className={`status-line status-${attachment.status}`}>{statusLabel(attachment)}</p>
      {attachment.previewUrl && <Thumb src={attachment.previewUrl} alt={`附件 ${attachment.name} 的预览`} className="preview-image" />}
      {attachment.status === "read" && text && (
        <>
          <p className="preview-label">已读取的文字（前 600 字）</p>
          <pre className="preview-text">{text.slice(0, 600)}</pre>
        </>
      )}
      {!attachment.previewUrl && attachment.status !== "read" && attachment.kind !== "text" && <p className="preview-note">没有可显示的预览。</p>}
    </div>
  );
}
