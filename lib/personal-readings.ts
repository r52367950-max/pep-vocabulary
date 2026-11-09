import { createLocalId, DataReplacedError } from "./storage";
import { validLibraryArticle, validReadingMeta, type LibraryArticle, type ReadingMeta } from "./reading-library";

type PersonalMeta = ReadingMeta & { contentHash: string };
const REPLACEMENT_KEY = "vocab-personal-readings-generation";
const replacementListeners = new Set<() => void>();
let replacementEpoch = 0, observedGeneration = "initial";
let replacementChannel: BroadcastChannel | undefined;
let observing = false;
function observeReplacement(generation: unknown) {
  if (typeof generation !== "string" || generation === observedGeneration) return;
  observedGeneration = generation;
  replacementEpoch++;
  for (const listener of replacementListeners) listener();
}
function observePersonalReadings() {
  if (observing || typeof window === "undefined") return;
  observing = true;
  // Keep the observer alive while Activity hides the reader and disconnects its effects.
  if (typeof BroadcastChannel !== "undefined") {
    try {
      replacementChannel = new BroadcastChannel(REPLACEMENT_KEY);
      replacementChannel.onmessage = event => observeReplacement(event.data);
    } catch { /* Storage events and foreground checks remain available. */ }
  }
  window.addEventListener("storage", event => {
    if (event.key === REPLACEMENT_KEY) observeReplacement(event.newValue);
  });
  const refresh = () => { void personalReadingsGeneration().then(observeReplacement).catch(() => undefined); };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
}
export function subscribePersonalReadingsReplacement(listener: () => void) {
  observePersonalReadings();
  replacementListeners.add(listener);
  return () => { replacementListeners.delete(listener); };
}
export const personalReadingsReplacementEpoch = () => replacementEpoch;
function announceReplacement(generation: string) {
  observePersonalReadings();
  observeReplacement(generation);
  try { replacementChannel?.postMessage(generation); } catch { /* Foreground checks re-read the durable generation. */ }
  try { localStorage.setItem(REPLACEMENT_KEY, generation); } catch { /* Cross-page broadcast remains available without localStorage. */ }
}
const normalizedBody = (article: LibraryArticle) => article.paragraphs.map(p => p.en.toLowerCase().replace(/\s+/g, " ").trim()).join(" ");
function fingerprint(body: string) {
  // This is only an index hint, not a security digest. A candidate's entire
  // normalized body is always compared, so hash collisions cannot drop content.
  let hash = 2166136261;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619);
  return `body-v1-${body.length}-${(hash >>> 0).toString(16)}`;
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pep-vocab-personal-readings", 2);
    request.onupgradeneeded = () => {
      for (const name of ["index", "articles", "meta"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: name === "meta" ? "key" : "id" });
    };
    request.onerror = () => reject(new Error("无法打开本机文章库。请检查浏览器存储权限。"));
    request.onblocked = () => reject(new Error("请关闭其他词迹窗口后重试。"));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
  });
}
export async function personalReadingsGeneration(): Promise<string> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const request = tx.objectStore("meta").get("generation");
    tx.oncomplete = () => { db.close(); resolve(request.result?.value ?? "initial"); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error("无法读取个人文章状态。")); };
  });
}
export async function listPersonalReadings(): Promise<ReadingMeta[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("index", "readonly"); const request = tx.objectStore("index").getAll();
    tx.oncomplete = () => { db.close(); const rows: unknown = request.result; if (!Array.isArray(rows) || !rows.every(validReadingMeta)) reject(new Error("本机文章目录无法读取，请先保留浏览器数据。")); else resolve(rows.reverse()); };
    tx.onerror = () => { db.close(); reject(new Error("本机文章目录读取失败。")); };
  });
}
export async function readPersonalArticle(id: string): Promise<LibraryArticle> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("articles", "readonly"); const request = tx.objectStore("articles").get(id);
    tx.oncomplete = () => { db.close(); if (validLibraryArticle(request.result, id) && request.result.form === "imported") resolve(request.result); else reject(new Error("没有找到这篇个人文章。")); };
    tx.onerror = () => { db.close(); reject(new Error("本机文章读取失败。")); };
  });
}
export async function savePersonalArticle(article: LibraryArticle, signal?: AbortSignal, expectedGeneration?: string): Promise<string> {
  signal?.throwIfAborted();
  if (article.form !== "imported" || !article.id.startsWith("personal-") || !validLibraryArticle(article, article.id)) throw new Error("文章格式校验未通过。");
  const generation = expectedGeneration ?? await personalReadingsGeneration();
  const body = normalizedBody(article);
  const hash = fingerprint(body);
  const db = await open();
  if (signal?.aborted) { db.close(); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["index", "articles", "meta"], "readwrite"); let replaced = false; let id = article.id; let reason = "文章未能保存，请检查剩余存储空间。";
    const abort = () => { try { tx.abort(); } catch { /* A committed transaction is reported as saved. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    const close = () => { signal?.removeEventListener("abort", abort); db.close(); };
    const fence = tx.objectStore("meta").get("generation");
    fence.onsuccess = () => {
      if ((fence.result?.value ?? "initial") !== generation) { replaced = true; tx.abort(); return; }
      const request = tx.objectStore("index").getAll();
      request.onsuccess = () => {
        const rows = request.result as PersonalMeta[];
        const candidates = rows.filter(a => a.contentHash === hash);
        const write = () => {
          if (rows.length >= 100) { reason = "本机最多保存 100 篇个人文章，请先导出并移除不需要的内容。"; tx.abort(); return; }
          const { paragraphs: _paragraphs, questions: _questions, targets: _targets, ...meta } = article;
          void _paragraphs; void _questions; void _targets;
          tx.objectStore("index").put({ ...meta, contentHash: hash }); tx.objectStore("articles").put(article);
        };
        const compare = () => {
          const candidate = candidates.pop();
          if (!candidate) { write(); return; }
          const stored = tx.objectStore("articles").get(candidate.id);
          stored.onsuccess = () => {
            if (validLibraryArticle(stored.result, candidate.id) && normalizedBody(stored.result) === body) id = candidate.id;
            else compare();
          };
        };
        compare();
      };
    };
    tx.oncomplete = () => { close(); resolve(id); };
    tx.onabort = tx.onerror = () => { close(); reject(replaced ? new DataReplacedError() : signal?.aborted ? new DOMException("已取消", "AbortError") : new Error(reason)); };
  });
}
export async function removePersonalArticle(id: string) {
  const db = await open();
  return new Promise<void>((resolve, reject) => { const tx = db.transaction(["index", "articles"], "readwrite"); tx.objectStore("index").delete(id); tx.objectStore("articles").delete(id); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(new Error("移除失败，请重试。")); }; });
}
export async function clearPersonalReadings() {
  const db = await open();
  const generation = createLocalId();
  return new Promise<void>((resolve, reject) => { const tx = db.transaction(["index", "articles", "meta"], "readwrite"); tx.objectStore("meta").put({ key: "generation", value: generation }); tx.objectStore("index").clear(); tx.objectStore("articles").clear(); tx.oncomplete = () => { db.close(); announceReplacement(generation); resolve(); }; tx.onerror = () => { db.close(); reject(new Error("个人文章清空失败。")); }; });
}
export function exportPersonalArticle(article: LibraryArticle) {
  const content = `# ${article.title}\n\n${article.author}\n\n${article.paragraphs.map(p => p.en).join("\n\n")}\n`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${article.title.replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 60) || "reading"}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
