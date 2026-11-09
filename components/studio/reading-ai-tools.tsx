"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookA, Languages, MessageCircleQuestion, Sigma, X } from "lucide-react";
import type { LibraryArticle } from "@/lib/reading-library";
import { requestCompanionSelection, setCompanionArticle, type ArticleSelectionSource, type CompanionSelectionRequest } from "@/lib/companion-events";
import { readingQuoteFromPoints, type ReadingPoint, type ReadingSelection } from "@/lib/reading-ai-selection";
import "./reading-ai-tools.css";

type Tool = { result: ReadingSelection; left: number; top: number; below: boolean; keyboard: boolean };
type Action = CompanionSelectionRequest["action"];
const actions = [
  { id: "ask", label: "问问 AI", icon: MessageCircleQuestion },
  { id: "translate", label: "翻译", icon: Languages },
  { id: "define", label: "解释词义", icon: BookA },
  { id: "grammar", label: "分析语法", icon: Sigma },
] as const;

function pointFrom(root: HTMLElement, node: Node, offset: number): ReadingPoint | null {
  if (!root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const paragraph = element?.closest<HTMLElement>("[data-reading-ai-paragraph]");
  if (paragraph && root.contains(paragraph)) {
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEnd(node, offset);
    return { paragraph: Number(paragraph.dataset.readingAiParagraph), offset: range.toString().length };
  }
  // Between paragraph elements, use the next source paragraph; translated text is a separate surface.
  if (element?.closest(".reader-translation")) return null;
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  const paragraphs = [...root.querySelectorAll<HTMLElement>("[data-reading-ai-paragraph]")];
  for (const item of paragraphs) {
    const span = document.createRange(); span.selectNodeContents(item);
    if (boundary.compareBoundaryPoints(Range.START_TO_START, span) <= 0) return { paragraph: Number(item.dataset.readingAiParagraph), offset: 0 };
  }
  const last = paragraphs.at(-1);
  return last ? { paragraph: Number(last.dataset.readingAiParagraph), offset: last.textContent?.length ?? 0 } : null;
}

export default function ReadingAiTools({ article, fontSize, children }: { article: LibraryArticle; fontSize: number; children: ReactNode }) {
  const body = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const fromKeyboard = useRef(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const source = useMemo<ArticleSelectionSource>(() => ({
    id: article.id, title: article.title, author: article.author,
    paragraphs: article.paragraphs.map((paragraph, index) => ({ id: `${article.id}:${index}`, text: paragraph.en })),
  }), [article]);

  useEffect(() => {
    setCompanionArticle(source);
    return () => setCompanionArticle(null);
  }, [source]);

  const evaluate = useCallback(() => {
    const root = body.current, selection = window.getSelection();
    if (!root || !selection?.rangeCount || selection.isCollapsed) {
      if (!toolbar.current?.contains(document.activeElement)) setTool(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(root)) { setTool(null); return; }
    const start = pointFrom(root, range.startContainer, range.startOffset);
    const end = pointFrom(root, range.endContainer, range.endOffset);
    const result: ReadingSelection = start && end ? readingQuoteFromPoints(source, start, end)
      : { ok: false, reason: "outside", message: "请只选择文章正文。" };
    const rects = range.getClientRects(), last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const first = rects.length ? rects[0] : last;
    const below = window.matchMedia("(pointer: coarse)").matches || first.top < 120;
    const width = Math.min(340, window.innerWidth - 24);
    setTool({ result, keyboard: fromKeyboard.current, below,
      left: Math.max(12, Math.min(window.innerWidth - width - 12, below ? last.left : first.left)),
      top: below ? Math.max(12, Math.min(last.bottom + 10, window.innerHeight - 64)) : Math.max(60, first.top - 10),
    });
    fromKeyboard.current = false;
  }, [source]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, frame = 0;
    const change = () => { clearTimeout(timer); timer = setTimeout(evaluate, 100); };
    const move = () => {
      if (!frame && window.getSelection()?.isCollapsed === false) frame = requestAnimationFrame(() => { frame = 0; evaluate(); });
    };
    document.addEventListener("selectionchange", change);
    document.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", change);
      document.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [evaluate]);

  useLayoutEffect(() => { if (tool?.keyboard) toolbar.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [tool]);
  const close = (restore: boolean) => {
    window.getSelection()?.removeAllRanges(); setTool(null);
    if (restore) origin.current?.focus({ preventScroll: true });
  };
  const run = (action: Action) => {
    if (!tool?.result.ok) return;
    requestCompanionSelection({ article: source, quote: tool.result.quote, action });
    close(false);
  };
  const onParagraphKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).matches("[data-reading-ai-paragraph]")) return;
    if (event.key === "Escape") { close(true); return; }
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement;
    const paragraph = target.closest<HTMLElement>("[data-reading-ai-paragraph]");
    if (!paragraph) return;
    event.preventDefault();
    origin.current = paragraph;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    if (event.shiftKey && !selection.isCollapsed && selection.rangeCount && body.current?.contains(selection.getRangeAt(0).startContainer)) {
      range.setStart(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
      range.setEnd(paragraph, paragraph.childNodes.length);
    } else range.selectNodeContents(paragraph);
    selection.removeAllRanges(); selection.addRange(range);
    fromKeyboard.current = true; evaluate();
  };

  return <>
    <p className="sr-only">选中正文可提问、翻译或分析语法。键盘聚焦段落后按 Enter 选择，Shift+Enter 延伸选区。</p>
    <article ref={body} className="reader-prose" lang="en" translate="no" aria-label={article.title}
      style={{ fontSize: `${fontSize / 16}rem` }} onKeyDown={onParagraphKey}>{children}</article>
    {tool && createPortal(<div ref={toolbar} className={`reader-ai-toolbar${tool.below ? " is-below" : ""}${tool.result.ok ? "" : " is-error"}`}
      role="toolbar" aria-label="选文工具" style={{ left: tool.left, top: tool.top }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const buttons = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        }
      }}>
      {tool.result.ok ? actions.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={id === "ask" ? "is-primary" : ""} onClick={() => run(id)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)
        : <><p role="status">{tool.result.message}</p><button type="button" className="icon-button" aria-label="关闭选文提示" onClick={() => close(true)}><X size={15} aria-hidden="true" /></button></>}
    </div>, document.body)}
  </>;
}
