import { clearLocalProfileConsent } from "./learning-context-client";
import { VOICE_HISTORY_KEY } from "./voice/client";
import { DICTATION_HISTORY_KEY } from "./voice/dictation";
import { resetLocalPracticeData } from "./local-practice-generation";

/** The device-wide reset covers every account that used this browser. */
export async function clearLocalPracticeData() {
  await resetLocalPracticeData((storage) => {
    // Snapshot before removing: Storage.key() indices shift after each deletion.
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key && ([VOICE_HISTORY_KEY, DICTATION_HISTORY_KEY].some((prefix) => key === prefix || key.startsWith(`${prefix}:`)) || key === "pep-vocab-voice-captions-v1")) {
        storage.removeItem(key);
      }
    }
    // Eagerly stop mounted panels; the persistent generation also fences tabs
    // whose asynchronous notification has not yet arrived.
    clearLocalProfileConsent();
  });
}
