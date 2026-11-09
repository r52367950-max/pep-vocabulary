import { imageDimensions } from "./image-input";
import { countReadingWords } from "./reading-library";
import { extractDocxXml } from "./docx-import";
import { MAX_DOCX_DOCUMENT_BYTES } from "./docx-archive";
import { PDF_DECODE_LIMITS, PdfTextBudget, readBoundedPdfText, type PdfTextItem, type PdfTextPage } from "./pdf-import";

export type ImportProgress = (message: string) => void;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_HTML_MARKUP = 4096;
const excludedHtml = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg", "canvas", "nav", "footer", "header", "form", "button", "input", "select", "textarea", "template"]);
const blockHtml = new Set(["p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "br"]);
const htmlLimit = () => new Error("HTML 内容过多，请只保留文章正文，或粘贴文字后导入。");
export const MAX_IMPORT_WORDS = 6000;
export function normalizeReadingText(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/([A-Za-z])-\n(?=[a-z])/g, "$1").split(/\n\s*\n/).map(p => p.replace(/\n/g, " ").replace(/[\t ]+/g, " ").trim()).filter(Boolean).join("\n\n");
}
export function validateImportedText(input: string) {
  let text = normalizeReadingText(input);
  const count = countReadingWords(text);
  if (count < 40) throw new Error("至少需要 40 个英文词。扫描后请检查识别结果。");
  if (count > MAX_IMPORT_WORDS || text.length > 60_000) throw new Error("单篇最多 6,000 词。请选取语意完整的一部分后导入。");
  const paragraphs = text.split("\n\n").flatMap(paragraph => {
    const result: string[] = [];
    while (paragraph.length > 16_000) {
      const matches = [...paragraph.slice(0, 12_000).matchAll(/[.!?][”’"']?\s+(?=[A-Z“"'])/g)];
      const last = matches.at(-1);
      if (!last) throw new Error("有一段文字过长，请在句子之间加入空行后重试。");
      const split = last.index! + last[0].length;
      result.push(paragraph.slice(0, split).trim()); paragraph = paragraph.slice(split).trim();
    }
    return [...result, paragraph];
  });
  if (paragraphs.length > 300) throw new Error("段落超过 300 段，请合并多余空行或分篇导入。");
  text = paragraphs.join("\n\n");
  return text;
}
export function markdownText(input: string) {
  return input.replace(/```[\s\S]*?```/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "").replace(/[*_`]/g, "");
}
export function htmlText(input: string) {
  if (input.length > MAX_HTML_BYTES) throw htmlLimit();
  // Count conservatively before DOM allocation, including comments and malformed markup.
  let markup = 0;
  for (let i = input.indexOf("<"); i !== -1; i = input.indexOf("<", i + 1)) {
    if (++markup > MAX_HTML_MARKUP) throw htmlLimit();
  }
  // Template contents are inert: never attach the fragment, execute scripts, or render its HTML.
  const template = document.createElement("template");
  template.innerHTML = input;
  const pending = [{ node: template.content as Node, end: false }], text: string[] = [];
  let nodes = 0, characters = 0;
  const append = (value: string) => {
    characters += value.length;
    if (characters > 120_000) throw htmlLimit();
    text.push(value);
  };
  while (pending.length) {
    const { node, end } = pending.pop()!;
    if (end) { append("\n\n"); continue; }
    if (++nodes > 20_000) throw htmlLimit();
    if (node.nodeType === Node.TEXT_NODE) { append(node.nodeValue ?? ""); continue; }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.nodeName.toLowerCase();
      if (excludedHtml.has(tag)) continue;
      if (blockHtml.has(tag)) pending.push({ node, end: true });
    }
    for (let child = node.lastChild; child; child = child.previousSibling) pending.push({ node: child, end: false });
  }
  return text.join("");
}
const docxLimit = () => new Error("Word 文档内容过多，请选取需要的部分或粘贴正文后导入。");
/** Visit each XML node once; text belongs only to its nearest paragraph, including text boxes. */
export function docxText(input: string): string {
  if (input.length > MAX_DOCX_DOCUMENT_BYTES) throw docxLimit();
  let markup = 0;
  for (let i = input.indexOf("<"); i !== -1; i = input.indexOf("<", i + 1)) {
    if (++markup > 80_000) throw docxLimit();
  }
  // WordprocessingML has no DTD. Reject entity declarations before DOM allocation.
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error("Word 文档格式损坏。");
  const doc = new DOMParser().parseFromString(input, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Word 文档格式损坏。");
  const paragraphs: string[][] = [];
  const pending: { node: Node; depth: number; paragraph: number; text: boolean }[] = [{ node: doc, depth: 0, paragraph: -1, text: false }];
  let nodes = 0, characters = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 80_000 || current.depth > 128) throw docxLimit();
    let { paragraph, text } = current;
    const { node } = current;
    if (node.nodeType === 1) {
      const name = (node as Element).localName;
      if (name === "p") {
        if (paragraphs.length >= 2000) throw docxLimit();
        paragraph = paragraphs.push([]) - 1;
      }
      if (name === "t") text = true;
    }
    if ((node.nodeType === 3 || node.nodeType === 4) && text && paragraph >= 0) {
      const value = node.nodeValue ?? "";
      characters += value.length;
      if (characters > 120_000) throw docxLimit();
      paragraphs[paragraph].push(value);
    }
    for (let child = node.lastChild; child; child = child.previousSibling) {
      pending.push({ node: child, depth: current.depth + 1, paragraph, text });
    }
  }
  return paragraphs.map(parts => parts.join("")).filter(Boolean).join("\n\n");
}
export { parseClassification } from "./reading-classification";
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export { imageDimensions } from "./image-input";
type OcrWorker = { recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string } }>; terminate: () => Promise<void> };
type PdfPage = PdfTextPage & { getViewport: (a: { scale: number }) => { width: number; height: number }; render: (a: unknown) => { promise: Promise<void>; cancel: () => void }; cleanup: () => void };
type PdfTask = { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage>; checkResourceBudget: () => Promise<void> }>; destroy: () => Promise<void> };
let ocrInitialization: Promise<unknown> = Promise.resolve();

/** Retain paragraph gaps and first-line indents in ordinary single-column PDFs. */
export function pdfReadingText(items: PdfTextItem[]): string {
  const lines: { text: string; x: number; y: number; end: number; size: number }[] = [];
  let breakLine = true;
  for (const item of items) {
    if (typeof item.str !== "string" || !item.str.trim()) { if (item.hasEOL) breakLine = true; continue; }
    const x = item.transform?.[4] ?? 0, y = item.transform?.[5] ?? 0;
    const size = Math.max(1, item.height || Math.abs(item.transform?.[3] ?? 12));
    const previous = lines.at(-1);
    if (breakLine || !previous || Math.abs(y - previous.y) > size * 0.4) lines.push({ text: item.str, x, y, end: x + (item.width ?? 0), size });
    else { previous.text += `${previous.text.endsWith(" ") || item.str.startsWith(" ") ? "" : " "}${item.str}`; previous.end = Math.max(previous.end, x + (item.width ?? 0)); }
    breakLine = !!item.hasEOL;
  }
  const gaps = lines.slice(1).map((line, i) => Math.abs(line.y - lines[i].y)).filter(gap => gap > 1).sort((a, b) => a - b);
  const leading = gaps[Math.floor((gaps.length - 1) / 2)] || 14;
  const right = Math.max(...lines.map(line => line.end));
  return lines.map((line, i) => {
    if (!i) return line.text;
    const prev = lines[i - 1];
    const gap = Math.abs(prev.y - line.y);
    const ended = /[.!?:;][”’"']?\s*$/.test(prev.text);
    const paragraph = gap > leading * 1.45 || ended && (line.x > prev.x + line.size * 0.8 || prev.end < right - line.size * 1.8);
    return `${paragraph ? "\n\n" : "\n"}${line.text}`;
  }).join("");
}

export async function extractReadingFile(file: File, signal: AbortSignal, progress: ImportProgress): Promise<string> {
  if (!file.size || file.size > MAX_BYTES) throw new Error("请选择 12 MB 以内的非空文件。");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm"].includes(extension) && file.size > MAX_HTML_BYTES) throw htmlLimit();
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
  if (["txt", "md", "markdown", "html", "htm"].includes(extension)) {
    progress("正在提取文字…");
    const bytes = await file.arrayBuffer();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder("gb18030").decode(bytes); }
    if (["html", "htm"].includes(extension)) text = htmlText(text);
    if (["md", "markdown"].includes(extension)) text = markdownText(text);
    return normalizeReadingText(text);
  }
  if (extension === "docx") {
    progress("正在读取 Word 文档…");
    const bytes = await extractDocxXml(file, signal);
    signal.throwIfAborted();
    return normalizeReadingText(docxText(new TextDecoder().decode(bytes)));
  }
  let worker: OcrWorker | undefined;
  let task: PdfTask | undefined;
  let cancelRender: (() => void) | undefined;
  let parserWorker: Worker | undefined;
  let pdfWorker: { destroy: () => void } | undefined;
  let taskDisposal: Promise<void> | undefined;
  const destroyTask = () => taskDisposal ??= task?.destroy().catch(() => {}) ?? Promise.resolve();
  const release = () => {
    cancelRender?.();
    void worker?.terminate();
    void destroyTask();
    // A synchronous decoder cannot handle PDF.js's cooperative Terminate message.
    // Stop the actual worker immediately and reject outstanding reads via signal.
    parserWorker?.terminate();
    pdfWorker?.destroy();
  };
  signal.addEventListener("abort", release, { once: true });
  const recognize = async (canvas: HTMLCanvasElement) => {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (!worker) {
      progress("正在准备英文识别，首次使用约需下载 6 MB…");
      const path = `${location.origin}/vendor/ocr-7/tesseract.esm.min.js`;
      const { default: Tesseract } = await import(/* @vite-ignore */ path);
      const base = `${location.origin}/vendor/ocr-7`;
      await abortable(ocrInitialization, signal);
      signal.throwIfAborted();
      const creating: Promise<OcrWorker> = Tesseract.createWorker("eng", 1, { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base, workerBlobURL: false, gzip: true, logger: (m: { status: string; progress: number }) => { if (!signal.aborted && m.status === "recognizing text") progress(`正在识别英文… ${Math.round(m.progress * 100)}%`); } });
      // Initialization cannot be interrupted by Tesseract's public API. Keep it
      // serialized across dialog instances and release it before accepting more.
      ocrInitialization = creating.then(async w => { if (signal.aborted) await w.terminate(); }, () => {});
      worker = await creating;
      if (signal.aborted) { await worker.terminate(); throw new DOMException("已取消", "AbortError"); }
    }
    return (await abortable(worker.recognize(canvas), signal)).data.text;
  };
  try {
    if (["png", "jpg", "jpeg", "webp", "bmp"].includes(extension) || ["image/png", "image/jpeg", "image/webp", "image/bmp"].includes(file.type)) {
      progress("正在读取扫描图片…");
      const dimensions = imageDimensions(new Uint8Array(await file.arrayBuffer()));
      if (!dimensions || dimensions.some(n => n <= 0)) throw new Error("图片格式无法读取，请另存为 JPG 或 PNG 后重试。");
      if (dimensions[0] * dimensions[1] > 40_000_000 || Math.max(...dimensions) > 30_000) throw new Error("图片尺寸过大，请先裁剪到正文区域。");
      signal.throwIfAborted();
      const url = URL.createObjectURL(file);
      const canvas = document.createElement("canvas");
      try {
        const image = new Image(); image.src = url; await image.decode();
        if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("图片尺寸过大，请先裁剪到正文区域。");
        const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d"); if (!context) throw new Error("设备无法处理图片。");
        context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return normalizeReadingText(await recognize(canvas));
      } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
    }
    if (extension === "pdf") {
      progress("正在读取 PDF…");
      const path = `${location.origin}/vendor/pdfjs-5.6.205/pdf.mjs`;
      const pdfjs = await import(/* @vite-ignore */ path);
      const base = `${location.origin}/vendor/pdfjs-5.6.205`;
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.mjs`;
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      parserWorker = new Worker(`${base}/pdf.worker.mjs`, { type: "module" });
      pdfWorker = new pdfjs.PDFWorker({ port: parserWorker });
      const workerFailure = new Promise<never>((_, reject) => parserWorker!.addEventListener("error", () => reject(new Error("PDF 处理进程无法运行，请重试或粘贴正文。")), { once: true }));
      // Startup can fail before the first pending parser request has been attached.
      void workerFailure.catch(() => {});
      const waitForPdf = <T>(operation: Promise<T>) => abortable(Promise.race([operation, workerFailure]), signal);
      task = pdfjs.getDocument({ data: bytes, worker: pdfWorker, ...PDF_DECODE_LIMITS, cMapUrl: `${base}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}/standard_fonts/`, wasmUrl: `${base}/wasm/`, iccUrl: `${base}/iccs/`, isEvalSupported: false, enableXfa: false, maxImageSize: 40_000_000, canvasMaxAreaInBytes: 32_000_000, stopAtErrors: true }) as PdfTask;
      const pdf = await waitForPdf(task.promise);
      if (pdf.numPages > 30) throw new Error("一次最多导入 30 页 PDF，请先选取需要的页面。");
      const paragraphs: string[] = [];
      const textBudget = new PdfTextBudget();
      for (let n = 1; n <= pdf.numPages; n++) {
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        progress(`正在读取第 ${n} / ${pdf.numPages} 页…`);
        const page = await waitForPdf(pdf.getPage(n));
        const canvas = document.createElement("canvas");
        try {
          const items = await waitForPdf(readBoundedPdfText(page, textBudget, signal));
          let text = pdfReadingText(items);
          if (countReadingWords(text) < 12) {
            const original = page.getViewport({ scale: 1 });
            if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0)) throw new Error("PDF 页面尺寸无法读取。");
            const viewport = page.getViewport({ scale: Math.min(2.5, 2200 / Math.max(original.width, original.height)) });
            canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            const render = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
            cancelRender = () => render.cancel(); await waitForPdf(render.promise); cancelRender = undefined;
            // PDF.js can resolve rendering after a failed image became null.
            // Await all decoder tasks and verify the worker latch before OCR.
            await waitForPdf(pdf.checkResourceBudget());
            text = await recognize(canvas);
          }
          if (text.length > 120_000) throw new Error("PDF 识别文字过多，请减少页数后重试。");
          const normalized = normalizeReadingText(text);
          const previous = paragraphs.at(-1);
          if (previous && /[a-z,-]$/.test(previous) && /^[a-z]/.test(normalized)) paragraphs[paragraphs.length - 1] += ` ${normalized}`;
          else paragraphs.push(normalized);
          if (paragraphs.reduce((total, paragraph) => total + paragraph.length, 0) > 60_000) throw new Error("文字超过单篇上限，请先选取需要的文章。");
          if (countReadingWords(paragraphs.join(" ")) > MAX_IMPORT_WORDS) throw new Error("这份文档超过 6,000 词，请先选取完整的一篇文章。");
        } finally { page.cleanup(); canvas.width = 0; canvas.height = 0; }
      }
      await waitForPdf(pdf.checkResourceBudget());
      return paragraphs.filter(Boolean).join("\n\n");
    }
    throw new Error("支持 TXT、Markdown、HTML、DOCX、PDF，以及 JPG、PNG、WebP 扫描图。旧版 DOC 请另存为 DOCX。");
  } catch (error) {
    if (error instanceof Error && error.message.includes("PDF resource limit")) throw new Error("这份 PDF 的解码内容过多，请减少页数或选取正文后重试。");
    throw error;
  } finally {
    signal.removeEventListener("abort", release);
    try {
      await worker?.terminate();
      if (task && !signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([destroyTask(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
        finally { clearTimeout(timer); }
      }
    } finally { parserWorker?.terminate(); pdfWorker?.destroy(); }
  }
}
