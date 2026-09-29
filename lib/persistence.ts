export const LAST_EXPORT_KEY = "pep-vocab-last-export";
const REMINDED_KEY = "pep-vocab-last-backup-reminder";
const REMINDER_DAYS = 14;
const DAY_MS = 86_400_000;

export type StorageStatus = {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
};

/** Asks the browser not to evict local learning data. Resolves false when unsupported or refused; never throws. */
export async function requestPersistentStorage() {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist)
      return false;
    if (await navigator.storage.persisted?.()) return true;
    return Boolean(await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function storageStatus(): Promise<StorageStatus> {
  const status: StorageStatus = { persisted: null, usage: null, quota: null };
  try {
    if (typeof navigator === "undefined" || !navigator.storage) return status;
    status.persisted = (await navigator.storage.persisted?.()) ?? null;
  } catch {
    /* Unknown stays unknown. */
  }
  try {
    const estimate = await navigator.storage?.estimate?.();
    status.usage = estimate?.usage ?? null;
    status.quota = estimate?.quota ?? null;
  } catch {
    /* The estimate is informational. */
  }
  return status;
}

function readTime(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
function writeTime(key: string, time: number) {
  try {
    localStorage.setItem(key, String(time));
    return true;
  } catch {
    return false;
  }
}

export const markBackupExported = (now = Date.now()) => {
  writeTime(LAST_EXPORT_KEY, now);
};

/** True at most once per 14 days, and only when no JSON backup was exported in that time. Records the reminder. */
export function takeBackupReminder(now = Date.now()) {
  const window = REMINDER_DAYS * DAY_MS;
  if (now - readTime(LAST_EXPORT_KEY) < window) return false;
  if (now - readTime(REMINDED_KEY) < window) return false;
  // Without storage the reminder cannot be rate-limited, so stay quiet.
  return writeTime(REMINDED_KEY, now);
}
