import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { benchmarkBaseline } from './benchmark-baseline.mjs';
import * as after from '../lib/learning-journal/store.ts';
import { sqliteD1 } from '../tests/sqlite-d1.mjs';
import { env } from '../tests/worker-env.mjs';

// Read-only comparison on deterministic synthetic data using the actual migrated schema.
const baseline = benchmarkBaseline('journal');
const source = await baseline.source('lib/learning-journal/store.ts');
const js = ts.transpileModule(source.replace('from "./input"', 'from "@/lib/learning-journal/input"'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const before = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const db = new DatabaseSync(':memory:');
for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
  db.exec(readFileSync('drizzle/' + file, 'utf8'));
}
const day = db.prepare('INSERT INTO learning_journal_days (user_key,date,facts_summary,edited_summary,updated_at) VALUES (?,?,?,?,?)');
const event = db.prepare(`INSERT INTO learning_journal_events
  (user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash,deleted)
  VALUES (?,?,?,'UTC',?,'study','单词练习',?,?,'{"reviewed":3}',?,?)`);
const days = 36;
const perDay = 80;
const accounts = ['first', 'second'];
db.exec('BEGIN');
for (const user of accounts) {
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    day.run(user, date, '记录了学习活动', i % 7 === 0 ? '订正摘要' : null, date + 'T11:00:00Z');
    for (let j = 0; j < perDay; j++) {
      const id = date + ':' + j;
      const time = date + 'T10:' + String(Math.floor(j / 2)).padStart(2, '0') + ':00Z';
      event.run(user, id, date, time, user + '·回顾本单元词汇。'.repeat(6),
        JSON.stringify([user + '-unit-' + i, 'word-' + j]), 'a'.repeat(64), j % 11 === 0 ? 1 : 0);
    }
  }
}
db.exec('COMMIT');
const d1 = sqliteD1(db);
env.DB = d1;

// Count binding calls and serialized row bytes separately from timing to avoid measurement overhead.
function measuredBinding() {
  let calls = 0, statements = 0, rowBytes = 0;
  function countRows(result) { rowBytes += Buffer.byteLength(JSON.stringify(result.results)); }
  const binding = {
    prepare(sql) {
      return { bind(...args) {
        const bound = d1.prepare(sql).bind(...args);
        return { bound, async all() {
          calls++; statements++;
          const result = await bound.all();
          countRows(result);
          return result;
        } };
      } };
    },
    async batch(batch) {
      calls++; statements += batch.length;
      const results = await d1.batch(batch.map(statement => statement.bound));
      results.forEach(countRows);
      return results;
    },
  };
  return { binding, counts: () => ({ bindingCalls: calls, sqlStatements: statements, serializedRowBytes: rowBytes }) };
}

const runs = 40;
const report = {};
for (const name of ['journalDays', 'journalContext']) {
  const versions = { before, after };
  const metrics = {}, samples = { before: [], after: [] };
  const expected = await before[name]('first');
  for (const [label, module] of Object.entries(versions)) {
    const measured = measuredBinding();
    env.DB = measured.binding;
    try { assert.deepEqual(await module[name]('first'), expected); }
    finally { env.DB = d1; }
    metrics[label] = measured.counts();
    for (let i = 0; i < 5; i++) await module[name]('first');
  }
  for (let i = 0; i < runs; i++) {
    for (const label of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now();
      await versions[label][name]('first');
      samples[label].push(performance.now() - start);
    }
  }
  for (const label of Object.keys(versions)) {
    const ms = samples[label].sort((a,b) => a-b);
    metrics[label].medianMs = Number(((ms[runs / 2 - 1] + ms[runs / 2]) / 2).toFixed(3));
    metrics[label].p95Ms = Number(ms[Math.ceil(0.95 * runs) - 1].toFixed(3));
  }
  report[name] = { equal: true, ...metrics };
}
console.log(JSON.stringify({ baseline: baseline.revision, node: process.version,
  sqlite: db.prepare('SELECT sqlite_version() AS v').get().v, accounts: accounts.length, daysPerAccount: days,
  eventsPerDay: perDay, totalEvents: accounts.length * days * perDay, warmupsPerVersion: 5, samplesPerVersion: runs,
  setup: 'In-memory SQLite D1 adapter, alternating implementation order, no network latency, nearest-rank P95', report }, null, 2));
db.close();
