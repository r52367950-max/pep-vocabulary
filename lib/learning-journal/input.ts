import { AssistantInputError } from "@/lib/assistant/core";
import { JOURNAL_KINDS, type JournalEvent } from "./types";
export function invalid(message: string): never { throw new AssistantInputError("invalid_request", message); }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("学习记录格式无效。"); return value as Record<string, unknown>; }
export function text(value: unknown, max: number, empty = false) { if (typeof value !== "string" || value.length > max) return invalid("学习记录文字长度无效。"); const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim(); if (!empty && !clean) return invalid("学习记录不能为空。"); return clean; }
export function timezone(value: unknown) { const zone = text(value, 80); try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(); } catch { return invalid("请选择有效的 IANA 时区。"); } return zone; }
export function dateInZone(at: string, zone: string) { const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at)); const get = (type: string) => parts.find(p => p.type === type)!.value; return `${get("year")}-${get("month")}-${get("day")}`; }
export function dateKey(value: unknown) { const date = text(value, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return invalid("学习日期无效。"); return date; }
export function eventInput(raw: Record<string, unknown>): JournalEvent {
  const eventId = text(raw.eventId, 128); if (!/^[A-Za-z0-9_.:-]+$/.test(eventId)) return invalid("学习事件标识无效。");
  if (!JOURNAL_KINDS.includes(raw.kind as JournalEvent["kind"])) return invalid("学习活动类型无效。");
  const zone = timezone(raw.timezone), at = text(raw.occurredAt, 35), millis = Date.parse(at);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(millis) || millis > Date.now() + 300_000 || millis < Date.now() - 366 * 86_400_000) return invalid("学习活动时间超出可记录范围。");
  const occurredAt = new Date(millis).toISOString();
  if (!Array.isArray(raw.refIds) || raw.refIds.length > 30) return invalid("学习来源最多 30 项。");
  const refIds = [...new Set(raw.refIds.map(id => text(id, 160)))];
  const countsRaw = object(raw.counts), counts: Record<string, number> = {};
  if (Object.keys(countsRaw).length > 12) return invalid("学习统计过多。");
  for (const [key, value] of Object.entries(countsRaw)) { if (!/^[a-z][a-zA-Z0-9]{0,30}$/.test(key) || !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100000) return invalid("学习统计无效。"); counts[key] = Number(value); }
  return { eventId, kind: raw.kind as JournalEvent["kind"], title: text(raw.title, 160), summary: text(raw.summary, 600, true), refIds, counts, occurredAt, timezone: zone, date: dateInZone(occurredAt, zone), source: "learning_activity" };
}
