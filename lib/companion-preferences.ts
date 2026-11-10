"use client";

export type CompanionPreferences = {
  sendMode: "enter" | "mod-enter";
  includeRecords: boolean;
  includeArticle: boolean;
  routePreference: "auto" | "gpt-6.1-sol" | "gpt-6.1-terra";
};
const KEY = "vocab-companion-preferences-v1";
const INITIAL: CompanionPreferences = { sendMode: "enter", includeRecords: true, includeArticle: true, routePreference: "auto" };
let value = INITIAL;
let loaded = false;
const listeners = new Set<() => void>();
export function parseCompanionPreferences(raw: string | null): CompanionPreferences {
  let input: Partial<CompanionPreferences> = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { /* defaults */ }
  if (!input || typeof input !== "object") input = {};
  return {
    sendMode: input.sendMode === "mod-enter" ? "mod-enter" : "enter",
    includeRecords: typeof input.includeRecords === "boolean" ? input.includeRecords : true,
    includeArticle: typeof input.includeArticle === "boolean" ? input.includeArticle : true,
    routePreference: input.routePreference === "gpt-6.1-sol" || input.routePreference === "gpt-6.1-terra" ? input.routePreference : "auto",
  };
}
function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { value = parseCompanionPreferences(localStorage.getItem(KEY)); } catch { value = INITIAL; }
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY && event.key !== null) return;
    value = parseCompanionPreferences(event.newValue);
    listeners.forEach((listener) => listener());
  });
}
export const companionPreferencesStore = {
  subscribe(listener: () => void) { load(); listeners.add(listener); return () => { listeners.delete(listener); }; },
  get() { load(); return value; },
  getServerSnapshot: () => INITIAL,
};
export function updateCompanionPreferences(patch: Partial<CompanionPreferences>) {
  load();
  value = parseCompanionPreferences(JSON.stringify({ ...value, ...patch }));
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* preference remains in memory */ }
  listeners.forEach((listener) => listener());
}

export function clearCompanionPreferences() {
  load(); value = INITIAL;
  try { localStorage.removeItem(KEY); } catch { /* defaults still apply in this tab */ }
  listeners.forEach((listener) => listener());
}
