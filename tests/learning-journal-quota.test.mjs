import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { GET, POST, PUT, DELETE } from '../app/api/learning-journal/route.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
const CAPACITY = 64 * 1024 * 1024;
const migrations = readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort();
const quotaMigration = '0009_learning_journal_quota.sql';
function setup({ beforeQuota = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of migrations) if (!beforeQuota || file !== quotaMigration) db.exec(readFileSync(`drizzle/${file}`, 'utf8'));
  env.DB = sqliteD1(db);
  requestHeaders.set('oai-authenticated-user-email', 'journal-quota@example.test');
  return db;
}
const req = (method = 'GET', body) => new Request('https://app.test/api/learning-journal', { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const view = async () => (await GET(req())).json();
const event = (meta, eventId = 'quota:control') => ({ accountScope: meta.accountScope, privacyRevision: meta.privacyRevision, eventId, kind: 'study', title: '正常学习 📖', summary: '复习词汇。', refIds: ['word:one'], counts: { reviewed: 1 }, occurredAt: new Date(Date.now() - 1000).toISOString(), timezone: 'UTC' });
async function ok(response) { assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
function usage(db) { return { ...db.prepare('SELECT event_count,storage_bytes FROM learning_journal_settings').get() }; }
function storedBytes(db) {
  let total = 0;
  const fields = { events: ['user_key', 'event_id', 'date', 'timezone', 'occurred_at', 'kind', 'title', 'summary', 'ref_ids', 'counts', 'content_hash'], days: ['user_key', 'date', 'facts_summary', 'edited_summary', 'updated_at'] };
  for (const [table, columns] of Object.entries(fields)) for (const row of db.prepare(`SELECT * FROM learning_journal_${table}`).all()) total += 128 + (table === 'days' ? 24 : 0) + columns.reduce((n, key) => n + Buffer.byteLength(row[key] ?? ''), 0);
  return total;
}
async function quota(response) { assert.equal(response.status, 409, await response.clone().text()); assert.equal((await response.json()).error.code, 'journal_capacity_exceeded'); }

test('journal quota migration accounts for existing live and deleted Unicode text without changing privacy', async () => {
  const db = setup({ beforeQuota: true }), key = await authenticatedUserKey(), at = new Date().toISOString(), date = at.slice(0, 10);
  db.prepare('INSERT INTO learning_journal_settings (user_key,revision,privacy_revision) VALUES (?,7,3)').run(key);
  const insert = db.prepare("INSERT INTO learning_journal_events (user_key,event_id,date,timezone,occurred_at,kind,title,summary,content_hash,deleted) VALUES (?,?,?,'UTC',?,'study',?,?,?,?)");
  insert.run(key, 'legacy:live', date, at, '旧记录 📖', '保留原文。', 'hash', 0);
  insert.run(key, 'legacy:deleted', date, at, '', '', '', 1);
  db.prepare("INSERT INTO learning_journal_days (user_key,date,facts_summary,edited_summary,deleted_before,updated_at) VALUES (?,?,'旧活动','用户订正 📚',?,?)").run(key, date, at, at);
  const before = await view();
  const bytes = storedBytes(db);
  db.exec(readFileSync(`drizzle/${quotaMigration}`, 'utf8'));
  assert.deepEqual(usage(db), { event_count: 2, storage_bytes: bytes });
  assert.deepEqual(await view(), before);
});

test('deleting a missing or hidden date allocates no day row or journal revision', async () => {
  const db = setup(), initial = await view();
  assert.equal((await DELETE(req('DELETE', { accountScope: initial.accountScope, revision: 0, date: '1000-01-01' }))).status, 404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM learning_journal_days').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM learning_journal_settings').get().n, 0);
  const saved = await ok(await POST(req('POST', event(initial))));
  const removed = await ok(await DELETE(req('DELETE', { accountScope: saved.accountScope, revision: saved.revision, date: saved.days[0].date })));
  const before = usage(db);
  assert.equal((await DELETE(req('DELETE', { accountScope: removed.accountScope, revision: removed.revision, date: saved.days[0].date }))).status, 404);
  assert.deepEqual(usage(db), before);
  assert.deepEqual(await view(), removed);
});

test('retained account IDs enforce the atomic row allowance across deletion cycles and concurrent appends', async () => {
  const db = setup(), initial = await view(), control = event(initial);
  const saved = await ok(await POST(req('POST', control)));
  const key = db.prepare('SELECT user_key FROM learning_journal_settings').get().user_key;
  db.prepare(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<99998)
    INSERT INTO learning_journal_events (user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash,deleted)
    SELECT ?,'deleted:'||n,'2000-01-01','UTC','2000-01-01T00:00:00.000Z','study','','','[]','{}','',1 FROM ids`).run(key);
  assert.equal(usage(db).event_count, 99999);
  const inputs = [event(saved, 'quota:concurrent-a'), event(saved, 'quota:concurrent-b')];
  const responses = await Promise.all(inputs.map(body => POST(req('POST', body))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  await quota(responses.find(r => r.status === 409));
  assert.equal(usage(db).event_count, 100000);
  assert.equal(usage(db).storage_bytes, storedBytes(db));
  assert.equal((await ok(await POST(req('POST', control)))).duplicate, true);
  const current = await view();
  const removed = await ok(await DELETE(req('DELETE', { accountScope: current.accountScope, revision: current.revision, eventId: control.eventId })));
  assert.equal(usage(db).event_count, 100000, 'deletion retains the event-ID allowance');
  db.prepare("UPDATE learning_journal_days SET updated_at='2026-01-01T00:00:00.000Z' WHERE date=?").run(removed.days[0].date);
  const beforeRejectedWrite = await view();
  const before = usage(db);
  await quota(await POST(req('POST', event(removed, 'quota:after-delete'))));
  assert.deepEqual(usage(db), before);
  assert.deepEqual(await view(), beforeRejectedWrite, 'capacity rejection must roll back day content and timestamps too');
  assert.equal((await ok(await POST(req('POST', { ...control, privacyRevision: removed.privacyRevision })))).ignored, 'deleted');
  requestHeaders.set('oai-authenticated-user-email', 'other-journal-quota@example.test');
  assert.equal((await ok(await POST(req('POST', event(await view(), 'quota:other-account'))))).accepted, true);
});

test('journal usage follows UTF-8 edits, day summaries and cleared content while retaining IDs', async () => {
  const db = setup(), initial = await view();
  const saved = await ok(await POST(req('POST', event(initial))));
  assert.deepEqual(usage(db), { event_count: 1, storage_bytes: storedBytes(db) });
  const edited = await ok(await PUT(req('PUT', { accountScope: saved.accountScope, revision: saved.revision, eventId: 'quota:control', title: '复习 🐈', summary: '三项学习活动与订正。' })));
  assert.equal(usage(db).storage_bytes, storedBytes(db));
  const day = await ok(await PUT(req('PUT', { accountScope: edited.accountScope, revision: edited.revision, date: edited.days[0].date, summary: '我今天完成了词汇学习。📚' })));
  assert.equal(usage(db).storage_bytes, storedBytes(db));
  const before = usage(db).storage_bytes;
  await ok(await DELETE(req('DELETE', { accountScope: day.accountScope, revision: day.revision, date: day.days[0].date })));
  assert.equal(usage(db).event_count, 1);
  assert.ok(usage(db).storage_bytes < before);
  assert.equal(usage(db).storage_bytes, storedBytes(db));
});

test('byte quota rejects event and day growth with full rollback and still permits privacy deletion', async () => {
  const db = setup(), initial = await view();
  const saved = await ok(await POST(req('POST', event(initial))));
  const snapshot = await view();
  // Reserve the rest of the account budget to exercise the exact capacity boundary.
  db.prepare('UPDATE learning_journal_settings SET storage_bytes=?').run(CAPACITY - 1);
  const before = usage(db);
  await quota(await POST(req('POST', event(saved, 'quota:no-space'))));
  assert.deepEqual(await view(), snapshot);
  assert.deepEqual(usage(db), before);
  await quota(await PUT(req('PUT', { accountScope: saved.accountScope, revision: saved.revision, eventId: 'quota:control', title: '更长的学习标题', summary: '字'.repeat(600) })));
  assert.deepEqual(await view(), snapshot);
  assert.deepEqual(usage(db), before);
  await quota(await PUT(req('PUT', { accountScope: saved.accountScope, revision: saved.revision, date: saved.days[0].date, summary: '字'.repeat(1200) })));
  assert.deepEqual(await view(), snapshot);
  assert.deepEqual(usage(db), before);
  // Old accounts may start above the cap; deletions must still erase private text.
  db.prepare('UPDATE learning_journal_settings SET storage_bytes=?').run(CAPACITY + 1);
  const removed = await ok(await DELETE(req('DELETE', { accountScope: saved.accountScope, revision: saved.revision, date: saved.days[0].date })));
  assert.deepEqual(removed.days, []);
  assert.ok(usage(db).storage_bytes < CAPACITY);
  assert.equal(usage(db).event_count, 1);
});

test('oversized legacy accounts can delete an empty edited day after all its events were removed', async () => {
  const db = setup(), initial = await view();
  const saved = await ok(await POST(req('POST', event(initial))));
  const day = await ok(await PUT(req('PUT', { accountScope: saved.accountScope, revision: saved.revision, date: saved.days[0].date, summary: '' })));
  const removed = await ok(await DELETE(req('DELETE', { accountScope: day.accountScope, revision: day.revision, eventId: 'quota:control' })));
  // A legacy empty edited summary remains visible even when no live event remains.
  db.prepare("UPDATE learning_journal_days SET edited_summary='' WHERE date=?").run(saved.days[0].date);
  db.prepare('UPDATE learning_journal_settings SET storage_bytes=?').run(CAPACITY + 1);
  const before = usage(db);
  const result = await ok(await DELETE(req('DELETE', { accountScope: removed.accountScope, revision: removed.revision, date: saved.days[0].date })));
  assert.deepEqual(result.days, []);
  assert.deepEqual(usage(db), before, 'the day marker has reserved storage even before deletion');
});

test('privacy deletion at capacity keeps remaining events when the next summary item is longer', async () => {
  const db = setup(), initial = await view();
  const oldest = { ...event(initial, 'quota:oldest-long'), title: '长'.repeat(160), summary: '长'.repeat(600), occurredAt: new Date(Date.now() - 10_000).toISOString() };
  await ok(await POST(req('POST', oldest)));
  for (let i = 0; i < 6; i++) await ok(await POST(req('POST', { ...event(initial, `quota:short-${i}`), title: '短', summary: '', refIds: [], counts: {} })));
  const current = await view();
  assert.doesNotMatch(current.days[0].factsSummary, /长/);
  db.prepare('UPDATE learning_journal_settings SET storage_bytes=?').run(CAPACITY);
  const result = await ok(await DELETE(req('DELETE', { accountScope: current.accountScope, revision: current.revision, eventId: 'quota:short-0' })));
  assert.equal(result.days[0].eventCount, 6);
  assert.equal(result.days[0].factsSummary, '记录了 6 项学习活动。');
  assert.equal(result.days[0].events.find(row => row.eventId === oldest.eventId).summary, oldest.summary);
  assert.ok(usage(db).storage_bytes <= CAPACITY);
});
