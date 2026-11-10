import type { Quote } from "./selection";
import type { Attachment } from "./sources";
import type { RequestPayload, SelectionAction, ModelChoice, ComplexPlanTier } from "./routing";
import type { PracticeItem, Score } from "./practice";
import type { CompanionPreferences } from "@/lib/companion-preferences";

export type Action =
  | { id: string; label: string; intent: "open-reading" }
  | { id: string; label: string; intent: "send"; text: string }
  | { id: string; label: string; intent: "start-dictation" | "start-review"; wordIds: string[]; minutes: number; title: string }
  | { id: string; label: string; intent: "open-settings"; section?: SettingsSection };
export type Block =
  | { type: "text"; text: string }
  | { type: "actions"; actions: Action[] }
  | { type: "notice"; tone: "info" | "warn"; text: string; continueFrom?: string };
export type UserMessage = {
  id: string; role: "user"; at: number; text: string; quotes: Quote[]; attachments: Attachment[];
  via: "text" | "action" | "voice"; action?: SelectionAction;
};
export type AssistantMessage = {
  id: string; role: "assistant"; at: number; status: "streaming" | "done" | "stopped" | "incomplete" | "error";
  blocks: Block[]; revealed: number; request: RequestPayload; routeReason: string;
};
export type RoundAnswer = { item: PracticeItem; answer: string; score: Score };
export type PracticeResult = { mode?: "dictation" | "review"; title: string; source: string; rounds: RoundAnswer[][] };
export type ResultMessage = { id: string; role: "result"; at: number; result: PracticeResult };
export type Caption = { speaker: "user" | "ai"; text: string };
export type VoiceMessage = { id: string; role: "voice"; at: number; captions: Caption[]; seconds: number };
export type Message = UserMessage | AssistantMessage | ResultMessage | VoiceMessage;
export type Conversation = {
  id: string; title: string; temporary: boolean; model?: ModelChoice;
  createdAt: number; updatedAt: number; messages: Message[];
};
export type Draft = {
  text: string; quotes: Quote[]; attachments: Attachment[]; includeRecords: boolean; includeArticle: boolean;
};
export type Settings = CompanionPreferences & {
  theme: "system" | "light" | "dark"; motion: "system" | "reduce"; dailyMinutes: number;
  complexPlanTier: ComplexPlanTier;
};
export type SettingsSection = "general" | "learning" | "chat" | "model" | "privacy" | "about";
export const DEFAULT_SETTINGS: Settings = {
  theme: "system", motion: "system", dailyMinutes: 15, sendMode: "enter", includeRecords: true,
  includeArticle: true, routePreference: "auto", complexPlanTier: "sol-high",
};
export type LearnView = "today" | "words" | "reading" | "records" | "dictation";
export type View = LearnView | "chat";
