import type { ArticleSelectionSource, CompanionSelectionRequest } from "./companion-events";

export type ReadingPoint = { paragraph: number; offset: number };
export type ReadingQuote = CompanionSelectionRequest["quote"];
export const READING_QUOTE_LIMIT = 800;
export type ReadingSelection =
  | { ok: true; quote: ReadingQuote }
  | { ok: false; reason: "empty" | "outside" | "too-long"; message: string };

function validBoundary(text: string, offset: number) {
  return Number.isInteger(offset) && offset >= 0 && offset <= text.length
    && !(offset > 0 && offset < text.length
      && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

/** Recover the selected text from the source, including when lookup buttons split DOM text nodes. */
export function readingQuoteFromPoints(article: ArticleSelectionSource, a: ReadingPoint, b: ReadingPoint): ReadingSelection {
  const valid = (point: ReadingPoint) => Number.isInteger(point.paragraph)
    && point.paragraph >= 0 && point.paragraph < article.paragraphs.length
    && validBoundary(article.paragraphs[point.paragraph].text, point.offset);
  if (!valid(a) || !valid(b)) return { ok: false, reason: "outside", message: "请只选择文章正文。" };
  let [start, end] = a.paragraph < b.paragraph || (a.paragraph === b.paragraph && a.offset <= b.offset)
    ? [{ ...a }, { ...b }] : [{ ...b }, { ...a }];
  const textAt = (point: ReadingPoint) => article.paragraphs[point.paragraph].text;
  while ((start.paragraph < end.paragraph || start.offset < end.offset)
    && (start.offset === textAt(start).length || /\s/.test(textAt(start)[start.offset]))) {
    start = start.offset === textAt(start).length
      ? { paragraph: start.paragraph + 1, offset: 0 } : { ...start, offset: start.offset + 1 };
  }
  while ((start.paragraph < end.paragraph || start.offset < end.offset)
    && (end.offset === 0 || /\s/.test(textAt(end)[end.offset - 1]))) {
    end = end.offset === 0 ? { paragraph: end.paragraph - 1, offset: article.paragraphs[end.paragraph - 1].text.length }
      : { ...end, offset: end.offset - 1 };
  }
  const parts = article.paragraphs.slice(start.paragraph, end.paragraph + 1).map((paragraph, index) =>
    paragraph.text.slice(index === 0 ? start.offset : 0, index === end.paragraph - start.paragraph ? end.offset : paragraph.text.length));
  const text = parts.join("\n\n");
  if (!text.trim()) return { ok: false, reason: "empty", message: "先选一段文字，再问问 AI。" };
  if (Array.from(text).length > READING_QUOTE_LIMIT) return { ok: false, reason: "too-long", message: `请选取 ${READING_QUOTE_LIMIT} 字以内的片段。` };
  return { ok: true, quote: {
    id: `quote-${globalThis.crypto.randomUUID()}`, articleId: article.id, title: article.title,
    author: article.author || "", start, end, text,
    before: Array.from(article.paragraphs[start.paragraph].text.slice(0, start.offset)).slice(-300).join(""),
    after: Array.from(article.paragraphs[end.paragraph].text.slice(end.offset)).slice(0, 300).join(""),
  } };
}
