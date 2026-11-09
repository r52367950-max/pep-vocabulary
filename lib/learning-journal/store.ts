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
type EventRow = { event_id: string; date: string; timezone: string; occurred_at: string; kind: JournalEvent["kind"]; title: string; summary: string; ref_ids: string; counts: string; content_hash: string; deleted: number; edited: number };
function fromRow(row: EventRow): JournalEvent { return { eventId: row.event_id, date: row.date, timezone: row.timezone, occurredAt: row.occurred_at, kind: row.kind, title: row.title, summary: row.summary, refIds: JSON.parse(row.ref_ids), counts: JSON.parse(row.counts), source: "learning_activity", edited: row.edited === 1 }; }
export async function journalDays(key: string, limit = 30): Promise<JournalDay[]> {
  const db = memoryDatabase();
  const rows = await db.prepare(`SELECT d.*, (SELECT count(*) FROM learning_journal_events e WHERE e.user_key=d.user_key AND e.date=d.date AND e.deleted=0) AS event_count FROM learning_journal_days d WHERE user_key=? AND (facts_summary<>'' OR edited_summary IS NOT NULL) ORDER BY date DESC LIMIT ?`).bind(key, limit).all<{ date: string; facts_summary: string; edited_summary: string | null; updated_at: string; event_count: number }>();
  return Promise.all(rows.results.map(async row => {
    const events = await db.prepare("SELECT * FROM learning_journal_events WHERE user_key=? AND date=? AND deleted=0 ORDER BY occurred_at DESC,event_id DESC LIMIT 20").bind(key, row.date).all<EventRow>();
    return { date: row.date, summary: row.edited_summary ?? row.facts_summary, factsSummary: row.facts_summary, summarySource: row.edited_summary === null ? "facts" : "edited", updatedAt: row.updated_at, eventCount: row.event_count, events: events.results.map(fromRow), eventsTruncated: row.event_count > events.results.length };
  }));
}
function ensureSettings(key: string) { return memoryDatabase().prepare("INSERT INTO learning_journal_settings (user_key) VALUES (?) ON CONFLICT(user_key) DO NOTHING").bind(key); }
function refreshDay(key: string, date: string, token: string | null = null, deleting = false) {
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
    WHERE user_key=? AND date=? AND (? IS NULL OR EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=? AND write_token=?))`).bind(key,date,key,date,deleting?1:0,key,new Date().toISOString(),key,date,token,key,token);
}
async function hash(value: unknown) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value))); return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function policyConflict(): never { throw new AssistantInputError("journal_policy_changed", "自动记录设置已变化，请重新读取。", 409); }
function capacityExceeded(): never { throw new AssistantInputError("journal_capacity_exceeded", "学习日志已达到账号保存上限，本次云端记录未保存。仍可删除已有内容，本机学习不受影响。", 409); }
async function journalBatch(statements: D1PreparedStatement[]) {
  try { return await memoryDatabase().batch(statements); }
  catch (error) { if (error instanceof Error && error.message.includes("journal_capacity_exceeded")) return capacityExceeded(); throw error; }
}
export async function appendJournalEvent(key: string, body: Record<string, unknown>) {
  const event = eventInput(body), digest = await hash(event), db = memoryDatabase();
  const meta = await journalMetadata(key);
  if (!Number.isSafeInteger(body.privacyRevision) || body.privacyRevision !== meta.privacyRevision) return policyConflict();
  if (!meta.enabled) return { accepted: false, ignored: "disabled" };
  const existing = await db.prepare("SELECT content_hash,deleted FROM learning_journal_events WHERE user_key=? AND event_id=?").bind(key,event.eventId).first<{content_hash:string;deleted:number}>();
  if (existing) { if (existing.deleted) return { accepted:false,ignored:"deleted" }; if (existing.content_hash!==digest) throw new AssistantInputError("journal_event_conflict","同一学习事件不能重复提交不同内容。",409); return {accepted:false,duplicate:true}; }
  const results = await journalBatch([
    ensureSettings(key),
    db.prepare(`INSERT INTO learning_journal_events (user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM learning_journal_settings WHERE user_key=? AND enabled=1 AND privacy_revision=? AND suppressed_before<?)
      AND NOT EXISTS (SELECT 1 FROM learning_journal_days WHERE user_key=? AND date=? AND deleted_before>=?)
      AND (SELECT count(*) FROM learning_journal_events WHERE user_key=? AND date=? AND deleted=0)<2000
      ON CONFLICT(user_key,event_id) DO NOTHING RETURNING event_id`).bind(key,event.eventId,event.date,event.timezone,event.occurredAt,event.kind,event.title,event.summary,JSON.stringify(event.refIds),JSON.stringify(event.counts),digest,key,meta.privacyRevision,event.occurredAt,key,event.date,event.occurredAt,key,event.date),
    db.prepare("UPDATE learning_journal_settings SET revision=revision+1 WHERE user_key=? AND changes()>0").bind(key),
    db.prepare(`INSERT INTO learning_journal_days (user_key,date,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM learning_journal_events WHERE user_key=? AND event_id=? AND deleted=0) ON CONFLICT(user_key,date) DO NOTHING`).bind(key,event.date,new Date().toISOString(),key,event.eventId),
    refreshDay(key,event.date),
  ]);
  if ((results[1].results ?? []).length) return {accepted:true};
  const after = await journalMetadata(key);
  if (after.privacyRevision!==meta.privacyRevision) return policyConflict();
  const row = await db.prepare("SELECT content_hash,deleted FROM learning_journal_events WHERE user_key=? AND event_id=?").bind(key,event.eventId).first<{content_hash:string;deleted:number}>();
  if (row && !row.deleted && row.content_hash!==digest) throw new AssistantInputError("journal_event_conflict","同一学习事件不能重复提交不同内容。",409);
  return {accepted:false,...(row && !row.deleted ? {duplicate:true} : {ignored:"excluded"})};
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
  const guard="EXISTS(SELECT 1 FROM learning_journal_settings WHERE user_key=? AND write_token=?)";
  const statements=[ensureSettings(key),db.prepare(`UPDATE learning_journal_settings SET revision=revision+1, privacy_revision=privacy_revision+1, write_token=?${setting?",enabled=?,suppressed_before=?":""} WHERE user_key=? AND revision=? RETURNING revision`).bind(token,...(setting?[body.enabled?1:0,now]:[]),key,body.revision)];
  if (setting) { /* Disabling and re-enabling fence queued events from the previous policy. */ }
  else if(method==="DELETE") {
    statements.push(db.prepare(`UPDATE learning_journal_events SET deleted=1,title='',summary='',ref_ids='[]',counts='{}',content_hash='' WHERE user_key=? AND ${eventId?"event_id=?":"date=?"} AND ${guard}`).bind(key,eventId??day,key,token));
    if(date) statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL,deleted_before=?,facts_summary='',updated_at=? WHERE user_key=? AND date=? AND ${guard}`).bind(now,now,key,date,key,token));
    else statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL WHERE user_key=? AND date=? AND ${guard}`).bind(key,day,key,token));
  } else if(eventId) {
    statements.push(db.prepare(`UPDATE learning_journal_events SET title=?,summary=?,edited=1 WHERE user_key=? AND event_id=? AND deleted=0 AND ${guard}`).bind(title,summary,key,eventId,key,token));
    statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=NULL WHERE user_key=? AND date=? AND ${guard}`).bind(key,day,key,token));
  } else {
    statements.push(db.prepare(`UPDATE learning_journal_days SET edited_summary=?,updated_at=? WHERE user_key=? AND date=? AND ${guard}`).bind(summary,now,key,day,key,token));
  }
  if(day) statements.push(refreshDay(key,day,token,method==="DELETE"));
  const results=await journalBatch(statements);
  if(!(results[1].results??[]).length) throw new AssistantInputError("journal_conflict","学习记录已在别处更新，请重新读取。",409);
}
export async function journalContext(key:string) {
  const days=await journalDays(key,7);
  return Promise.all(days.map(async day=>{
    // Read across the whole day, not only the UI's newest 20 events. Deleted
    // activity has no references and never contributes to this bounded index.
    const refs=await memoryDatabase().prepare(`SELECT refs.value AS ref_id FROM learning_journal_events e, json_each(e.ref_ids) refs WHERE e.user_key=? AND e.date=? AND e.deleted=0 GROUP BY refs.value ORDER BY MAX(e.occurred_at) DESC,refs.value LIMIT 30`).bind(key,day.date).all<{ref_id:string}>();
    return {date:day.date,summary:day.summary.slice(0,1200),source:day.summarySource==="edited"?"user_edited_daily_summary":"recorded_learning_activities",eventCount:day.eventCount,sourceEventIds:day.events.slice(0,8).map(e=>e.eventId),refIds:refs.results.map(ref=>ref.ref_id)};
  }));
}
