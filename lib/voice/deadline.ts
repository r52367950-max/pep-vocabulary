import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { encryptApiKey, type StoredAiCredential } from "../ai-config";
import { AssistantInputError, AssistantUpstreamError } from "../assistant/core";

export const VOICE_CLOSE_GRACE_MS = 60 * 60 * 1000;
export const VOICE_FINALIZED_TTL_MS = 86_400_000;
export const voicePendingExpiry = (until: number) => until + VOICE_CLOSE_GRACE_MS;
export const voiceLeaseExpired = (until: number, now = Date.now()) => until <= now - VOICE_CLOSE_GRACE_MS;
export type VoiceCloseResult = { ok: true; confirmed: boolean; terminal: boolean; reason?: string };
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
/** A permanent rejection means this credential/control path cannot confirm a
 * close. Finalization must not be presented as proof that the provider ended. */
export function irrecoverableVoiceClose(error: unknown) {
  return error instanceof AssistantUpstreamError && !error.retryable && error.providerStatus !== null &&
    error.providerStatus >= 400 && error.providerStatus < 500 &&
    ![404, 408, 409, 425, 429].includes(error.providerStatus);
}

/** The finalized own-session row fences repeated cleanup even when a newer
 * call has the same timestamp lease. Both writes are one D1 transaction. */
export async function finalizeVoiceLease(database: D1Database, userKey: string, sessionId: string, until: number, now = Date.now()) {
  await database.batch([
    database.prepare(`UPDATE ai_rate_limits SET request_count=0, expires_at=?
      WHERE bucket_key=? AND request_count=? AND NOT EXISTS
        (SELECT 1 FROM ai_rate_limits WHERE bucket_key=? AND request_count!=?)`)
      .bind(now + VOICE_FINALIZED_TTL_MS, `voice-active:${userKey}`, until, `voice-session:${userKey}:${sessionId}`, until),
    database.prepare(`INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, 0, ?)
      ON CONFLICT(bucket_key) DO UPDATE SET request_count=0, expires_at=excluded.expires_at WHERE request_count=?`)
      .bind(`voice-session:${userKey}:${sessionId}`, now + VOICE_FINALIZED_TTL_MS, until),
  ]);
}
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
/** Null identifies a session created before durable deadlines were deployed. */
export async function closeVoiceDeadline(userKey: string, sessionId: string) {
  const response = await deadlineStub(userKey, sessionId).fetch("https://voice-deadline/close", { method: "POST" });
  if (response.status === 404) return null;
  if (!response.ok) throw new AssistantInputError("voice_close_unconfirmed", "会话结束状态尚未确认，服务端会继续重试。", 503);
  const result = await response.json() as Partial<VoiceCloseResult>;
  return { ok: true, confirmed: result.confirmed !== false, terminal: result.terminal === true,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}) } satisfies VoiceCloseResult;
}
