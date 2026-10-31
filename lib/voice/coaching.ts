import type { VoiceLevel, VoiceTopicId } from "./curriculum";

/** Account-scoped learning notes; raw conversation history is never auto-saved here. */
export type VoiceMemory = {
  revision: number;
  enabled: boolean;
  notes: Array<{ id: string; text: string }>;
  recentTopics: string[];
};
export type VoicePlan = {
  topicId: VoiceTopicId;
  level: VoiceLevel;
  minutes: 5 | 10 | 15 | 20;
  title: string;
  goal: string;
  openingPrompt: string;
  reason: string;
};
export type VoiceDiscussionMessage = { role: "user" | "assistant"; text: string };
export type VoiceDiscussion = { reply: string; memorySuggestions: string[] };

export const EMPTY_VOICE_MEMORY: VoiceMemory = { revision: 0, enabled: true, notes: [], recentTopics: [] };
