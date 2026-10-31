export const LOCAL_PRACTICE_GENERATION_KEY = "vocab-local-practice-generation-v1";
const LOCK = "vocab-local-practice-storage-v1";
export type PracticeGeneration = string | null;

export function localPracticeGeneration(): PracticeGeneration {
  try { return localStorage.getItem(LOCAL_PRACTICE_GENERATION_KEY) ?? "initial"; }
  catch { return null; }
}
export function practiceGenerationCurrent(generation: PracticeGeneration) {
  return generation === localPracticeGeneration();
}
function locks() { return typeof navigator === "undefined" ? undefined : navigator.locks; }
export function localPracticeWritesSupported() { return Boolean(locks()); }
function replaced() { return new Error("本机练习数据已清空，请重新开始练习。"); }

/** Read the generation and its data together. Reading remains available without Web Locks. */
export async function readLocalPracticeData<T>(read: (storage: Storage) => T) {
  const storage = localStorage;
  const operation = () => ({ generation: storage.getItem(LOCAL_PRACTICE_GENERATION_KEY) ?? "initial", value: read(storage) });
  return locks() ? locks()!.request(LOCK, operation) : operation();
}

/** Every sensitive persistence operation shares the reset lock and its captured generation. */
export async function writeLocalPracticeData<T>(generation: PracticeGeneration, write: (storage: Storage) => T) {
  const storage = localStorage;
  const manager = locks();
  if (!manager) throw new Error("此浏览器不支持安全保存本机练习记录；仍可练习，但不会保存记录或学习画像授权。");
  return manager.request(LOCK, () => {
    if (generation === null || generation !== (storage.getItem(LOCAL_PRACTICE_GENERATION_KEY) ?? "initial")) throw replaced();
    return write(storage);
  });
}

/** No writer can pass a stale generation check between the reset and its removals. */
export async function resetLocalPracticeData(reset: (storage: Storage) => void) {
  const storage = localStorage;
  const operation = () => {
    storage.setItem(LOCAL_PRACTICE_GENERATION_KEY, crypto.randomUUID());
    reset(storage);
  };
  const manager = locks();
  // Browsers without locks cannot persist sensitive practice data through our
  // writer, but must still be able to erase data saved by earlier versions.
  if (manager) await manager.request(LOCK, operation);
  else operation();
}
