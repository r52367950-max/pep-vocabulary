import { countReadingWords } from "./reading-library";

export type PdfTextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
type PdfTextChunk = { items: PdfTextItem[]; styles?: Record<string, unknown> };
export type PdfTextPage = { streamTextContent: () => ReadableStream<PdfTextChunk> };
export const PDF_DECODE_LIMITS = { maxDecodedStreamBytes: 64 * 1024 * 1024, maxDecodedDocumentBytes: 256 * 1024 * 1024 };
const PDF_TEXT_LIMITS = { items: 24_000, characters: 120_000, styles: 512, words: 6000 };
const limitError = () => new Error("这份 PDF 的解码内容或文字过多，请选取完整的一篇文章或减少页数后重试。");

/** Shared by all pages; separate from compressed input and decoded-byte limits. */
export class PdfTextBudget {
  private items = 0;
  private characters = 0;
  private words = 0;
  private styles = new Set<string>();
  consume(chunk: PdfTextChunk) {
    if (!Array.isArray(chunk.items)) throw new Error("PDF 文字格式损坏。");
    if (chunk.items.length > PDF_TEXT_LIMITS.items - this.items) throw limitError();
    let characters = 0;
    for (const item of chunk.items) {
      if (typeof item.str !== "string") continue;
      characters += item.str.length;
      if (characters > PDF_TEXT_LIMITS.characters - this.characters) throw limitError();
    }
    const words = countReadingWords(chunk.items.map(item => item.str ?? "").join(" "));
    if (words > PDF_TEXT_LIMITS.words - this.words) throw limitError();
    for (const name of Object.keys(chunk.styles ?? {})) {
      if (name.length > 256 || !this.styles.has(name) && this.styles.size >= PDF_TEXT_LIMITS.styles) throw limitError();
      this.styles.add(name);
    }
    this.items += chunk.items.length;
    this.characters += characters;
    this.words += words;
  }
}

function readWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readBoundedPdfText(page: PdfTextPage, budget: PdfTextBudget, signal: AbortSignal): Promise<PdfTextItem[]> {
  signal.throwIfAborted();
  const reader = page.streamTextContent().getReader();
  const items: PdfTextItem[] = [];
  let completed = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader.read(), signal);
      if (done) { completed = true; return items; }
      signal.throwIfAborted();
      budget.consume(value);
      // Push individually to avoid a large spread argument list on some engines.
      for (const item of value.items) items.push(item);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) cancel();
    reader.releaseLock();
  }
}
