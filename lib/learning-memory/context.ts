import { AssistantInputError } from "@/lib/assistant/core";
import { memoryDatabase, readLearningMemory } from "./store";
import { CONTEXT_VERSION, type LearningMemory } from "./types";
import { journalContext } from "@/lib/learning-journal/store";

async function digestText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function accountScope(userKey: string) {
  return digestText(`learning-context:${userKey}`);
}
export async function memoryMetadata(userKey: string) {
  // Start from the requested key so new accounts get a row even before any settings are saved.
  const row = await memoryDatabase().prepare(`SELECT m.revision,m.enabled,
    j.revision AS journal_revision,j.privacy_revision,
    c.provider,c.base_url,c.model,c.write_token,p.updated_at AS preferences_updated_at
    FROM (SELECT ? AS user_key) u
    LEFT JOIN voice_learning_memories m ON m.user_key=u.user_key
    LEFT JOIN learning_journal_settings j ON j.user_key=u.user_key
    LEFT JOIN ai_configs c ON c.user_key=u.user_key
    LEFT JOIN ai_preferences p ON p.user_key=c.user_key`).bind(userKey).first<{
      revision: number | null; enabled: number | null; journal_revision: number | null; privacy_revision: number | null;
      provider: string | null; base_url: string | null; model: string | null; write_token: string | null; preferences_updated_at: string | null;
    }>();
  if (!row) throw new Error("Learning metadata unavailable");
  const { revision, enabled, journal_revision, privacy_revision, ...config } = row;
  // User settings rotate the write token, while background ciphertext refreshes leave it intact.
  const [scope, version] = await Promise.all([
    accountScope(userKey), digestText(JSON.stringify(config.provider === null ? "unconfigured" : config)),
  ]);
  return {
    accountScope: scope, revision: revision ?? 0, enabled: enabled !== 0,
    contextVersion: `${CONTEXT_VERSION}:${version}:journal-${privacy_revision ?? 0}`,
    journalRevision: journal_revision ?? 0,
  };
}
function assertMetadata(metadata: Awaited<ReturnType<typeof memoryMetadata>>, body: Record<string, unknown>) {
  if (body.accountScope !== undefined && body.accountScope !== metadata.accountScope) throw new AssistantInputError("learning_account_changed", "登录账号已变化，请重新读取学习记忆。", 409);
  if (body.contextRevision !== undefined && (!Number.isSafeInteger(body.contextRevision) || body.contextRevision !== metadata.revision)) throw new AssistantInputError("learning_context_changed", "学习记忆已更新，请重新载入后再试。", 409);
  if (body.contextVersion !== undefined && body.contextVersion !== metadata.contextVersion) throw new AssistantInputError("learning_context_changed", "AI 设置已更新，请重新载入后再试。", 409);
}
/** Recheck privacy/configuration without rereading private notes and activity text. */
export async function verifyLearningContext(userKey: string, context: Awaited<ReturnType<typeof memoryMetadata>>) {
  assertMetadata(await memoryMetadata(userKey), { accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion });
}
export async function resolveLearningContext(userKey: string, body: Record<string, unknown>) {
  if (body.temporary !== undefined && typeof body.temporary !== "boolean") throw new AssistantInputError("invalid_request", "临时会话参数无效。");
  const metadata = await memoryMetadata(userKey), temporary = body.temporary === true;
  assertMetadata(metadata, body);
  const enabled = metadata.enabled && !temporary;
  const memory: LearningMemory = enabled ? await readLearningMemory(userKey) : { revision: metadata.revision, enabled: false, notes: [], recentTopics: [] };
  // A concurrent write between metadata and content reads must never label old context as new.
  if (memory.revision !== metadata.revision) throw new AssistantInputError("learning_context_changed", "学习记忆已更新，请重试。", 409);
  if(enabled) {
    memory.learningJournal=await journalContext(userKey);
    await verifyLearningContext(userKey, metadata);
  }
  return { ...metadata, enabled, temporary, memory };
}
export function contextMetadata(context: Awaited<ReturnType<typeof resolveLearningContext>>) {
  return { accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion, journalRevision:context.journalRevision, temporary: context.temporary };
}
export function learningContextData(memory: LearningMemory) {
  return memory.enabled ? { learningNotes: memory.notes.map(note => ({ text: note.text, kind: note.kind, source: note.source })), recentTopics: memory.recentTopics, learningJournal:memory.learningJournal??[] } : { learningNotes: [], recentTopics: [],learningJournal:[] };
}
