import { localPracticeGeneration, localPracticeWritesSupported, practiceGenerationCurrent, writeLocalPracticeData, type PracticeGeneration } from "./local-practice-generation";
/** One browser-tab privacy policy. Only an opaque opt-in scope is stored; never notes or chat. */
export type LearningNote = { id: string; text: string; source?: "manual" | "confirmed_suggestion" | "legacy"; kind?: "preference" | "expression" | "learning_note"; confirmedAt?: string; updatedAt?: string };
export type LearningMemory = { accountScope: string; revision: number; enabled: boolean; notes: LearningNote[]; recentTopics: string[]; model?: string; contextVersion?: string };
export type LearningContextState = { memory: LearningMemory | null; temporary: boolean; epoch: number; error: string };
const INITIAL: LearningContextState = { memory: null, temporary: false, epoch: 0, error: "" };
let state = INITIAL;
let requestSequence = 0;
let memoryGeneration: PracticeGeneration = null;
const listeners = new Set<() => void>();
let connected = false;
let channel: BroadcastChannel | undefined;
const PROFILE_OWNER_KEY = "vocab-local-profile-owner-v1";
export function localProfileAllowed(memory: LearningMemory | null) {
  if (!memory || !memory.enabled || state.temporary || typeof localStorage === "undefined" || !practiceGenerationCurrent(memoryGeneration)) return false;
  try { return localStorage.getItem(PROFILE_OWNER_KEY) === memory.accountScope; } catch { return false; }
}
export async function setLocalProfileAllowed(allowed: boolean) {
  if (!state.memory || state.temporary) return;
  const memory = state.memory, generation = memoryGeneration;
  const update = (storage: Storage) => {
    if (state.memory !== memory || state.temporary) throw new Error("学习模式已改变，请重新确认这个选择。");
    if (allowed) storage.setItem(PROFILE_OWNER_KEY, memory.accountScope); else storage.removeItem(PROFILE_OWNER_KEY);
  };
  if (!allowed && !localPracticeWritesSupported()) update(localStorage);
  else await writeLocalPracticeData(generation, update);
  state = { ...state, epoch: state.epoch + 1 }; emit();
  channel?.postMessage({ changed: true });
}
/** Device reset must revoke consent even without a loaded account or in temporary mode. */
export function clearLocalProfileConsent() {
  connect();
  localStorage.removeItem(PROFILE_OWNER_KEY);
  invalidateLearningContext(true);
}
function emit() { listeners.forEach((listener) => listener()); }
function signature(memory: LearningMemory | null) { return memory ? `${memory.accountScope}:${memory.revision}:${memory.enabled}:${memory.model || ""}:${memory.contextVersion || "1"}` : ""; }
function connect() {
  if (connected || typeof window === "undefined") return;
  connected = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("vocab-learning-context-v1");
    channel.onmessage = () => invalidateLearningContext();
  }
  window.addEventListener("vocab-ai-config-changed", () => invalidateLearningContext(true));
  window.addEventListener("pageshow", () => invalidateLearningContext());
}
export const learningContextStore = {
  subscribe(listener: () => void) { connect(); listeners.add(listener); return () => { listeners.delete(listener); }; },
  get: () => state,
  getServerSnapshot: () => INITIAL,
};
export function invalidateLearningContext(broadcast = false) {
  requestSequence++;
  memoryGeneration = null;
  state = { ...state, memory: null, epoch: state.epoch + 1, error: "" }; emit();
  if (broadcast) channel?.postMessage({ changed: true });
}
export function setTemporaryMode(temporary: boolean) {
  connect();
  if (state.temporary === temporary) return;
  requestSequence++;
  memoryGeneration = null;
  state = { memory: null, temporary, epoch: state.epoch + 1, error: "" }; emit();
}
function parseMemory(value: unknown): LearningMemory {
  const m = value as LearningMemory;
  if (!m || typeof m.accountScope !== "string" || !m.accountScope || !Number.isSafeInteger(m.revision) || m.revision < 0 || typeof m.enabled !== "boolean" || !Array.isArray(m.notes) || !Array.isArray(m.recentTopics)) throw new Error("学习记忆状态无效，请重新读取。");
  return m;
}
function adopt(memory: LearningMemory, generation: PracticeGeneration, broadcast = false) {
  if (!practiceGenerationCurrent(generation)) throw new Error("本机学习数据已清空，请重新读取学习记忆。");
  memoryGeneration = generation;
  const changed = signature(state.memory) !== signature(memory);
  state = { ...state, memory, error: "", epoch: state.epoch + (changed ? 1 : 0) }; emit();
  if (broadcast) channel?.postMessage({ changed: true });
}
let pendingRead: { promise: Promise<LearningMemory>; sequence: number; temporary: boolean } | null = null;
/** Concurrent panels share one read; each consumer still honours its own cancellation. */
export async function refreshLearningContext(signal?: AbortSignal): Promise<LearningMemory> {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  if (!pendingRead || pendingRead.sequence !== requestSequence || pendingRead.temporary !== state.temporary) {
    const promise = fetchLearningContext();
    const pending = { promise, sequence: requestSequence, temporary: state.temporary };
    pendingRead = pending;
    void promise.finally(() => { if (pendingRead === pending) pendingRead = null; }).catch(() => undefined);
  }
  const pending = pendingRead.promise;
  if (!signal) return pending;
  return new Promise<LearningMemory>((resolve, reject) => {
    const abort = () => reject(new DOMException("已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then((memory) => { if (!signal.aborted) resolve(memory); }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Always validates the current account/revision before reusing a personalised result. */
async function fetchLearningContext(): Promise<LearningMemory> {
  connect();
  const sequence = ++requestSequence;
  const temporary = state.temporary;
  const generation = localPracticeGeneration();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/learning-memory${temporary ? "?temporary=1" : ""}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message || "无法确认当前账户的学习记忆，请重试。");
    const memory = parseMemory(value);
    if (temporary !== state.temporary || !practiceGenerationCurrent(generation)) throw new Error("学习模式或本机数据已改变，请重新开始。");
    if (sequence === requestSequence) adopt(memory, generation);
    // A newer read/write must never be overwritten by this older response.
    if (sequence !== requestSequence && signature(state.memory) !== signature(memory)) throw new Error("学习记忆已更新，请重试。");
    return memory;
  } catch (error) {
    if (sequence === requestSequence) { state = { ...state, memory: null, epoch: state.epoch + 1, error: error instanceof Error ? error.message : "学习记忆暂不可用。" }; emit(); }
    throw error;
  } finally { clearTimeout(timer); }
}
export async function saveLearningMemory(next: LearningMemory, signal?: AbortSignal) {
  if (state.temporary) throw new Error("临时练习不会保存记忆。请先退出临时模式。");
  const current = await refreshLearningContext(signal);
  if (current.accountScope !== next.accountScope || current.revision !== next.revision) throw new Error("账户或记忆已更新，请重新读取后再保存。");
  const sequence = ++requestSequence;
  const generation = memoryGeneration;
  const response = await fetch("/api/learning-memory", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next), signal });
  const value = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? "其他页面更新了学习记忆。请重新读取，再保存你的修改。" : value?.error?.message || "记忆没有保存，请重试。");
  const memory = parseMemory(value);
  if (sequence !== requestSequence || state.temporary || signal?.aborted || !practiceGenerationCurrent(generation)) { invalidateLearningContext(true); throw new Error("学习模式已改变，请重新读取保存结果。"); }
  adopt(memory, generation, true);
  return memory;
}
export function contextStillCurrent(memory: LearningMemory, temporary: boolean) { return practiceGenerationCurrent(memoryGeneration) && temporary === state.temporary && signature(memory) === signature(state.memory); }
