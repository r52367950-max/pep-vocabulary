import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { memoryDatabase } from "@/lib/learning-memory/store";
import { AssistantInputError } from "@/lib/assistant/core";
import { stableJson } from "@/lib/stable-json";
import { dateKey, eventInput, invalid, text } from "./input";
import type { JournalDay, JournalEvent } from "./types";

type Settings = { enabled: number; revision: number; privacy_revision: number; suppressed_before: string };
export async function journalMetadata(key: string) {
  const row = await memoryDatabase().prepare("SELECT enabled,revision,privacy_revision,suppressed_before FROM learning_journal_settings WHERE user_key=?").bind(key).first<Settings>();
  return { enabled: row ? row.enabled === 1 : true, revision: row?.revision ?? 0, privacyRevision: row?.privacy_revision ?? 0 };
}
type DayRow = {
  date: string;
  facts_summary: string;
  edited_summary: string | null;
  updated_at: string;
  event_count: number;
};
type EventRow = {
  event_id: string;
  date: string;
  timezone: string;
  occurred_at: string;
  kind: JournalEvent["kind"];
  title: string;
  summary: string;
  ref_ids: string;
  counts: string;
  edited: number;
};

const visibleDays = `SELECT user_key, date, facts_summary, edited_summary, updated_at
  FROM learning_journal_days WHERE user_key=? AND (facts_summary<>'' OR edited_summary IS NOT NULL)
  ORDER BY date DESC LIMIT ?`;
const visibleEvents = "e.user_key=d.user_key AND e.date=d.date AND e.deleted=0";
const eventCount = `(SELECT count(*) FROM learning_journal_events e WHERE ${visibleEvents})`;
const newestFirst = "ORDER BY occurred_at DESC, event_id DESC";

function fromRow(row: EventRow): JournalEvent {
  return {
    eventId: row.event_id, date: row.date, timezone: row.timezone, occurredAt: row.occurred_at,
    kind: row.kind, title: row.title, summary: row.summary, refIds: JSON.parse(row.ref_ids),
    counts: JSON.parse(row.counts), source: "learning_activity", edited: row.edited === 1,
  };
}

export async function journalDays(key: string, limit = 30): Promise<JournalDay[]> {
  const db = memoryDatabase();
  // Both bounded reads share a D1 transaction, so counts and previews agree even during edits.
  const [days, previews] = await db.batch([
    db.prepare(`SELECT d.date, facts_summary, edited_summary, updated_at, ${eventCount} AS event_count
      FROM (${visibleDays}) d ORDER BY d.date DESC`).bind(key, limit),
    db.prepare(`SELECT p.event_id,p.date,p.timezone,p.occurred_at,p.kind,p.title,p.summary,p.ref_ids,p.counts,p.edited
      FROM (${visibleDays}) d CROSS JOIN learning_journal_events p
      WHERE p.rowid IN (SELECT e.rowid FROM learning_journal_events e WHERE ${visibleEvents} ${newestFirst} LIMIT 20)
      ORDER BY d.date DESC,p.occurred_at DESC,p.event_id DESC`).bind(key, limit),
  ]);
  const byDate = new Map<string, JournalEvent[]>();
  for (const row of previews.results as EventRow[]) {
    const events = byDate.get(row.date);
    if (events) events.push(fromRow(row));
    else byDate.set(row.date, [fromRow(row)]);
  }
  return (days.results as DayRow[]).map(day => {
    const events = byDate.get(day.date) ?? [];
    return {
      date: day.date, summary: day.edited_summary ?? day.facts_summary, factsSummary: day.facts_summary,
      summarySource: day.edited_summary === null ? "facts" : "edited", updatedAt: day.updated_at,
      eventCount: day.event_count, events, eventsTruncated: day.event_count > events.length,
    };
  });
}
function ensureSettings(key: string) { return memoryDatabase().prepare("INSERT INTO learning_journal_settings (user_key) VALUES (?) ON CONFLICT(user_key) DO NOTHING").bind(key); }
const writeGuard = "EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=? AND write_token=?)";
function refreshDay(key: string, date: string, token: string, deleting = false) {
  // Removing a short event can expose a longer seventh summary item. Keep
  // privacy deletion available at capacity without dropping remaining events.
  return memoryDatabase().prepare(`WITH day_content AS (
    SELECT count(*) AS total, COALESCE((SELECT group_concat(title,'；') FROM (SELECT title || CASE WHEN summary<>'' THEN '：' || substr(summary,1,120) ELSE '' END AS title FROM learning_journal_events WHERE user_key=? AND date=? AND deleted=0 ORDER BY occurred_at DESC,event_id DESC LIMIT 6)),'') AS details
    FROM learning_journal_events WHERE user_key=? AND date=? AND deleted=0
  ), next_summary AS (
    SELECT CASE WHEN total=0 THEN '' ELSE '记录了 ' || total || ' 项学习活动：' || details END AS full_summary,
      CASE WHEN total=0 THEN '' ELSE '记录了 ' || total || ' 项学习活动。' END AS compact_summary FROM day_content
  ) UPDATE learning_journal_days SET facts_summary=(SELECT CASE WHEN ? AND
      (SELECT storage_bytes FROM learning_journal_settings WHERE user_key=?)+length(CAST(full_summary AS BLOB))-length(CAST(facts_summary AS BLOB))>67108864
      THEN compact_summary ELSE full_summary END FROM next_summary), updated_at=?
    WHERE user_key=? AND date=? AND ${writeGuard}`).bind(key,date,key,date,deleting?1:0,key,new Date().toISOString(),key,date,key,token);
}
async function hash(value: unknown) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value))); return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function policyConflict(): never { throw new AssistantInputError("journal_policy_changed", "自动记录设置已变化，请重新读取。", 409); }
function capacityExceeded(): never { throw new AssistantInputError("journal_capacity_exceeded", "学习日志已达到账号保存上限，本次云端记录未保存。仍可删除已有内容，本机学习不受影响。", 409); }
async function journalBatch(statements: D1PreparedStatement[]) {
  try { return await memoryDatabase().batch(statements); }
  catch (error) { if (error instanceof Error && error.message.includes("journal_capacity_exceeded")) return capacityExceeded(); throw error; }
}
async function appendStatus(key: string, eventId: string, digest: string, privacyRevision: unknown) {
  const row = await memoryDatabase().prepare(`SELECT s.enabled,s.privacy_revision,e.content_hash,e.deleted
    FROM learning_journal_settings s LEFT JOIN learning_journal_events e ON e.user_key=s.user_key AND e.event_id=?
    WHERE s.user_key=?`).bind(eventId,key).first<{
      enabled: number; privacy_revision: number; content_hash: string | null; deleted: number | null;
    }>();
  if (privacyRevision !== (row?.privacy_revision ?? 0)) return policyConflict();
  if (row?.enabled === 0) return { accepted: false, ignored: "disabled" };
  if (row?.deleted) return { accepted: false, ignored: "deleted" };
  if (row?.content_hash == null) return null;
  if (row.content_hash !== digest) throw new AssistantInputError("journal_event_conflict", "同一学习事件不能重复提交不同内容。", 409);
  return { accepted: false, duplicate: true };
}

export async function appendJournalEvent(key: string, body: Record<string, unknown>) {
  const event = eventInput(body), digest = await hash(event), db = memoryDatabase();
  const privacyRevision = body.privacyRevision;
  const status = await appendStatus(key, event.eventId, digest, privacyRevision);
  if (status) return status;
  const token = crypto.randomUUID();
  const results = await journalBatch([
    ensureSettings(key),
    db.prepare(`INSERT INTO learning_journal_events (user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM learning_journal_settings WHERE user_key=? AND enabled=1 AND privacy_revision=? AND suppressed_before<?)
      AND NOT EXISTS (SELECT 1 FROM learning_journal_days WHERE user_key=? AND date=? AND deleted_before>=?)
      AND (SELECT count(*) FROM learning_journal_events WHERE user_key=? AND date=? AND deleted=0)<2000
      ON CONFLICT(user_key,event_id) DO NOTHING RETURNING event_id`).bind(key,event.eventId,event.date,event.timezone,event.occurredAt,event.kind,event.title,event.summary,JSON.stringify(event.refIds),JSON.stringify(event.counts),digest,key,privacyRevision,event.occurredAt,key,event.date,event.occurredAt,key,event.date),
    db.prepare("UPDATE learning_journal_settings SET revision=revision+1,write_token=? WHERE user_key=? AND changes()>0").bind(token,key),
    db.prepare(`INSERT INTO learning_journal_days (user_key,date,updated_at) SELECT ?,?,? WHERE ${writeGuard} ON CONFLICT(user_key,date) DO NOTHING`).bind(key,event.date,new Date().toISOString(),key,token),
    refreshDay(key,event.date,token),
  ]);
  if ((results[1].results ?? []).length) return {accepted:true};
  return await appendStatus(key, event.eventId, digest, privacyRevision) ?? { accepted: false, ignored: "excluded" };
}
export async function mutateJournal(key: string, body: Record<string, unknown>, method: "PUT"|"DELETE") {
  if (!Number.isSafeInteger(body.revision) || Number(body.revision)<0) return invalid("学习记录版本无效。");
  const db=memoryDatabase(), token=crypto.randomUUID(), now=new Date().toISOString();
  const eventId=body.eventId===undefined?null:text(body.eventId,128), date=body.date===undefined?null:dateKey(body.date);
  if (eventId && date) return invalid("请一次操作一条记录或一天。");
  const setting = method==="PUT" && body.enabled!==undefined;
  if (setting && (typeof body.enabled!=="boolean" || eventId || date)) return invalid("自动记录设置无效。");
  if (!setting && !eventId && !date) return invalid("请选择需要更改的学习记录。");
  const event = eventId ? await db.prepare("SELECT date,deleted FROM learning_journal_events WHERE user_key=? AND event_id=?").bind(key,eventId).first<{date:string;deleted:number}>():null;
  if (eventId && (!event || event.deleted)) throw new AssistantInputError("journal_not_found","学习记录已删除或不存在。",404);
  const day=date??event?.date??null;
  if(date) {
    const exists=await db.prepare("SELECT date FROM learning_journal_days WHERE user_key=? AND date=? AND (facts_summary<>'' OR edited_summary IS NOT NULL)").bind(key,date).first();
    if(!exists) throw new AssistantInputError("journal_not_found","当天没有学习记录。",404);
  }
  const summary=method==="PUT"&&!setting?text(body.summary,1200,true):null;
  const title=method==="PUT"&&eventId?text(body.title,160):null;
  const statements=[ensureSettings(key),db.prepare(`UPDATE learning_journal_settings SET revision=revision+1, privacy_revision=privacy_revision+1, write_token=?${setting?",enabled=?,suppressed_before=?":""} WHERE user_key=? AND revision=? RETURNING revision`).bind(token,...(setting?[body.enabled?1:0,now]:[]),key,body.revision)];
  if (setting) { /* Disabling and re-enabling fence queued events from the previous policy. */ }
  else if(method==="DELETE") {
    statements.push(db.prepare(`UPDATE learning_journal_events SET deleted=1,title='',summary='',ref_ids='[]',counts='{}',content_hash='' WHERE user_key=? AND ${eventId?"event_id=?":"date=?"} AND ${writeGuard}`).bind(key,eventId??day,key,token));
    if(date) statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL,deleted_before=?,facts_summary='',updated_at=? WHERE user_key=? AND date=? AND ${writeGuard}`).bind(now,now,key,date,key,token));
    else statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL WHERE user_key=? AND date=? AND ${writeGuard}`).bind(key,day,key,token));
  } else if(eventId) {
    statements.push(db.prepare(`UPDATE learning_journal_events SET title=?,summary=?,edited=1 WHERE user_key=? AND event_id=? AND deleted=0 AND ${writeGuard}`).bind(title,summary,key,eventId,key,token));
    statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL WHERE user_key=? AND date=? AND ${writeGuard}`).bind(key,day,key,token));
  } else {
    statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=?,updated_at=? WHERE user_key=? AND date=? AND ${writeGuard}`).bind(summary,now,key,day,key,token));
  }
  if(day) statements.push(refreshDay(key,day,token,method==="DELETE"));
  const results=await journalBatch(statements);
  if(!(results[1].results??[]).length) throw new AssistantInputError("journal_conflict","学习记录已在别处更新，请重新读取。",409);
}
export async function journalContext(key: string) {
  // Source IDs come from the newest eight events; references can come from any visible event that day.
  const rows = await memoryDatabase().prepare(`SELECT d.date,d.edited_summary,d.facts_summary,${eventCount} AS event_count,
    (SELECT json_group_array(event_id) FROM (SELECT e.event_id FROM learning_journal_events e
      WHERE ${visibleEvents} ${newestFirst} LIMIT 8)) AS event_ids,
    (SELECT json_group_array(ref_id) FROM (SELECT refs.value AS ref_id
      FROM learning_journal_events e,json_each(e.ref_ids) refs WHERE ${visibleEvents}
      GROUP BY refs.value ORDER BY MAX(e.occurred_at) DESC,refs.value LIMIT 30)) AS ref_ids
    FROM (${visibleDays}) d ORDER BY d.date DESC`).bind(key, 7).all<{
      date: string; edited_summary: string | null; facts_summary: string; event_count: number;
      event_ids: string; ref_ids: string;
    }>();
  return rows.results.map(day => ({
    date: day.date, summary: (day.edited_summary ?? day.facts_summary).slice(0, 1200),
    source: day.edited_summary === null ? "recorded_learning_activities" : "user_edited_daily_summary",
    eventCount: day.event_count, sourceEventIds: JSON.parse(day.event_ids) as string[], refIds: JSON.parse(day.ref_ids) as string[],
  }));
}
