import { sentenceSpans, type Article } from "./data";

export type QuotePoint = { paragraph: number; offset: number };
export type Quote = {
  id: string; articleId: string; title: string; author: string;
  start: QuotePoint; end: QuotePoint; text: string;
  /** Kept in the composer after an answer so the next question can refer to it. */
  carried?: boolean;
};
export const QUOTE_LIMIT = 800;

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; reason: "empty" | "too-long" | "outside"; message: string };

let quoteCounter = 0;

/** Builds a quote from the article's own text, so the quote is exactly what the source says. */
export function quoteFromPoints(article: Article, a: QuotePoint, b: QuotePoint): QuoteResult {
  const valid = (point: QuotePoint) => point.paragraph >= 0 && point.paragraph < article.paragraphs.length
    && point.offset >= 0 && point.offset <= article.paragraphs[point.paragraph].text.length;
  if (!valid(a) || !valid(b)) return { ok: false, reason: "outside", message: "选区超出了文章正文。请只选择正文里的文字。" };
  let [start, end] = a.paragraph < b.paragraph || (a.paragraph === b.paragraph && a.offset <= b.offset) ? [a, b] : [b, a];
  // Trim spaces at both ends so the quote starts and ends on text.
  const at = (point: QuotePoint) => article.paragraphs[point.paragraph].text;
  while ((start.paragraph < end.paragraph || start.offset < end.offset) && (start.offset >= at(start).length || /\s/.test(at(start)[start.offset]))) {
    start = start.offset >= at(start).length ? { paragraph: start.paragraph + 1, offset: 0 } : { ...start, offset: start.offset + 1 };
  }
  while ((start.paragraph < end.paragraph || start.offset < end.offset) && (end.offset === 0 || /\s/.test(at(end)[end.offset - 1]))) {
    end = end.offset === 0 ? { paragraph: end.paragraph - 1, offset: at({ paragraph: end.paragraph - 1, offset: 0 }).length } : { ...end, offset: end.offset - 1 };
  }
  const parts: string[] = [];
  for (let index = start.paragraph; index <= end.paragraph; index++) {
    const text = article.paragraphs[index].text;
    parts.push(text.slice(index === start.paragraph ? start.offset : 0, index === end.paragraph ? end.offset : text.length));
  }
  const text = parts.join("\n\n").trim();
  if (!text) return { ok: false, reason: "empty", message: "还没有选中文字。拖动选择正文，或聚焦段落后按 Enter 选中整段。" };
  const length = parts.join("").length;
  if (length > QUOTE_LIMIT) return { ok: false, reason: "too-long", message: `选区有 ${length} 个字符，超过 ${QUOTE_LIMIT} 字符的引用上限。请缩小到一两段。` };
  quoteCounter += 1;
  return {
    ok: true,
    quote: { id: `quote-${Date.now().toString(36)}-${quoteCounter}`, articleId: article.id, title: article.title, author: article.author, start, end, text },
  };
}

export function paragraphLabel(quote: Pick<Quote, "start" | "end">) {
  return quote.start.paragraph === quote.end.paragraph ? `第 ${quote.start.paragraph + 1} 段` : `第 ${quote.start.paragraph + 1}–${quote.end.paragraph + 1} 段`;
}

export type QuotedSentence = { paragraph: number; sentence: number; text: string; partial: boolean };

/** Every sentence the quote touches; `partial` when the quote covers only part of it. */
export function sentencesInQuote(article: Article, quote: Pick<Quote, "start" | "end">): QuotedSentence[] {
  const out: QuotedSentence[] = [];
  for (let index = quote.start.paragraph; index <= quote.end.paragraph; index++) {
    const from = index === quote.start.paragraph ? quote.start.offset : 0;
    const to = index === quote.end.paragraph ? quote.end.offset : article.paragraphs[index].text.length;
    for (const span of sentenceSpans(article.paragraphs[index])) {
      if (span.end <= from || span.start >= to) continue;
      out.push({ paragraph: index, sentence: span.index, text: span.text, partial: from > span.start || to < span.end });
    }
  }
  return out;
}

/** The quote with the rest of its first and last sentences, for local context. */
export function quoteContext(article: Article, quote: Pick<Quote, "start" | "end" | "text">) {
  const first = sentenceSpans(article.paragraphs[quote.start.paragraph]).find((span) => quote.start.offset >= span.start && quote.start.offset <= span.end);
  const last = sentenceSpans(article.paragraphs[quote.end.paragraph]).find((span) => quote.end.offset >= span.start && quote.end.offset <= span.end);
  const before = first ? article.paragraphs[quote.start.paragraph].text.slice(first.start, quote.start.offset) : "";
  const after = last ? article.paragraphs[quote.end.paragraph].text.slice(quote.end.offset, last.end) : "";
  return { before, text: quote.text, after };
}
