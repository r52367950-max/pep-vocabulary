export const JOURNAL_KINDS = ["vocabulary", "dictation", "writing", "reading", "assistant", "voice", "study"] as const;
export type JournalEvent = {
  eventId: string; kind: typeof JOURNAL_KINDS[number]; title: string; summary: string;
  refIds: string[]; counts: Record<string, number>; occurredAt: string; timezone: string; date: string;
  source: "learning_activity";
  edited?: boolean;
};
export type JournalDay = { date: string; summary: string; factsSummary: string; summarySource: "facts" | "edited"; updatedAt: string; eventCount: number; events: JournalEvent[]; eventsTruncated: boolean };
