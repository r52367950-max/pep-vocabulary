export const USER_DATA_SCHEMA_VERSION = "1.1.0";
const DB_NAME = "pep-vocab-studio";
const DB_VERSION = 2;
const stores = ["cards", "events", "lists", "settings", "meta"] as const;
type StoreName = (typeof stores)[number];

export type SkillName = "meaning" | "listening" | "spelling" | "context" | "collocation" | "output";
export type SkillVector = Record<SkillName, number>;

export function createLocalId() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export type StoredCard = {
  id: string;
  fsrs: Record<string, unknown>;
  skills: SkillVector;
  status: "unseen" | "learning" | "weak" | "mastered" | "paused";
  due: string;
  lastReviewed: string | null;
  updatedAt: string;
  note?: string;
  tags?: string[];
  favorite?: boolean;
};

export type ReviewEvent = {
  eventType?: "review" | "undo";
  eventId: string;
  cardId: string;
  timestampUtc: string;
  localDate: string;
  timezone: string;
  questionType: string;
  skill: SkillName;
  rating: 1 | 2 | 3 | 4;
  correct: boolean;
  responseMs: number;
  hints: number;
  errorType: string | null;
  prompt?: string;
  answerGiven?: string | null;
  expectedAnswer?: string | null;
  sourceLine?: string | null;
  intervalBeforeDays?: number | null;
  intervalAfterDays?: number;
  stabilityBefore?: number | null;
  stabilityAfter?: number;
  difficultyBefore?: number | null;
  difficultyAfter?: number;
  before: StoredCard | null;
  after: StoredCard;
  schedulerLog: Record<string, unknown>;
  undoneBy?: string;
  targetEventId?: string;
};

export type AppSettings = {
  key: "app";
  dailyMinutes: number;
  desiredRetention: number;
  selectedBooks: string[];
  mode: "normal" | "unit" | "review-only" | "exam" | "browse";
  theme: "light" | "dark" | "system";
  aiEnabled: boolean;
  diagnosisComplete: boolean;
  examDate: string | null;
  updatedAt: string;
};

export const defaultSettings: AppSettings = {
  key: "app",
  dailyMinutes: 45,
  desiredRetention: 0.9,
  selectedBooks: ["HS-R1", "HS-R2", "HS-R3", "HS-S1", "HS-S2", "HS-S3", "HS-S4"],
  mode: "normal",
  theme: "system",
  aiEnabled: false,
  diagnosisComplete: false,
  examDate: null,
  updatedAt: new Date(0).toISOString(),
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error("请关闭其他词迹页面后重试数据库升级。")); };
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: store === "events" ? "eventId" : store === "settings" || store === "meta" ? "key" : "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function runTransaction<T>(names: readonly StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void) => void) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let value: T;
    try { tx = db.transaction([...names], mode); }
    catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("本地保存已取消，数据未提交。")); };
    try { work(tx, (result) => { value = result; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

function transaction<T>(storeName: StoreName, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  return runTransaction<T>([storeName], mode, (tx, result) => {
    const request = work(tx.objectStore(storeName));
    request.onsuccess = () => result(request.result);
  });
}

export const getOne = <T>(store: StoreName, key: IDBValidKey) => transaction<T | undefined>(store, "readonly", (target) => target.get(key));
export const getAll = <T>(store: StoreName) => transaction<T[]>(store, "readonly", (target) => target.getAll());
export const putOne = <T>(store: StoreName, value: T) => transaction<IDBValidKey>(store, "readwrite", (target) => target.put(value));

export function updateCardMetadata(fallback: StoredCard, patch: { note?: string; toggleFavorite?: boolean }) {
  return runTransaction<StoredCard>(["cards"], "readwrite", (tx, result) => {
    const store = tx.objectStore("cards");
    const request = store.get(fallback.id);
    request.onsuccess = () => {
      const current: StoredCard = request.result || fallback;
      const next = { ...current, ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.toggleFavorite ? { favorite: !current.favorite } : {}), updatedAt: new Date().toISOString() };
      store.put(next);
      result(next);
    };
  });
}

export async function commitReview(event: ReviewEvent) {
  await runTransaction<void>(["cards", "events"], "readwrite", (tx) => {
    const cards = tx.objectStore("cards");
    const request = cards.get(event.cardId);
    request.onsuccess = () => {
      const undo = event.eventType === "undo";
      const expected = undo ? event.after : event.before;
      if (JSON.stringify(request.result || null) !== JSON.stringify(expected)) { tx.abort(); return; }
      // The card and its audit event either both commit or both roll back.
      if (undo && !event.before) cards.delete(event.cardId);
      else cards.put(undo ? event.before! : event.after);
      tx.objectStore("events").add(event);
    };
  });
}

export async function loadSettings() {
  return (await getOne<AppSettings>("settings", "app")) || structuredClone(defaultSettings);
}

export async function saveSettings(settings: AppSettings) {
  const next = { ...settings, key: "app" as const, updatedAt: new Date().toISOString() };
  await putOne("settings", next);
  return next;
}

export async function exportBackup() {
  return runTransaction<BackupPayload>(["cards", "events", "lists", "settings"], "readonly", (tx, result) => {
    const payload: BackupPayload = { schemaVersion: USER_DATA_SCHEMA_VERSION, exportedAt: new Date().toISOString(), cards: [], events: [], lists: [], settings: [] };
    for (const name of ["cards", "events", "lists", "settings"] as const) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { payload[name] = request.result; };
    }
    result(payload);
  });
}

type BackupPayload = {
  schemaVersion: string;
  exportedAt?: string;
  cards: StoredCard[];
  events: ReviewEvent[];
  lists: Record<string, unknown>[];
  settings: AppSettings[];
};

function migrateBackup(payload: BackupPayload): BackupPayload {
  if (payload.schemaVersion === USER_DATA_SCHEMA_VERSION) return payload;
  if (payload.schemaVersion !== "1.0.0") throw new Error(`不支持的 schema 版本：${payload.schemaVersion || "缺失"}`);
  return {
    ...payload,
    schemaVersion: USER_DATA_SCHEMA_VERSION,
    events: payload.events.map((event) => ({ ...event, prompt: event.prompt || "", answerGiven: event.answerGiven ?? null, expectedAnswer: event.expectedAnswer ?? null, sourceLine: event.sourceLine ?? null })),
    settings: payload.settings.map((settings) => ({ ...defaultSettings, ...settings, key: "app" })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validDate = (value: unknown) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const finiteRange = (value: unknown, low: number, high = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const stringArray = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string" && item.length <= 500);
const skills = ["meaning", "listening", "spelling", "context", "collocation", "output"] as const;

function validCard(value: unknown): value is StoredCard {
  if (!isRecord(value) || !textId(value.id) || !validDate(value.due) || !validDate(value.updatedAt) || (value.lastReviewed !== null && !validDate(value.lastReviewed))) return false;
  if (!["unseen", "learning", "weak", "mastered", "paused"].includes(String(value.status)) || !isRecord(value.skills) || !isRecord(value.fsrs)) return false;
  const vector = value.skills, fsrs = value.fsrs;
  return skills.every((skill) => finiteRange(vector[skill], 0, 1)) && validDate(fsrs.due) &&
    (!fsrs.last_review || validDate(fsrs.last_review)) &&
    ["stability", "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses", "state"].every((key) => finiteRange(fsrs[key], 0)) &&
    finiteRange(fsrs.difficulty, 0, 10) && finiteRange(fsrs.state, 0, 3) && Number.isInteger(fsrs.state) &&
    (fsrs.learning_steps === undefined || finiteRange(fsrs.learning_steps, 0)) &&
    (value.note === undefined || (typeof value.note === "string" && value.note.length <= 50_000)) &&
    (value.favorite === undefined || typeof value.favorite === "boolean") && (value.tags === undefined || stringArray(value.tags));
}

export function validateBackup(payload: unknown): BackupPayload {
  if (!isRecord(payload) || !["cards", "events", "lists", "settings"].every((key) => Array.isArray(payload[key]))) throw new Error("备份结构损坏或字段缺失");
  for (const name of ["cards", "events", "lists", "settings"] as const) {
    const rows = payload[name] as unknown[];
    if (rows.length > (name === "events" ? 100_000 : name === "settings" ? 1 : 20_000)) throw new Error("备份记录数量超过限制");
    const ids = new Set<string>();
    for (const row of rows) {
      const key = name === "events" ? "eventId" : name === "settings" ? "key" : "id";
      if (!isRecord(row) || !textId(row[key]) || ids.has(row[key])) throw new Error("备份包含无效或重复的记录 ID");
      ids.add(row[key]);
    }
  }
  const data = migrateBackup(payload as unknown as BackupPayload);
  if (!data.cards.every(validCard)) throw new Error("备份的词卡或调度数据无效");
  for (const event of data.events) {
    if (!textId(event.cardId) || !validDate(event.timestampUtc) || !/^\d{4}-\d{2}-\d{2}$/.test(event.localDate) ||
      typeof event.timezone !== "string" || typeof event.questionType !== "string" || !skills.includes(event.skill) ||
      ![1, 2, 3, 4].includes(event.rating) || typeof event.correct !== "boolean" ||
      !finiteRange(event.responseMs, 0) || !finiteRange(event.hints, 0) || !isRecord(event.schedulerLog) ||
      !validCard(event.after) || event.after.id !== event.cardId || (event.before !== null && (!validCard(event.before) || event.before.id !== event.cardId)) ||
      (event.eventType !== undefined && !["review", "undo"].includes(event.eventType)) || (event.eventType === "undo" && !textId(event.targetEventId)) ||
      [event.prompt, event.answerGiven, event.expectedAnswer, event.sourceLine, event.errorType].some((value) => value != null && typeof value !== "string")) throw new Error("备份的复习事件无效");
  }
  for (const settings of data.settings) {
    if (settings.key !== "app" || !finiteRange(settings.dailyMinutes, 1, 1440) || !finiteRange(settings.desiredRetention, 0.7, 0.99) ||
      !stringArray(settings.selectedBooks) || !["normal", "unit", "review-only", "exam", "browse"].includes(settings.mode) ||
      !["light", "dark", "system"].includes(settings.theme) || typeof settings.aiEnabled !== "boolean" ||
      typeof settings.diagnosisComplete !== "boolean" || !validDate(settings.updatedAt) ||
      (settings.examDate !== null && !validDate(settings.examDate))) throw new Error("备份的学习设置无效");
  }
  return data;
}

export async function restoreBackup(payload: unknown) {
  // Validate every row before opening the destructive transaction.
  const migrated = validateBackup(payload);
  await runTransaction<void>(["cards", "events", "lists", "settings", "meta"], "readwrite", (tx) => {
    for (const name of ["cards", "events", "lists", "settings"] as const) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of migrated[name]) store.put(row);
    }
    tx.objectStore("meta").clear();
  });
}

export async function clearUserData() {
  await runTransaction<void>(stores, "readwrite", (tx) => {
    stores.forEach((name) => tx.objectStore(name).clear());
  });
}

export function emptySkills(): SkillVector {
  return { meaning: 0, listening: 0, spelling: 0, context: 0, collocation: 0, output: 0 };
}
