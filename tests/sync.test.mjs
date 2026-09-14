import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { GET, POST } from '../app/api/sync/route.ts';
import { POST as saveConfig, DELETE as deleteConfig } from '../app/api/ai/config/route.ts';

const database = new DatabaseSync(':memory:');
database.exec(readFileSync(new URL('../drizzle/0000_curvy_newton_destine.sql', import.meta.url), 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async raw() { const stmt = database.prepare(this.sql); stmt.setReturnArrays(true); return stmt.all(...this.args); }
  async all() { return { results: database.prepare(this.sql).all(...this.args) }; }
  async run() { return database.prepare(this.sql).run(...this.args); }
}
const binding = { prepare: sql => new Statement(sql) };
env.DB = binding;
requestHeaders.set('oai-authenticated-user-email', 'test@example.com');
const backup = { schemaVersion: '1.1.0', cards: [], events: [], lists: [], settings: [] };
const payload = (revision = 0) => ({ schemaVersion: '1.1.0', baseRevision: revision, clientUpdatedAt: '2026-09-14T00:00:00Z', payload: backup });
const req = body => new Request('https://app.test/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('first upload race accepts exactly one writer and returns non-cacheable responses', async () => {
  const replies = await Promise.all([POST(req(payload())), POST(req(payload()))]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.ok(replies.every(r => r.headers.get('cache-control').includes('no-store')));
  const result = await (await GET()).json();
  assert.equal(result.state.revision, 1);
});
test('concurrent updates compare revisions in SQL and reject missing/stale revisions', async () => {
  const replies = await Promise.all([POST(req(payload(1))), POST(req(payload(1)))]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await GET()).json()).state.revision, 2);
  assert.equal((await POST(req(payload(1)))).status, 409);
  assert.equal((await POST(req({ ...payload(), baseRevision: undefined }))).status, 400);
  assert.equal((await POST(req(null))).status, 400);
  assert.equal((await POST(req({ ...payload(2), payload: { ...backup, cards: [null] } }))).status, 400);
});
test('sync is partitioned by authenticated identity', async () => {
  requestHeaders.set('oai-authenticated-user-email', 'another@example.com');
  assert.equal((await (await GET()).json()).state, null);
  assert.equal((await POST(req(payload(2)))).status, 409);
  requestHeaders.delete('oai-authenticated-user-email');
  assert.equal((await GET()).status, 401);
  assert.equal((await POST(req(payload()))).status, 401);
  requestHeaders.set('oai-authenticated-user-email', 'test@example.com');
});
test('sync rejects cross-origin requests and hides storage internals', async () => {
  const request = req(payload(2));
  request.headers.set('origin', 'https://evil.test');
  assert.equal((await POST(request)).status, 403);
  delete env.DB;
  try {
    const response = await POST(req(payload(2)));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Cloudflare|binding|SELECT|user_key/i);
  } finally { env.DB = binding; }
});
test('configuration rejects null/oversized chunked bodies and catches unavailable D1', async () => {
  const configReq = body => new Request('https://app.test/api/ai/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
  assert.equal((await saveConfig(configReq(null))).status, 400);
  assert.equal((await saveConfig(configReq({ text: '中'.repeat(2000) }))).status, 413);
  delete env.DB;
  try {
    const response = await saveConfig(configReq({ provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', dailyLimit: 30, timeoutSeconds: 25 }));
    assert.equal(response.status, 503);
    assert.equal((await deleteConfig(configReq({}))).status, 503);
  } finally { env.DB = binding; }
});
