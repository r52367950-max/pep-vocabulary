import type { LearnerProfile } from "./profile";

export type ChatModelChoice = "auto" | "sol" | "terra";
export type ChatAction = "translate" | "define" | "grammar" | "context" | "plan";
export type ChatEffort = "low" | "medium" | "high";
/** Server-reported phases contain no provider reasoning, source text or tool arguments. */
export type ChatProgress = { phase: "thinking" | "tool" | "verifying" };
export type ChatTurn = { role: "user" | "assistant"; text: string };
export type ChatQuote = { text: string; title?: string; before?: string; after?: string };
export type ChatFile = { name: string; text: string };
export type ChatRequest = {
  messages: ChatTurn[];
  model: ChatModelChoice;
  action?: ChatAction;
  quotes?: ChatQuote[];
  article?: { title: string; text: string };
  files?: ChatFile[];
  wordIds?: string[];
  includeRecords: boolean;
  temporary: boolean;
  profile?: LearnerProfile | null;
  accountScope?: string;
  contextRevision?: number;
  contextVersion?: string;
};
export type ChatActivityAction =
  | { type: "open-reading"; title: string }
  | { type: "start-dictation" | "start-review"; title: string; wordIds: string[]; minutes: number };
export type ChatProvenance = {
  origin: "model-generated";
  textbookQuotes: "unverified";
  evidenceIds: string[];
  userProvidedMaterial: boolean;
};
export type ChatResult = { text: string; actions: ChatActivityAction[]; provenance: ChatProvenance };

/** History never upgrades generated prose or stored citations to textbook evidence. */
export function parseChatProvenance(value: unknown): ChatProvenance {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    origin: "model-generated", textbookQuotes: "unverified",
    evidenceIds: Array.isArray(row.evidenceIds) ? [...new Set(row.evidenceIds.slice(0, 80).filter((id): id is string => typeof id === "string" && /^pep-[a-f0-9]{16}$/.test(id)))] : [],
    userProvidedMaterial: row.userProvidedMaterial === true,
  };
}

export const CHAT_LIMITS = {
  messages: 24,
  messageChars: 6000,
  historyChars: 20000,
  quotes: 4,
  quoteChars: 2000,
  quoteContextChars: 600,
  articleChars: 12000,
  files: 4,
  fileChars: 12000,
  wordIds: 32,
} as const;
