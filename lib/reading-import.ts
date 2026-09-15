import { countReadingWords, type Difficulty, type ReadingCategory } from "./reading-library";

export type ImportProgress = (message: string) => void;
const MAX_BYTES = 12 * 1024 * 1024;
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
  // Template contents are inert: never attach the fragment, execute scripts, or render its HTML.
  const template = document.createElement("template");
  template.innerHTML = input;
  template.content.querySelectorAll("script,style,noscript,iframe,object,embed,svg,canvas,nav,footer,header,form,button,input,select,textarea").forEach(node => node.remove());
  template.content.querySelectorAll("p,div,section,article,h1,h2,h3,h4,h5,h6,li,blockquote,br").forEach(node => node.append(document.createTextNode("\n\n")));
  return template.content.textContent ?? "";
}
export function parseClassification(input: string): { category: ReadingCategory; difficulty: Difficulty } {
  const clean = input.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const value: unknown = JSON.parse(clean);
  if (!value || typeof value !== "object") throw new Error("分类结果格式无效。");
  const a = value as { category: ReadingCategory; difficulty: Difficulty };
  if (!["essay", "fiction", "science"].includes(a.category) || !["A2", "B1", "B2", "C1"].includes(a.difficulty)) throw new Error("分类结果超出支持范围。");
  return { category: a.category, difficulty: a.difficulty };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Inspect dimensions before asking the browser to allocate decoded pixels. */
export function imageDimensions(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30) return null;
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return view.getUint32(14, true) === 12 ? [view.getUint16(18, true), view.getUint16(20, true)] : [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))];
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    if (chunk === 0x5650384c && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)]; }
    if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  return null;
}
type OcrWorker = { recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string } }>; terminate: () => Promise<void> };
type PdfTextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
type PdfPage = { getTextContent: () => Promise<{ items: PdfTextItem[] }>; getViewport: (a: { scale: number }) => { width: number; height: number }; render: (a: unknown) => { promise: Promise<void>; cancel: () => void }; cleanup: () => void };
type PdfTask = { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }>; destroy: () => Promise<void> };
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
    const { unzipSync, strFromU8 } = await import("fflate");
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => entry.name === "word/document.xml" && entry.originalSize <= 2_000_000 });
    const bytes = entries["word/document.xml"];
    if (!bytes || bytes.length > 2_000_000) throw new Error("无法读取这份 DOCX，或文档文字过多。");
    const doc = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Word 文档格式损坏。");
    return normalizeReadingText([...doc.getElementsByTagNameNS("*", "p")].map(p => [...p.getElementsByTagNameNS("*", "t")].map(t => t.textContent ?? "").join("")).filter(Boolean).join("\n\n"));
  }
  let worker: OcrWorker | undefined;
  let task: PdfTask | undefined;
  let cancelRender: (() => void) | undefined;
  const release = () => { void worker?.terminate(); void task?.destroy(); cancelRender?.(); };
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
      task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: `${base}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}/standard_fonts/`, wasmUrl: `${base}/wasm/`, iccUrl: `${base}/iccs/`, isEvalSupported: false, enableXfa: false, maxImageSize: 40_000_000, canvasMaxAreaInBytes: 32_000_000, stopAtErrors: true }) as PdfTask;
      const pdf = await task.promise;
      if (pdf.numPages > 30) throw new Error("一次最多导入 30 页 PDF，请先选取需要的页面。");
      const paragraphs: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        progress(`正在读取第 ${n} / ${pdf.numPages} 页…`);
        const page = await pdf.getPage(n);
        const canvas = document.createElement("canvas");
        try {
          const content = await page.getTextContent();
          let text = pdfReadingText(content.items);
          if (countReadingWords(text) < 12) {
            const original = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(2.5, 2200 / Math.max(original.width, original.height)) });
            canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            const render = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
            cancelRender = () => render.cancel(); await render.promise; cancelRender = undefined;
            text = await recognize(canvas);
          }
          const normalized = normalizeReadingText(text);
          const previous = paragraphs.at(-1);
          if (previous && /[a-z,-]$/.test(previous) && /^[a-z]/.test(normalized)) paragraphs[paragraphs.length - 1] += ` ${normalized}`;
          else paragraphs.push(normalized);
          if (countReadingWords(paragraphs.join(" ")) > MAX_IMPORT_WORDS) throw new Error("这份文档超过 6,000 词，请先选取完整的一篇文章。");
        } finally { page.cleanup(); canvas.width = 0; canvas.height = 0; }
      }
      return paragraphs.filter(Boolean).join("\n\n");
    }
    throw new Error("支持 TXT、Markdown、HTML、DOCX、PDF，以及 JPG、PNG、WebP 扫描图。旧版 DOC 请另存为 DOCX。");
  } finally { signal.removeEventListener("abort", release); await worker?.terminate(); await task?.destroy(); }
}
