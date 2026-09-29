import { USER_DATA_SCHEMA_VERSION, defaultSettings, validateBackup, validWriting, validUndoTarget, type AppSettings, type BackupPayload, type StoredCard, type ReviewEvent, type WritingRecord, type SkillVector } from "./backup";
export { USER_DATA_SCHEMA_VERSION, defaultSettings, validateBackup } from "./backup";
export type { AppSettings, StoredCard, ReviewEvent, WritingRecord, WritingVersion, WritingGenre, SkillName, SkillVector } from "./backup";
import { stableJson } from "./stable-json";

const DB_NAME = "pep-vocab-studio";
// Version 3 adds the `writings` store; upgrading keeps every existing store and record.
const DB_VERSION = 3;
const stores = ["cards", "events", "lists", "settings", "meta", "writings"] as const;
const backupStores = ["cards", "events", "lists", "settings", "writings"] as const;
type StoreName = (typeof stores)[number];

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
      const write = () => {
        if (undo && !event.before) cards.delete(event.cardId);
        else cards.put(undo ? event.before! : event.after);
        tx.objectStore("events").add(event);
      };
      if (undo) {
        const target = tx.objectStore("events").get(event.targetEventId || "");
        target.onsuccess = () => {
          if (!validUndoTarget(target.result, event)) { tx.abort(); return; }
          write();
        };
      } else write();
    };
  });
}

export async function loadSettings() {
  return (await getOne<AppSettings>("settings", "app")) || structuredClone(defaultSettings);
}

/** Consistent card/event/settings snapshot: one database open and one read transaction. */
export function loadLearningState() {
  return runTransaction<{ cards: StoredCard[]; events: ReviewEvent[]; settings: AppSettings }>(["cards", "events", "settings"], "readonly", (tx, result) => {
    const state = { cards: [] as StoredCard[], events: [] as ReviewEvent[], settings: structuredClone(defaultSettings) };
    tx.objectStore("cards").getAll().onsuccess = function () { state.cards = this.result; };
    tx.objectStore("events").getAll().onsuccess = function () { state.events = this.result; };
    tx.objectStore("settings").get("app").onsuccess = function () { state.settings = this.result || state.settings; };
    result(state);
  });
}

/** Patches from independent tabs merge against the latest settings inside the write lock. */
export function patchSettings(patch: Partial<AppSettings>) {
  return runTransaction<AppSettings>(["settings"], "readwrite", (tx, result) => {
    const store = tx.objectStore("settings");
    store.get("app").onsuccess = function () {
      const next = { ...defaultSettings, ...this.result, ...patch, key: "app" as const, updatedAt: new Date().toISOString() };
      store.put(next);
      result(next);
    };
  });
}

export async function saveSettings(settings: AppSettings) {
  const next = { ...settings, key: "app" as const, updatedAt: new Date().toISOString() };
  await putOne("settings", next);
  return next;
}

export async function exportBackup() {
  return runTransaction<BackupPayload>(backupStores, "readonly", (tx, result) => {
    const payload: BackupPayload = { schemaVersion: USER_DATA_SCHEMA_VERSION, exportedAt: new Date().toISOString(), cards: [], events: [], lists: [], settings: [], writings: [] };
    for (const name of backupStores) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { payload[name] = request.result; };
    }
    result(payload);
  });
}

export async function restoreBackup(payload: unknown) {
  // Validate every row before opening the destructive transaction.
  const migrated = validateBackup(payload);
  await runTransaction<void>([...backupStores, "meta"], "readwrite", (tx) => {
    for (const name of backupStores) {
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

export const listWritings = () => getAll<WritingRecord>("writings");

export class WritingConflictError extends Error {
  constructor() { super("这篇作文已在其他页面修改或删除。当前文字仍在编辑框中，请复制保留后重新打开。"); }
}

/** expected=null creates only; an update compares the full prior snapshot in the same transaction. */
export async function saveWriting(record: WritingRecord, expected: WritingRecord | null = null) {
  if (!validWriting(record)) throw new Error("写作记录无效，未保存。");
  let conflict = false;
  await runTransaction<void>(["writings"], "readwrite", (tx) => {
    const store = tx.objectStore("writings");
    const request = store.get(record.id);
    request.onsuccess = () => {
      if (stableJson(request.result ?? null) !== stableJson(expected)) { conflict = true; tx.abort(); return; }
      store.put(record);
    };
  }).catch((error) => { throw conflict ? new WritingConflictError() : error; });
  return record;
}

export const deleteWriting = (id: string) => transaction<undefined>("writings", "readwrite", (store) => store.delete(id));

export function emptySkills(): SkillVector {
  return { meaning: 0, listening: 0, spelling: 0, context: 0, collocation: 0, output: 0 };
}
