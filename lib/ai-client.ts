import type { AssistantTask } from "./assistant/prompt";
import type { LearnerProfile } from "./assistant/profile";
import { stableJson } from "./stable-json";
import { contextStillCurrent, localProfileAllowed, learningContextStore, refreshLearningContext, type LearningMemory } from "./learning-context-client";
import { localPracticeGeneration, practiceGenerationCurrent } from "./local-practice-generation";

/**
 * Browser side of the assistant. Results are cached in their own IndexedDB database, never in
 * the learning database or its backups, so repeat views cost nothing and the cache can be
 * cleared on its own. No API key or provider detail is stored here.
 */
const DB_NAME = "pep-vocab-ai-cache";
const STORE = "results";
const META = "metadata";
const GENERATION_KEY = "generation";
const INITIAL_GENERATION = "initial";
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
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!request.result.objectStoreNames.contains(META)) request.result.createObjectStore(META, { keyPath: "key" });
    };
    request.onblocked = () => reject(new Error("请关闭其他词迹页面后重试缓存操作。"));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error || new Error("AI cache unavailable"));
  });
}

async function cacheRequest<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, metadata: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openCache();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction([STORE, META], mode);
    let value: T | undefined;
    try {
      const request = work(tx.objectStore(STORE), tx.objectStore(META));
      if (request) request.onsuccess = () => { value = request.result; };
    } catch (error) { tx.abort(); db.close(); reject(error); }
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("AI cache failed")); };
  });
}

async function cacheGeneration(): Promise<string | null> {
  try {
    const row = await cacheRequest<{ key: string; value: string }>("readonly", (_store, metadata) => metadata.get(GENERATION_KEY));
    return row?.value ?? INITIAL_GENERATION;
  } catch { return null; } // Cache availability must never prevent an uncached request.
}

/** Legacy helper remains deterministic; persistent keys additionally include a verified context. */
export const cacheKey = (task: AssistantTask, input: Record<string, unknown>) => `${task}:${stableJson(input)}`;
async function scopedKey(task: AssistantTask, input: Record<string, unknown>, memory: LearningMemory, profile: LearnerProfile | null) {
  const bytes = new TextEncoder().encode(stableJson({ input, profile }));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `context-v2:${memory.accountScope}:${memory.revision}:${memory.enabled}:${memory.contextVersion || "learning-memory-v1"}:${task}:${digest}`;
}
async function cachedByKey<T>(key: string): Promise<AssistantResult<T> | null> {
  try {
    const row = await cacheRequest<CachedRow>("readonly", (store) => store.get(key));
    return row ? { result: row.result as T, model: row.model, cachedAt: row.createdAt, usage: null } : null;
  } catch { return null; }
}
export async function readCached<T = Record<string, unknown>>(task: AssistantTask, input: Record<string, unknown>, options: { profile?: LearnerProfile | null; signal?: AbortSignal } = {}): Promise<AssistantResult<T> | null> {
  if (task === "diagnose" || learningContextStore.get().temporary || options.signal?.aborted) return null;
  const generation = localPracticeGeneration();
  try {
    const memory = await refreshLearningContext(options.signal);
    const epoch = learningContextStore.get().epoch;
    const cached = await cachedByKey<T>(await scopedKey(task, input, memory, localProfileAllowed(memory) ? options.profile || null : null));
    return !options.signal?.aborted && practiceGenerationCurrent(generation) && epoch === learningContextStore.get().epoch && contextStillCurrent(memory, false) ? cached : null;
  } catch { return null; } // An unknown account/policy never falls back to old personalised data.
}

async function writeCached(row: CachedRow, generation: string | null, allowed: () => boolean) {
  if (generation === null) return;
  try {
    await cacheRequest("readwrite", (store, metadata) => {
      // The fence and the answer share one transaction. A clear from another tab
      // either erases this write afterwards or makes its captured generation stale.
      metadata.get(GENERATION_KEY).onsuccess = function () {
        if ((this.result?.value ?? INITIAL_GENERATION) !== generation || !allowed()) return;
        store.put(row);
        store.count().onsuccess = function () {
          let excess = this.result - MAX_ENTRIES;
          if (excess <= 0) return;
          store.index("createdAt").openCursor().onsuccess = function () {
            const cursor = this.result;
            if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
          };
        };
      };
    });
  } catch {
    /* A full or blocked cache only costs a repeat request later. */
  }
}

export async function clearAssistantCache() {
  await cacheRequest("readwrite", (store, metadata) => {
    metadata.put({ key: GENERATION_KEY, value: crypto.randomUUID() });
    store.clear();
  });
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

/** Validate account and privacy policy before every cache read and before displaying a response. */
export async function runAssistant<T = Record<string, unknown>>(task: AssistantTask, input: Record<string, unknown>, options: {
  profile?: LearnerProfile | null; refresh?: boolean; signal?: AbortSignal; cache?: boolean;
} = {}): Promise<AssistantResult<T>> {
  if (options.signal?.aborted) throw new AssistantError("已取消。", "aborted", true);
  // Capture both fences before awaiting account metadata or a model response.
  // Cache-only clearing has its own epoch and does not stop unrelated practice.
  const generation = localPracticeGeneration();
  const cacheEpoch = await cacheGeneration();
  if (options.signal?.aborted || !practiceGenerationCurrent(generation)) throw new AssistantError("本机数据已清空或请求已取消，请重新开始。", "aborted", true);
  let memory: LearningMemory;
  try { memory = await refreshLearningContext(options.signal); }
  catch (error) { throw new AssistantError(options.signal?.aborted ? "已取消。" : error instanceof Error ? error.message : "无法读取学习记忆。", options.signal?.aborted ? "aborted" : "context_unavailable", true); }
  const temporary = learningContextStore.get().temporary;
  const policyEpoch = learningContextStore.get().epoch;
  const profile = !temporary && localProfileAllowed(memory) ? options.profile || null : null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const unsubscribe = learningContextStore.subscribe(() => { if (!contextStillCurrent(memory, temporary) || learningContextStore.get().epoch !== policyEpoch) abort(); });
  const timer = setTimeout(abort, CLIENT_TIMEOUT_MS);
  const checkCurrent = () => {
    if (controller.signal.aborted || !practiceGenerationCurrent(generation) || !contextStillCurrent(memory, temporary)) throw new AssistantError("请求已取消或学习记忆已更新，请重新开始。", "aborted", true);
  };
  const useCache = !temporary && options.cache !== false && task !== "diagnose";
  try {
    const key = await scopedKey(task, input, memory, profile);
    checkCurrent();
    if (useCache && !options.refresh) {
      const cached = await cachedByKey<T>(key);
      checkCurrent();
      if (cached) return cached;
    }
    const response = await fetch(`/api/assistant/${task}`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-vocab-action": "assistant" },
      body: JSON.stringify({ ...input, temporary, accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion, ...(profile ? { profile } : {}) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; model?: string; contextRevision?: number; accountScope?: string; usage?: AssistantUsage; error?: { code?: string; message?: string; retryable?: boolean } };
    checkCurrent();
    if (!response.ok || !payload.ok || !payload.result) throw new AssistantError(payload.error?.message || "AI 暂时不可用；本地学习不受影响。", payload.error?.code || `http_${response.status}`, Boolean(payload.error?.retryable));
    if ((payload.accountScope && payload.accountScope !== memory.accountScope) || (payload.contextRevision !== undefined && payload.contextRevision !== memory.revision)) throw new AssistantError("账户或学习记忆已更新，请重新开始。", "context_changed", true);
    // Covers changes on another device while the model request was running.
    await refreshLearningContext(controller.signal);
    checkCurrent();
    const model = payload.model || "";
    if (payload.usage) usageStore.set(payload.usage);
    if (useCache) await writeCached({ key, task, createdAt: new Date().toISOString(), model, result: payload.result as Record<string, unknown> }, cacheEpoch,
      () => !controller.signal.aborted && practiceGenerationCurrent(generation) && contextStillCurrent(memory, temporary) && learningContextStore.get().epoch === policyEpoch);
    checkCurrent();
    return { result: payload.result, model, cachedAt: null, usage: payload.usage || null };
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (controller.signal.aborted) throw new AssistantError("请求已取消或学习记忆已更新，请重试。", "aborted", true);
    throw new AssistantError("无法确认当前学习上下文或连接AI服务，请重试。", "network", true);
  } finally { clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener("abort", abort); }
}

/** Rebuild from actual current notes/writing; counts cannot detect edits or deletions. */
export function profileSnapshot(_reviewCount: number, _extraKey: string, build: () => LearnerProfile): LearnerProfile { return build(); }
