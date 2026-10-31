import { env } from "cloudflare:workers";
import { AssistantInputError } from "@/lib/assistant/core";
import type { LearningMemory, LearningNote } from "./types";

export function memoryDatabase() {
  if (!env.DB) throw new AssistantInputError("voice_memory_unavailable", "暂时无法读取学习记忆，请稍后重试。", 503);
  return env.DB;
}
function invalid(message: string): never { throw new AssistantInputError("invalid_request", message); }
function text(value: unknown, max: number) {
  if (typeof value !== "string" || value.length > max) return invalid("学习记忆格式或长度无效。");
  const result = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!result) return invalid("学习记忆不能为空。");
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("学习记忆格式无效。");
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 30 || !Number.isFinite(Date.parse(value))) return invalid("记忆时间无效。");
  return new Date(value).toISOString();
}
export function parseMemory(value: unknown): LearningMemory {
  const body = record(value);
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || typeof body.enabled !== "boolean") return invalid("学习记忆版本无效，请重新载入。");
  if (!Array.isArray(body.notes) || body.notes.length > 20) return invalid("学习记忆最多保留 20 条。");
  const notes = body.notes.map((raw): LearningNote => {
    const item = record(raw), id = text(item.id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return invalid("记忆标识无效。");
    const source = item.source ?? "legacy", kind = item.kind ?? "learning_note";
    if (source !== "manual" && source !== "confirmed_suggestion" && source !== "legacy") return invalid("记忆来源无效。");
    if (kind !== "preference" && kind !== "expression" && kind !== "learning_note") return invalid("记忆类型无效。");
    return { id, text: text(item.text, 400), source, kind, confirmedAt: timestamp(item.confirmedAt), updatedAt: timestamp(item.updatedAt) };
  });
  if (new Set(notes.map(n => n.id)).size !== notes.length) return invalid("学习记忆标识不能重复。");
  if (!Array.isArray(body.recentTopics) || body.recentTopics.length > 12) return invalid("最近话题最多保留 12 条。");
  return { revision: Number(body.revision), enabled: body.enabled, notes, recentTopics: [...new Set(body.recentTopics.map(t => text(t, 160)))] };
}
export async function readLearningMemory(userKey: string): Promise<LearningMemory> {
  const row = await memoryDatabase().prepare("SELECT revision, enabled, notes, recent_topics FROM voice_learning_memories WHERE user_key = ?").bind(userKey)
    .first<{ revision: number; enabled: number; notes: string; recent_topics: string }>();
  return row ? parseMemory({ revision: row.revision, enabled: row.enabled === 1, notes: JSON.parse(row.notes), recentTopics: JSON.parse(row.recent_topics) }) : { revision: 0, enabled: true, notes: [], recentTopics: [] };
}
export async function saveLearningMemory(userKey: string, raw: unknown): Promise<LearningMemory> {
  const body = record(raw);
  if (body.temporary !== undefined && typeof body.temporary !== "boolean") return invalid("临时会话参数无效。");
  if (body.temporary === true) throw new AssistantInputError("temporary_memory_write", "临时会话不保存学习记忆。", 409);
  const input = parseMemory(body), current = await readLearningMemory(userKey), now = new Date().toISOString();
  if (input.revision !== current.revision) throw new AssistantInputError("voice_memory_conflict", "学习记忆已在别处更新。请重新载入后再保存。", 409);
  input.notes = input.notes.map(note => {
    const old = current.notes.find(n => n.id === note.id);
    const supplied = (body.notes as Record<string, unknown>[]).find(n => n.id === note.id)!;
    // Legacy clients send only id/text: retain provenance instead of dropping it.
    const source = supplied.source === undefined ? old?.source ?? "manual" : note.source;
    const kind = supplied.kind === undefined ? old?.kind ?? "learning_note" : note.kind;
    const changed = !old || old.text !== note.text || old.kind !== kind || old.source !== source;
    return { ...note, source, kind, confirmedAt: old?.confirmedAt ?? (old?.source === "legacy" && !changed ? null : now), updatedAt: changed ? now : old?.updatedAt ?? null };
  });
  const db = memoryDatabase();
  const updated = input.revision === 0
    ? await db.prepare(`INSERT INTO voice_learning_memories (user_key, revision, enabled, notes, recent_topics, updated_at) VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(user_key) DO NOTHING RETURNING revision`).bind(userKey, input.enabled ? 1 : 0, JSON.stringify(input.notes), JSON.stringify(input.recentTopics), now).first<{ revision: number }>()
    : await db.prepare(`UPDATE voice_learning_memories SET revision = revision + 1, enabled = ?, notes = ?, recent_topics = ?, updated_at = ? WHERE user_key = ? AND revision = ? RETURNING revision`).bind(input.enabled ? 1 : 0, JSON.stringify(input.notes), JSON.stringify(input.recentTopics), now, userKey, input.revision).first<{ revision: number }>();
  if (!updated) throw new AssistantInputError("voice_memory_conflict", "学习记忆已在别处更新。请重新载入后再保存，当前修改尚未覆盖云端。", 409);
  return { ...input, revision: updated.revision };
}
