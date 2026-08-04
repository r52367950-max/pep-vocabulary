export const USER_DATA_SCHEMA_VERSION = "1.1.0";
const DB_NAME = "pep-vocab-studio";
const DB_VERSION = 2;
const stores = ["cards", "events", "lists", "settings", "meta"] as const;
type StoreName = (typeof stores)[number];
export const ACTIVE_ACQUISITION_ID = "active-acquisition";
export type AcquisitionProgressRecord = { id: typeof ACTIVE_ACQUISITION_ID; kind: "acquisition-session"; payload: string; updatedAt: string };

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
  aiEnabled: true,
  diagnosisComplete: false,
  examDate: null,
  updatedAt: new Date(0).toISOString(),
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: store === "events" ? "eventId" : store === "settings" || store === "meta" ? "key" : "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = null; };
      db.onclose = () => { databasePromise = null; };
      resolve(db);
    };
    request.onerror = () => { databasePromise = null; reject(request.error || new Error("IndexedDB open failed")); };
  });
  return databasePromise;
}

async function transaction<T>(storeName: StoreName, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

export const getOne = <T>(store: StoreName, key: IDBValidKey) => transaction<T | undefined>(store, "readonly", (target) => target.get(key));
export const getAll = <T>(store: StoreName) => transaction<T[]>(store, "readonly", (target) => target.getAll());
export const putOne = <T>(store: StoreName, value: T) => transaction<IDBValidKey>(store, "readwrite", (target) => target.put(value));
export const deleteOne = (store: StoreName, key: IDBValidKey) => transaction<undefined>(store, "readwrite", (target) => target.delete(key));

export async function putRecords(records: Array<{ store: StoreName; value: unknown }>) {
  if (!records.length) return;
  const db = await openDatabase();
  const names = [...new Set(records.map((record) => record.store))];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, "readwrite");
    for (const record of records) tx.objectStore(record.store).put(record.value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB batch write failed"));
  });
}

export const loadAcquisitionProgress = () => getOne<AcquisitionProgressRecord>("lists", ACTIVE_ACQUISITION_ID);
export const saveAcquisitionProgress = (payload: string) => putOne("lists", {
  id: ACTIVE_ACQUISITION_ID,
  kind: "acquisition-session" as const,
  payload,
  updatedAt: new Date().toISOString(),
} satisfies AcquisitionProgressRecord);
export const clearAcquisitionProgress = () => deleteOne("lists", ACTIVE_ACQUISITION_ID);

export async function loadSettings() {
  try {
    return (await getOne<AppSettings>("settings", "app")) || defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: AppSettings) {
  const next = { ...settings, key: "app" as const, updatedAt: new Date().toISOString() };
  await putOne("settings", next);
  return next;
}

export async function exportBackup() {
  const [cards, events, lists, settings] = await Promise.all([
    getAll<StoredCard>("cards"), getAll<ReviewEvent>("events"), getAll<Record<string, unknown>>("lists"), getAll<AppSettings>("settings"),
  ]);
  return { schemaVersion: USER_DATA_SCHEMA_VERSION, exportedAt: new Date().toISOString(), cards, events, lists, settings };
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

export async function restoreBackup(payload: unknown) {
  if (!payload || typeof payload !== "object") throw new Error("备份不是有效对象");
  const data = payload as Record<string, unknown>;
  if (!["cards", "events", "lists", "settings"].every((key) => Array.isArray(data[key]))) throw new Error("备份结构损坏或字段缺失");
  const migrated = migrateBackup(data as unknown as BackupPayload);
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["cards", "events", "lists", "settings"], "readwrite");
    for (const name of ["cards", "events", "lists", "settings"] as const) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of migrated[name] as object[]) store.put(row);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("恢复失败"));
  });
}

export async function clearUserData() {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    stores.forEach((name) => tx.objectStore(name).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("清空失败"));
  });
}

export function emptySkills(): SkillVector {
  return { meaning: 0, listening: 0, spelling: 0, context: 0, collocation: 0, output: 0 };
}
