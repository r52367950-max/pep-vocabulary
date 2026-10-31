import { MAX_DOCX_ARCHIVE_BYTES, MAX_DOCX_DOCUMENT_BYTES } from "./docx-archive";

export const DOCX_WORKER_TIMEOUT_MS = 30_000;
/** Never run ZIP parsing on the UI thread, including when Workers are unavailable. */
export async function extractDocxXml(file: File, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!file.size || file.size > MAX_DOCX_ARCHIVE_BYTES) throw new Error("请选择 12 MB 以内的非空文件。");
  if (typeof Worker === "undefined") throw new Error("浏览器暂不支持读取 Word 文档，请粘贴正文后导入。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./docx-worker.ts", import.meta.url), { type: "module" });
    let finished = false;
    const finish = (error?: Error, xml?: Uint8Array) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(xml!);
    };
    const abort = () => finish(new DOMException("已取消", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Word 文档处理超时，请选取需要的部分或粘贴正文后重试。")), DOCX_WORKER_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ xml?: unknown; error?: unknown }>) => {
      if (typeof event.data?.error === "string") finish(new Error(event.data.error));
      else if (event.data?.xml instanceof Uint8Array && event.data.xml.length <= MAX_DOCX_DOCUMENT_BYTES) finish(undefined, event.data.xml);
      else finish(new Error("无法读取这份 Word 文档。"));
    };
    worker.onerror = event => { event.preventDefault(); finish(new Error("Word 文档读取失败，请粘贴正文后重试。")); };
    worker.onmessageerror = () => finish(new Error("Word 文档读取失败，请粘贴正文后重试。"));
    if (signal.aborted) abort();
    else {
      try { worker.postMessage(bytes, [bytes.buffer]); }
      catch { finish(new Error("Word 文档读取失败，请粘贴正文后重试。")); }
    }
  });
}
