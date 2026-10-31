import { env } from "cloudflare:workers";
import { encryptApiKey, type StoredAiCredential } from "../ai-config";
import { AssistantInputError } from "../assistant/core";

export const VOICE_PENDING_EXPIRY = Number.MAX_SAFE_INTEGER;
export type VoiceDeadlineRecord = {
  userKey: string;
  sessionId: string;
  until: number;
  credential: StoredAiCredential;
};
export const voiceDeadlineScope = (userKey: string, sessionId: string) => ({
  userKey: `voice-deadline:${userKey}:${sessionId}`,
  provider: "openai-compatible" as const,
  baseUrl: "https://api.openai.com/v1",
});
export function requireVoiceDeadlines() {
  if (!env.VOICE_DEADLINES) throw new AssistantInputError("voice_deadline_unavailable", "服务端语音时限控制尚未就绪，请先使用设备听写或文字练习。", 503);
  return env.VOICE_DEADLINES;
}
function deadlineStub(userKey: string, sessionId: string) {
  const namespace = requireVoiceDeadlines();
  return namespace.get(namespace.idFromName(`${userKey}:${sessionId}`));
}
export async function armVoiceDeadline(userKey: string, sessionId: string, until: number, apiKey: string) {
  const credential = await encryptApiKey(apiKey, voiceDeadlineScope(userKey, sessionId));
  const response = await deadlineStub(userKey, sessionId).fetch("https://voice-deadline/arm", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userKey, sessionId, until, credential } satisfies VoiceDeadlineRecord),
  });
  if (!response.ok) throw new AssistantInputError("voice_deadline_unavailable", "无法确认服务端语音时限，连接未启动，请稍后重试。", 503);
}
/** False identifies a session created before durable deadlines were deployed. */
export async function closeVoiceDeadline(userKey: string, sessionId: string) {
  const response = await deadlineStub(userKey, sessionId).fetch("https://voice-deadline/close", { method: "POST" });
  if (response.status === 404) return false;
  if (!response.ok) throw new AssistantInputError("voice_close_unconfirmed", "会话结束状态尚未确认，服务端会继续重试。", 503);
  return true;
}
