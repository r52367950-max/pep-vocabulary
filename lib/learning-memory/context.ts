import { AssistantInputError } from "@/lib/assistant/core";
import { memoryDatabase, readLearningMemory } from "./store";
import { CONTEXT_VERSION, type LearningMemory } from "./types";
import { journalContext, journalMetadata } from "@/lib/learning-journal/store";

export async function accountScope(userKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`learning-context:${userKey}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function memoryMetadata(userKey: string) {
  const row = await memoryDatabase().prepare("SELECT revision, enabled FROM voice_learning_memories WHERE user_key = ?").bind(userKey).first<{ revision: number; enabled: number }>();
  // Settings writes change the token; background ciphertext refreshes do not.
  const config = await memoryDatabase().prepare("SELECT c.provider, c.base_url, c.model, c.write_token, p.updated_at AS preferences_updated_at FROM ai_configs c LEFT JOIN ai_preferences p ON p.user_key = c.user_key WHERE c.user_key = ?").bind(userKey).first();
  const configHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config ?? "unconfigured")));
  const version = [...new Uint8Array(configHash)].map(b => b.toString(16).padStart(2, "0")).join("");
  const journal=await journalMetadata(userKey);
  return { accountScope: await accountScope(userKey), revision: row?.revision ?? 0, enabled: row ? row.enabled === 1 : true, contextVersion: `${CONTEXT_VERSION}:${version}:journal-${journal.privacyRevision}`, journalRevision: journal.revision };
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
