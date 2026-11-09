import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BookA, Languages, MessageCircleQuestion, Sigma, X } from "lucide-react";
import { ARTICLE } from "../data";
import { quoteFromPoints, type QuotePoint, type QuoteResult } from "../selection";
import type { SelectionAction } from "../routing";
import { useStore } from "../store";
import { QUOTE_PREFILL } from "./composer";

type Tool = { result: QuoteResult; top: number; left: number; below: boolean; fromKeyboard: boolean };

/** Maps a DOM boundary inside the article body to a paragraph offset in the source text. */
function pointFrom(root: HTMLElement, node: Node, offset: number): QuotePoint | null {
  if (!root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const paragraph = element?.closest<HTMLElement>("[data-para]");
  if (paragraph && root.contains(paragraph)) {
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(node, offset);
    return { paragraph: Number(paragraph.dataset.para), offset: range.toString().length };
  }
  // A boundary between paragraphs (e.g. after a triple click) belongs to the next paragraph's start.
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  const paragraphs = [...root.querySelectorAll<HTMLElement>("[data-para]")];
  for (const item of paragraphs) {
    const span = document.createRange();
    span.selectNodeContents(item);
    if (boundary.compareBoundaryPoints(Range.START_TO_START, span) <= 0) return { paragraph: Number(item.dataset.para), offset: 0 };
  }
  const last = paragraphs.at(-1);
  return last ? { paragraph: Number(last.dataset.para), offset: last.textContent?.length ?? 0 } : null;
}

const ACTIONS: { id: "ask" | SelectionAction; label: string; icon: typeof Languages }[] = [
  { id: "ask", label: "问问 AI", icon: MessageCircleQuestion },
  { id: "translate", label: "翻译", icon: Languages },
  { id: "define", label: "解释词义", icon: BookA },
  { id: "grammar", label: "分析语法", icon: Sigma },
];
const ACTION_TEXT: Record<SelectionAction, string> = { translate: "翻译这段", define: "解释词义", grammar: "分析语法" };

export function ReadingView() {
  const store = useStore();
  const { active, dispatch } = store;
  const body = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const keyboardPending = useRef(false);

  const evaluate = useCallback(() => {
    const root = body.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (!toolbar.current?.contains(document.activeElement)) setTool(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(root)) { setTool(null); return; }
    const start = pointFrom(root, range.startContainer, range.startOffset);
    const end = pointFrom(root, range.endContainer, range.endOffset);
    const result: QuoteResult = start && end ? quoteFromPoints(ARTICLE, start, end) : { ok: false, reason: "outside", message: "选区包含正文以外的内容（标题、说明或页面其他部分）。请只选择文章正文。" };
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const first = rects.length ? rects[0] : rect;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    // Touch browsers show their own selection menu above the text; this one sits below it.
    const below = coarse || first.top < 120;
    const width = 340;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, (below ? rect.left : first.left)));
    // Keep the toolbar on screen even when the selection runs past the top or bottom edge.
    const top = below ? Math.min(rect.bottom + 10, window.innerHeight - 64) : Math.max(first.top - 10, 60);
    setTool({ result, top, left, below, fromKeyboard: keyboardPending.current });
    keyboardPending.current = false;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(evaluate, 120); };
    const onMove = () => { if (window.getSelection()?.isCollapsed === false) evaluate(); };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => { clearTimeout(timer); document.removeEventListener("selectionchange", onChange); window.removeEventListener("resize", onMove); document.removeEventListener("scroll", onMove, true); };
  }, [evaluate]);

  useLayoutEffect(() => {
    if (tool?.fromKeyboard) toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [tool]);

  const close = (restore: boolean) => {
    window.getSelection()?.removeAllRanges();
    setTool(null);
    if (restore) origin.current?.focus({ preventScroll: true });
  };

  const run = (action: "ask" | SelectionAction) => {
    if (!tool?.result.ok) return;
    const quote = tool.result.quote;
    const fromKeyboard = tool.fromKeyboard;
    if (action === "ask") {
      dispatch({
        type: "draft", id: active.id,
        patch: (draft) => {
          const kept = draft.quotes.filter((item) => !item.carried && item.text !== quote.text).slice(-2);
          return { quotes: [...kept, quote], text: draft.text.trim() ? draft.text : QUOTE_PREFILL };
        },
      });
      dispatch({ type: "mini", open: true });
      dispatch({ type: "focus-composer" });
      close(false);
      return;
    }
    store.send(active.id, { action, quotes: [quote], text: ACTION_TEXT[action], keepDraft: true, articleAvailable: true });
    dispatch({ type: "mini", open: true });
    close(fromKeyboard);
  };

  const onParagraphKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { close(true); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const selection = window.getSelection();
    const paragraph = event.currentTarget.querySelector<HTMLElement>("[data-para]");
    if (!selection || !paragraph) return;
    origin.current = event.currentTarget;
    const range = document.createRange();
    if (event.shiftKey && !selection.isCollapsed && selection.rangeCount) {
      // Shift+Enter extends the current selection to the end of this paragraph (across paragraphs).
      range.setStart(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
      range.setEnd(paragraph, paragraph.childNodes.length);
    } else {
      range.selectNodeContents(paragraph);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    keyboardPending.current = true;
    evaluate();
  };

  return (
    <div className="page reading-page">
      <header className="page-head reading-head">
        <p className="eyebrow">阅读 · {ARTICLE.difficulty} · {ARTICLE.form === "excerpt" ? "原文节选" : "原文"}</p>
        <h1 className="reading-title">{ARTICLE.title}</h1>
        <p className="reading-sub">{ARTICLE.titleZh} · {ARTICLE.author}</p>
        <p className="reading-meta">
          来源：<a href={ARTICLE.sourceUrl} target="_blank" rel="noreferrer">NOAA National Ocean Service</a> · {ARTICLE.rights.label}
        </p>
        <p className="reading-hint">选中正文即可翻译、解释词义、分析语法或带着引用提问。键盘：聚焦段落后按 Enter 选中整段，Shift+Enter 把选区延伸到下一段。</p>
      </header>
      <div className="reading-body" ref={body}>
        {ARTICLE.paragraphs.map((paragraph, index) => (
          <div key={index} className="para-row" tabIndex={0} aria-label={`第 ${index + 1} 段`} onKeyDown={onParagraphKey}>
            <span className="para-num" aria-hidden="true">{index + 1}</span>
            <p data-para={index} className="reading-text">{paragraph.text}</p>
          </div>
        ))}
      </div>
      <p className="reading-rights">{ARTICLE.rights.basis}</p>
      {tool && (
        <div ref={toolbar} className={`select-toolbar${tool.below ? " is-below" : ""}${tool.result.ok ? "" : " is-error"}`} role="toolbar" aria-label="选文工具"
          style={{ top: tool.top, left: tool.left }}
          onPointerDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); close(true); }
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              const buttons = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
            }
          }}>
          {tool.result.ok ? ACTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={id === "ask" ? "is-primary" : ""} onClick={() => run(id)}>
              <Icon size={15} aria-hidden="true" /><span>{label}</span>
            </button>
          )) : (
            <>
              <p role="status">{tool.result.message}</p>
              <button type="button" className="icon-button small" aria-label="关闭提示" onClick={() => close(true)}><X size={14} aria-hidden="true" /></button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
