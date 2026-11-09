import type { Quote } from "./selection";
import type { Attachment } from "./sources";
import type { RequestPayload, SelectionAction, ModelChoice, ComplexPlanTier, ServiceState } from "./routing";
import type { PlanScope, PlanSpec, PracticeItem, Score } from "./practice";

export type QuoteMode = "translate" | "define" | "grammar" | "context";
export type Action =
  | { id: string; label: string; intent: "open-reading" }
  | { id: string; label: string; intent: "send"; text: string }
  | { id: string; label: string; intent: "start-dictation"; items: PracticeItem[]; title: string }
  | { id: string; label: string; intent: "open-settings"; section: SettingsSection };

export type Block =
  | { type: "text"; text: string }
  | { type: "quote-answer"; mode: QuoteMode; quote: Quote; focus?: string }
  | { type: "plan"; spec: PlanSpec }
  | { type: "long-plan"; days: number; minutes: number; restWeekdays: number[]; order: "review-first" | "new-first"; startedAt: number; added?: "pending" | "added" }
  | { type: "status" }
  | { type: "sources"; read: { name: string; chars: number; truncated: boolean; excerpt: string }[]; attached: { name: string; kind: string }[]; records: boolean; article: "full" | "off" | "none"; quotes: number }
  | { type: "actions"; actions: Action[] }
  | { type: "notice"; tone: "info" | "warn"; text: string; continueFrom?: string };

export type UserMessage = {
  id: string; role: "user"; at: number; text: string; quotes: Quote[]; attachments: Attachment[];
  via: "text" | "action" | "voice"; action?: SelectionAction;
};
export type AssistantMessage = {
  id: string; role: "assistant"; at: number; status: "streaming" | "done" | "stopped" | "incomplete";
  blocks: Block[]; revealed: number; request: RequestPayload; routeReason: string;
  /** Demo only: the part an incomplete answer did not deliver, released by an explicit "continue". */
  remainder?: Block[];
};
export type RoundAnswer = { item: PracticeItem; answer: string; score: Score };
export type PracticeResult = { title: string; source: string; rounds: RoundAnswer[][] };
export type ResultMessage = { id: string; role: "result"; at: number; result: PracticeResult };
export type Caption = { speaker: "user" | "ai"; text: string };
export type VoiceMessage = { id: string; role: "voice"; at: number; captions: Caption[]; seconds: number };
export type Message = UserMessage | AssistantMessage | ResultMessage | VoiceMessage;

export type Conversation = {
  id: string; title: string; temporary: boolean; sample?: boolean;
  /** Model picked in the composer for this conversation; absent means the settings default. */
  model?: ModelChoice;
  createdAt: number; updatedAt: number; messages: Message[];
};

export type Draft = {
  text: string; quotes: Quote[]; attachments: Attachment[];
  includeRecords: boolean; includeArticle: boolean;
};

export type SendMode = "enter" | "mod-enter";
export type Settings = {
  theme: "system" | "light" | "dark";
  motion: "system" | "reduce";
  dailyMinutes: number;
  defaultScope: Exclude<PlanScope, "file">;
  confirmBeforeSchedule: boolean;
  sendMode: SendMode;
  includeRecords: boolean;
  includeArticle: boolean;
  routePreference: ModelChoice;
  complexPlanTier: ComplexPlanTier;
  service: ServiceState;
};
export type SettingsSection = "general" | "learning" | "chat" | "model" | "privacy" | "about";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  motion: "system",
  dailyMinutes: 15,
  defaultScope: "mistakes",
  confirmBeforeSchedule: true,
  sendMode: "enter",
  includeRecords: true,
  includeArticle: true,
  routePreference: "auto",
  complexPlanTier: "sol-high",
  service: "normal",
};

export type LearnView = "today" | "words" | "reading" | "records" | "dictation";
export type View = LearnView | "chat";
