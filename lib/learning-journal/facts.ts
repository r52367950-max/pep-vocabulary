import type { JournalEvent } from "./types";

const STRUCTURAL_KINDS = {
  voice: { title: "口语练习", counts: ["seconds", "turns"] },
  assistant: { title: "AI 学习练习", counts: ["tasks", "discussions"] },
  reading: { title: "阅读练习", counts: ["opened"] },
  dictation: { title: "听写练习", counts: ["total", "correct", "assisted"] },
} as const;

/** Shared by the request queue and server, including requests from older tabs. */
export function learningFacts<T extends { kind: JournalEvent["kind"]; title: string; summary?: string; refIds?: string[]; counts?: Record<string, number> }>(event: T): T {
  const policy = STRUCTURAL_KINDS[event.kind as keyof typeof STRUCTURAL_KINDS];
  if (!policy) return event;
  return { ...event, title: policy.title, summary: "", refIds: [], counts: Object.fromEntries(policy.counts.filter(key => Object.hasOwn(event.counts ?? {}, key)).map(key => [key, event.counts![key]])) };
}

export function isPrivateReadingEvent(event: { kind: string; eventId: string; refIds?: string[] }) {
  return event.kind === "reading" && (event.eventId.startsWith("reading-personal-") || (event.refIds ?? []).some(id => id.startsWith("personal-")));
}
