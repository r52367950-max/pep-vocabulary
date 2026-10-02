import { USER_DATA_SCHEMA_VERSION, defaultSettings, validateBackup, validWriting, validUndoTarget, type AppSettings, type BackupPayload, type StoredCard, type ReviewEvent, type WritingRecord, type SkillVector } from "./backup";
export { USER_DATA_SCHEMA_VERSION, defaultSettings, validateBackup } from "./backup";
export type { AppSettings, StoredCard, ReviewEvent, WritingRecord, WritingVersion, WritingGenre, SkillName, SkillVector } from "./backup";
import { stableJson } from "./stable-json";

const DB_NAME = "pep-vocab-studio";
// Version 3 added writings. Version 4 preserves all records and prevents older
// clients without dataset guards from reopening the database after a replacement.
const DB_VERSION = 4;
const stores = ["cards", "events", "lists", "settings", "meta", "writings"] as const;
const backupStores = ["cards", "events", "lists", "settings", "writings"] as const;
type StoreName = (typeof stores)[number];
export const INITIAL_DATA_GENERATION = "initial";
const GENERATION_KEY = "data-generation";
const CLOUD_LINK_KEY = "cloud-link";
export type CloudLink = { identity: string; revision: number };

export class DataReplacedError extends Error {
  constructor() { super("本机数据已在其他页面替换或清空。请保留未保存的文字，再重新打开操作。"); }
}

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

/** Check the dataset under the same lock as the write, including currently absent records. */
function generationTransaction<T>(names: readonly StoreName[], mode: IDBTransactionMode, expected: string | undefined,
  work: (tx: IDBTransaction, result: (value: T) => void) => void) {
  let replaced = false;
  return runTransaction<T>([...new Set([...names, "meta" as const])], mode, (tx, result) => {
    tx.objectStore("meta").get(GENERATION_KEY).onsuccess = function () {
      const generation = this.result?.value ?? INITIAL_DATA_GENERATION;
      if (expected !== undefined && expected !== generation) { replaced = true; tx.abort(); return; }
      work(tx, result);
    };
  }).catch((error) => { throw replaced ? new DataReplacedError() : error; });
}

function announceReplacement() {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel("vocab-changes");
    channel.postMessage("replaced");
    channel.close();
  } catch { /* The transaction guard remains effective without cross-page notifications. */ }
}

export const getOne = <T>(store: StoreName, key: IDBValidKey) => transaction<T | undefined>(store, "readonly", (target) => target.get(key));
export const getAll = <T>(store: StoreName) => transaction<T[]>(store, "readonly", (target) => target.getAll());
export const putOne = <T>(store: StoreName, value: T) => transaction<IDBValidKey>(store, "readwrite", (target) => target.put(value));

export function updateCardMetadata(fallback: StoredCard, patch: { note?: string; toggleFavorite?: boolean }, generation?: string) {
  return generationTransaction<StoredCard>(["cards"], "readwrite", generation, (tx, result) => {
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

export async function commitReview(event: ReviewEvent, generation?: string) {
  await generationTransaction<void>(["cards", "events"], "readwrite", generation, (tx) => {
    const cards = tx.objectStore("cards");
    const request = cards.get(event.cardId);
    request.onsuccess = () => {
      const undo = event.eventType === "undo";
      const expected = undo ? event.after : event.before;
      if (stableJson(request.result || null) !== stableJson(expected)) { tx.abort(); return; }
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
  return runTransaction<{ cards: StoredCard[]; events: ReviewEvent[]; settings: AppSettings; generation: string }>(["cards", "events", "settings", "meta"], "readonly", (tx, result) => {
    const state = { cards: [] as StoredCard[], events: [] as ReviewEvent[], settings: structuredClone(defaultSettings), generation: INITIAL_DATA_GENERATION };
    tx.objectStore("cards").getAll().onsuccess = function () { state.cards = this.result; };
    tx.objectStore("events").getAll().onsuccess = function () { state.events = this.result; };
    tx.objectStore("settings").get("app").onsuccess = function () { state.settings = this.result || state.settings; };
    tx.objectStore("meta").get(GENERATION_KEY).onsuccess = function () { state.generation = this.result?.value ?? INITIAL_DATA_GENERATION; };
    result(state);
  });
}

/** Patches from independent tabs merge against the latest settings inside the write lock. */
export function patchSettings(patch: Partial<AppSettings>, generation?: string) {
  return generationTransaction<AppSettings>(["settings"], "readwrite", generation, (tx, result) => {
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

export async function exportBackup(generation?: string) {
  return generationTransaction<BackupPayload>(backupStores, "readonly", generation, (tx, result) => {
    const payload: BackupPayload = { schemaVersion: USER_DATA_SCHEMA_VERSION, exportedAt: new Date().toISOString(), cards: [], events: [], lists: [], settings: [], writings: [] };
    for (const name of backupStores) {
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { payload[name] = request.result; };
    }
    result(payload);
  });
}

export async function restoreBackup(payload: unknown, expectedGeneration?: string) {
  // Validate every row before opening the destructive transaction.
  const migrated = validateBackup(payload);
  const generation = createLocalId();
  await generationTransaction<void>(backupStores, "readwrite", expectedGeneration, (tx) => {
    for (const name of backupStores) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of migrated[name]) store.put(row);
    }
    tx.objectStore("meta").clear();
    tx.objectStore("meta").put({ key: GENERATION_KEY, value: generation });
  });
  announceReplacement();
  return generation;
}

export async function clearUserData(expectedGeneration?: string) {
  await generationTransaction<void>(stores, "readwrite", expectedGeneration, (tx) => {
    stores.forEach((name) => tx.objectStore(name).clear());
    tx.objectStore("meta").put({ key: GENERATION_KEY, value: createLocalId() });
  });
  announceReplacement();
}

export function readCloudLink(generation: string) {
  return generationTransaction<CloudLink | null>(["meta"], "readonly", generation, (tx, result) => {
    tx.objectStore("meta").get(CLOUD_LINK_KEY).onsuccess = function () {
      let link: unknown = this.result?.value;
      // Preserve pre-generation installations; after a replacement the old binding is never reused.
      if (!link && generation === INITIAL_DATA_GENERATION) {
        try { link = JSON.parse(localStorage.getItem("pep-vocab-cloud-link-v2") || "null"); } catch { /* No valid legacy binding. */ }
      }
      const value = link as Partial<CloudLink> | null;
      result(value && typeof value.identity === "string" && Number.isSafeInteger(value.revision) && value.revision! >= 0
        ? { identity: value.identity, revision: value.revision! } : null);
    };
  });
}

export async function saveCloudLink(link: CloudLink, generation: string) {
  await generationTransaction<void>(["meta"], "readwrite", generation, (tx) => {
    tx.objectStore("meta").put({ key: CLOUD_LINK_KEY, value: link });
  });
}

export const listWritings = () => getAll<WritingRecord>("writings");

export class WritingConflictError extends Error {
  constructor() { super("这篇作文已在其他页面修改或删除。当前文字仍在编辑框中，请复制保留后重新打开。"); }
}

/** expected=null creates only; an update compares the full prior snapshot in the same transaction. */
export async function saveWriting(record: WritingRecord, expected: WritingRecord | null = null, generation?: string) {
  if (!validWriting(record)) throw new Error("写作记录无效，未保存。");
  let conflict = false;
  await generationTransaction<void>(["writings"], "readwrite", generation, (tx) => {
    const store = tx.objectStore("writings");
    const request = store.get(record.id);
    request.onsuccess = () => {
      if (stableJson(request.result ?? null) !== stableJson(expected)) { conflict = true; tx.abort(); return; }
      store.put(record);
    };
  }).catch((error) => { throw conflict ? new WritingConflictError() : error; });
  return record;
}

export const deleteWriting = (id: string, generation?: string) => generationTransaction<undefined>(["writings"], "readwrite", generation, (tx, result) => {
  tx.objectStore("writings").delete(id).onsuccess = function () { result(this.result); };
});

export function emptySkills(): SkillVector {
  return { meaning: 0, listening: 0, spelling: 0, context: 0, collocation: 0, output: 0 };
}
