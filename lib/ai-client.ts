import type { AssistantTask } from "./assistant/prompt";
import type { LearnerProfile } from "./assistant/profile";
import { stableJson } from "./stable-json";

/**
 * Browser side of the assistant. Results are cached in their own IndexedDB database, never in
 * the learning database or its backups, so repeat views cost nothing and the cache can be
 * cleared on its own. No API key or provider detail is stored here.
 */
const DB_NAME = "pep-vocab-ai-cache";
const STORE = "results";
const MAX_ENTRIES = 600;
const CLIENT_TIMEOUT_MS = 310_000;

export type AssistantUsage = { prompt: number; completion: number; cacheHit: number; total: number; estimated: boolean; today: number | null; budget: number };
export type AssistantResult<T = Record<string, unknown>> = {
  result: T;
  model: string;
  cachedAt: string | null;
  usage: AssistantUsage | null;
};
type CachedRow = { key: string; task: AssistantTask; createdAt: string; model: string; result: Record<string, unknown> };

export class AssistantError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) {
    super(message);
    this.name = "AssistantError";
  }
}

function openCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("createdAt", "createdAt");
    };
    request.onblocked = () => reject(new Error("请关闭其他词迹页面后重试缓存操作。"));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error || new Error("AI cache unavailable"));
  });
}

async function cacheRequest<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openCache();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T | undefined;
    try {
      const request = work(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { value = request.result; };
    } catch (error) { tx.abort(); db.close(); reject(error); }
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("AI cache failed")); };
  });
}

/** The cache key covers the task and its input, not the profile: a saved answer stays valid all day and beyond. */
export const cacheKey = (task: AssistantTask, input: Record<string, unknown>) => `${task}:${stableJson(input)}`;

export async function readCached<T = Record<string, unknown>>(task: AssistantTask, input: Record<string, unknown>): Promise<AssistantResult<T> | null> {
  if (task === "diagnose") return null; // The same empty input describes changing learning history.
  try {
    const row = await cacheRequest<CachedRow>("readonly", (store) => store.get(cacheKey(task, input)));
    return row ? { result: row.result as T, model: row.model, cachedAt: row.createdAt, usage: null } : null;
  } catch {
    return null;
  }
}

async function writeCached(row: CachedRow) {
  try {
    await cacheRequest("readwrite", (store) => {
      store.put(row);
      store.count().onsuccess = function () {
        let excess = this.result - MAX_ENTRIES;
        if (excess <= 0) return;
        store.index("createdAt").openCursor().onsuccess = function () {
          const cursor = this.result;
          if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
        };
      };
    });
  } catch {
    /* A full or blocked cache only costs a repeat request later. */
  }
}

export async function clearAssistantCache() {
  await cacheRequest("readwrite", (store) => { store.clear(); });
}

export async function assistantCacheSize() {
  try { return (await cacheRequest<number>("readonly", (store) => store.count())) || 0; }
  catch { return 0; }
}

// Latest known usage, for the small "today" counters in the interface.
let latestUsage: AssistantUsage | null = null;
const listeners = new Set<() => void>();
export const usageStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  get: () => latestUsage,
  set(usage: AssistantUsage | null) { latestUsage = usage; listeners.forEach((listener) => listener()); },
};

/**
 * Runs one assistant task. A cached answer is returned unless `refresh` is set; a fresh answer is
 * cached. The profile is sent as data for personalised feedback and is not part of the cache key.
 */
export async function runAssistant<T = Record<string, unknown>>(task: AssistantTask, input: Record<string, unknown>, options: {
  profile?: LearnerProfile | null; refresh?: boolean; signal?: AbortSignal; cache?: boolean;
} = {}): Promise<AssistantResult<T>> {
  const checkAborted = () => {
    if (options.signal?.aborted) throw new AssistantError("已取消。", "aborted", true);
  };
  checkAborted();
  const useCache = options.cache !== false && task !== "diagnose";
  if (useCache && !options.refresh) {
    const cached = await readCached<T>(task, input);
    checkAborted();
    if (cached) return cached;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, CLIENT_TIMEOUT_MS);
  let payload: { ok?: boolean; result?: T; model?: string; usage?: AssistantUsage; error?: { code?: string; message?: string; retryable?: boolean } };
  try {
    const response = await fetch(`/api/assistant/${task}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vocab-action": "assistant" },
      body: JSON.stringify({ ...input, ...(options.profile ? { profile: options.profile } : {}) }),
      signal: controller.signal,
    });
    payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.result) {
      throw new AssistantError(payload.error?.message || "AI 暂时不可用；本地学习不受影响。", payload.error?.code || `http_${response.status}`, Boolean(payload.error?.retryable));
    }
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (controller.signal.aborted) throw new AssistantError(options.signal?.aborted ? "已取消。" : "AI 请求超时，可以稍后重试。", "aborted", true);
    throw new AssistantError("无法连接 AI 服务，请检查网络；本地学习不受影响。", "network", true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
  const model = payload.model || "";
  if (payload.usage) usageStore.set(payload.usage);
  const result = payload.result as T;
  if (useCache) await writeCached({ key: cacheKey(task, input), task, createdAt: new Date().toISOString(), model, result: result as Record<string, unknown> });
  return { result, model, cachedAt: null, usage: payload.usage || null };
}

/**
 * The profile changes after every answer, but a byte-identical profile keeps the provider's
 * prompt cache warm. So it is rebuilt only when the day changes or 30 more reviews exist.
 */
let snapshot: { key: string; profile: LearnerProfile } | null = null;
export function profileSnapshot(reviewCount: number, extraKey: string, build: () => LearnerProfile): LearnerProfile {
  const key = `${new Date().toLocaleDateString("sv-SE")}:${Math.floor(reviewCount / 30)}:${extraKey}`;
  if (snapshot?.key !== key) snapshot = { key, profile: build() };
  return snapshot.profile;
}
