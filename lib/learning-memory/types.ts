export type LearningNote = {
  id: string;
  text: string;
  source: "manual" | "confirmed_suggestion" | "legacy";
  kind: "preference" | "expression" | "learning_note";
  confirmedAt: string | null;
  updatedAt: string | null;
};
export type LearningMemory = { revision: number; enabled: boolean; notes: LearningNote[]; recentTopics: string[] };
export const CONTEXT_VERSION = "learning-memory-v1";
