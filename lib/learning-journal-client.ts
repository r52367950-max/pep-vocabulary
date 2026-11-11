import { invalidateLearningContext, learningContextStore, refreshLearningContext } from "./learning-context-client";
import { isPrivateReadingEvent, learningFacts } from "./learning-journal/facts";

export type LearningActivity = { eventId: string; kind: "vocabulary" | "dictation" | "writing" | "reading" | "assistant" | "voice" | "study"; title: string; summary?: string; refIds?: string[]; counts?: Record<string, number>; occurredAt?: string; timezone?: string };
export type JournalEvent = LearningActivity & { occurredAt: string; timezone: string; date: string; source: "learning_activity" };
export type LearningJournal = { accountScope: string; enabled: boolean; revision: number; privacyRevision: number; days: { date: string; summary: string; summarySource: "facts" | "edited"; events: JournalEvent[] }[] };
type JournalState = { journal: LearningJournal | null; error: string; pending: number };
const INITIAL: JournalState = { journal: null, error: "", pending: 0 };
let state = INITIAL;
const listeners = new Set<() => void>();
type Pending = { event: LearningActivity; scope: string; privacyRevision: number; attempts: number; created: number };
let queue: Pending[] = [];
let flushing: Promise<void> | null = null;
let connected = false;
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function emit() { state = { ...state, pending: queue.length }; listeners.forEach((listener) => listener()); }
function clear() { generation++; queue = []; clearTimeout(retryTimer); state = { ...INITIAL }; emit(); }
function connect() {
  if (connected) return;
  connected = true;
  let previous = learningContextStore.get();
  learningContextStore.subscribe(() => {
    const next = learningContextStore.get();
    if (next.temporary || (previous.memory && ((!next.memory && !next.error) || (next.memory && (previous.memory.accountScope !== next.memory.accountScope || previous.memory.contextVersion !== next.memory.contextVersion))))) clear();
    previous = next;
  });
  if (typeof window !== "undefined") window.addEventListener("online", () => { void flushLearningActivities(); });
}
export const learningJournalStore = { subscribe(listener: () => void) { connect(); listeners.add(listener); return () => { listeners.delete(listener); }; }, get: () => state, getServerSnapshot: () => INITIAL };
async function request(method = "GET", body?: unknown): Promise<LearningJournal> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`/api/learning-journal${method === "GET" ? `?timezone=${encodeURIComponent(timezone())}` : ""}`, { method, credentials: "same-origin", cache: "no-store", signal: controller.signal, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value?.error?.message || "学习日志暂时无法更新，请重试。"), { status: response.status, code: value?.error?.code });
    if (!value?.accountScope || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.privacyRevision) || !Array.isArray(value.days)) throw new Error("学习日志返回格式无效。");
    return value;
  } finally { clearTimeout(timeout); }
}
export async function refreshLearningJournal(): Promise<LearningJournal> {
  connect();
  if (learningContextStore.get().temporary) throw new Error("临时练习不读取学习日志。");
  const memory = await refreshLearningContext();
  const ticket = generation;
  const journal = await request();
  if (ticket !== generation || learningContextStore.get().temporary || learningContextStore.get().memory?.accountScope !== memory.accountScope || journal.accountScope !== memory.accountScope) throw new Error("账户或学习模式已改变，请重新读取日志。");
  state = { ...state, journal, error: "" };
  queue = queue.filter((item) => journal.enabled && item.scope === journal.accountScope && item.privacyRevision === journal.privacyRevision);
  emit(); return journal;
}
/** Learning facts only. Never pass raw conversations, audio, images or inferred permanent weaknesses. */
export async function recordLearningActivity(event: LearningActivity, options: { accountScope?: string } = {}): Promise<boolean> {
  connect();
  if (learningContextStore.get().temporary || !event.eventId || !event.title || isPrivateReadingEvent(event)) return false;
  event = learningFacts(event);
  const startedGeneration = generation;
  const occurredAt = event.occurredAt || new Date().toISOString();
  try {
    const expectedScope = options.accountScope || learningContextStore.get().memory?.accountScope;
    const journal = await refreshLearningJournal();
    if (startedGeneration !== generation || (expectedScope && journal.accountScope !== expectedScope) || !journal.enabled || learningContextStore.get().temporary) return false;
    if (journal.days.some((day) => day.events.some((item) => item.eventId === event.eventId))) return true;
    if (!queue.some((item) => item.scope === journal.accountScope && item.event.eventId === event.eventId)) {
      queue.push({ event: { ...event, summary: event.summary ?? "", refIds: event.refIds ?? [], counts: event.counts ?? {}, occurredAt, timezone: event.timezone || timezone() }, scope: journal.accountScope, privacyRevision: journal.privacyRevision, attempts: 0, created: Date.now() });
      queue = queue.slice(-40); emit();
    }
    await flushLearningActivities();
    return !queue.some((item) => item.event.eventId === event.eventId) && !state.error;
  } catch { return false; }
}
export function flushLearningActivities(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    while (queue.length) {
      const item = queue[0];
      const ticketBeforeAttempt = generation;
      if (Date.now() - item.created > 86_400_000 || item.attempts >= 5) { queue.shift(); emit(); continue; }
      try {
        const journal = await refreshLearningJournal();
        if (!queue.includes(item)) continue;
        if (!journal.enabled || learningContextStore.get().temporary) { clear(); break; }
        const ticket = generation;
        item.attempts++;
        const result = await request("POST", { ...item.event, accountScope: item.scope, privacyRevision: item.privacyRevision });
        if (ticket !== generation || learningContextStore.get().temporary || result.accountScope !== item.scope) break;
        queue = queue.filter((candidate) => candidate !== item);
        state = { ...state, journal: result, error: "" }; emit();
      } catch (cause) {
        const status = (cause as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 429) queue = queue.filter((candidate) => candidate !== item);
        else { item.attempts++; state = { ...state, error: "学习日志稍后会重试同步；离开页面后未同步的记录不会保留。" }; }
        if ((cause as { code?: string }).code === "journal_capacity_exceeded") state = { ...state, error: cause instanceof Error ? cause.message : "学习日志已达到账号保存上限。" };
        emit();
        if (queue.length && generation === ticketBeforeAttempt) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { void flushLearningActivities(); }, Math.min(60_000, 2_000 * 2 ** item.attempts)); }
        break;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
async function mutate(method: "PUT" | "DELETE", change: Record<string, unknown>) {
  if (learningContextStore.get().temporary) throw new Error("请退出临时练习后管理学习日志。");
  const displayed = state.journal;
  const journal = await refreshLearningJournal();
  if (!displayed || displayed.accountScope !== journal.accountScope || displayed.revision !== journal.revision) throw new Error("日志已更新，请检查最新内容后再保存。");
  const ticket = generation;
  const result = await request(method, { ...change, accountScope: journal.accountScope, revision: journal.revision });
  if (ticket !== generation || learningContextStore.get().temporary || result.accountScope !== journal.accountScope) throw new Error("学习模式已改变，请重新读取保存结果。");
  clear(); invalidateLearningContext(true);
  await refreshLearningContext();
  return refreshLearningJournal();
}
export const updateLearningJournal = (change: { enabled?: boolean; date?: string; summary?: string; eventId?: string; title?: string }) => mutate("PUT", change);
export const deleteLearningJournal = (change: { eventId?: string; date?: string; all?: boolean }) => mutate("DELETE", change);
