import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { GET, POST } from '../app/api/sync/route.ts';
import { validateBackup } from '../lib/backup.ts';
import { assertSyncPayloadFits, MAX_SYNC_PAYLOAD_BYTES, MAX_SYNC_REQUEST_BYTES, SYNC_TOO_LARGE_MESSAGE } from '../lib/sync-limits.ts';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  // Node's SQLite accepts larger values than production D1. Emulate D1's
  // documented whole-row boundary, including metadata and record overhead.
  const rowBytes = 'length(CAST(NEW.payload AS BLOB)) + length(CAST(NEW.user_key AS BLOB)) + length(CAST(NEW.schema_version AS BLOB)) + length(CAST(NEW.client_updated_at AS BLOB)) + length(CAST(NEW.server_updated_at AS BLOB)) + 64';
  for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER d1_limit_${operation} BEFORE ${operation} ON sync_states WHEN ${rowBytes} > 2000000 BEGIN SELECT RAISE(ABORT, 'string or blob too big'); END;`);
  const binding = sqliteD1(db), prepare = binding.prepare;
  let writes = 0;
  binding.prepare = sql => {
    if (/^(?:insert into|update)\s+"?sync_states"?/i.test(sql)) writes++;
    return prepare(sql);
  };
  env.DB = binding;
  env.IDENTITY_TRUSTED_HOSTS = 'app.test';
  requestHeaders.set('host', 'app.test');
  requestHeaders.set('oai-authenticated-user-email', 'sync-size@example.test');
  t.after(() => db.close());
  return { db, writes: () => writes };
}
const utf8Bytes = value => Buffer.byteLength(JSON.stringify(value));
function backupOfSize(size, unit = 'a') {
  const payload = { schemaVersion: '1.2.0', cards: [], events: [], lists: Array.from({ length: Math.ceil(size / 100000) }, (_, index) => ({ id: `list-${index}`, note: '' })), settings: [], writings: [] };
  let remaining = size - utf8Bytes(payload);
  const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
  for (const row of payload.lists) {
    const count = Math.min(199000 / unit.length | 0, Math.floor(remaining / unitBytes));
    row.note = unit.repeat(count); remaining -= count * unitBytes;
  }
  payload.lists[0].note += 'a'.repeat(remaining);
  assert.equal(utf8Bytes(validateBackup(payload)), size);
  return payload;
}
const request = (payload, baseRevision = 0, extra = {}, headers = {}) => new Request('https://app.test/api/sync', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ schemaVersion: '1.2.0', clientUpdatedAt: '2026-10-31T00:00:00Z', baseRevision, payload, ...extra }),
});

test('a payload exactly at the UTF-8 cap fits the D1 row with metadata; one byte over never attempts SQL', async t => {
  const { db, writes } = setup(t);
  const maximum = backupOfSize(MAX_SYNC_PAYLOAD_BYTES);
  // Date.parse permits this long date representation; it must count towards
  // the row rather than being treated as constant-sized ISO metadata.
  const clientUpdatedAt = '2026-10-31' + ' '.repeat(3000);
  assert.ok(Number.isFinite(Date.parse(clientUpdatedAt)));
  const good = await POST(request(maximum, 0, { clientUpdatedAt }));
  assert.equal(good.status, 200, await good.clone().text());
  assert.equal(writes(), 1);
  assert.equal(db.prepare('SELECT length(CAST(payload AS BLOB)) AS n FROM sync_states').get().n, MAX_SYNC_PAYLOAD_BYTES);
  const before = db.prepare('SELECT * FROM sync_states').get();
  const tooLarge = await POST(request(backupOfSize(MAX_SYNC_PAYLOAD_BYTES + 1), 1));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: SYNC_TOO_LARGE_MESSAGE, code: 'payload_too_large' });
  assert.equal(writes(), 1);
  assert.deepEqual(db.prepare('SELECT * FROM sync_states').get(), before, 'refusal cannot change payload or revision');
});

test('Unicode and JSON escaping count as stored UTF-8 bytes rather than characters', async t => {
  const { writes } = setup(t);
  for (const unit of ['中', '\\']) {
    const large = backupOfSize(MAX_SYNC_PAYLOAD_BYTES + 1, unit);
    assert.ok(JSON.stringify(large).length <= utf8Bytes(large));
    const response = await POST(request(large));
    assert.equal(response.status, 413, await response.clone().text());
    assert.equal((await response.json()).code, 'payload_too_large');
  }
  assert.equal(writes(), 0);
});

test('the former D1-overflow range returns actionable 413 instead of repeatedly failing with 503', async t => {
  const { writes } = setup(t);
  const legacyOversize = backupOfSize(2_250_481);
  for (let index = 0; index < 2; index++) {
    const response = await POST(request(legacyOversize));
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error, /1\.9 MB.*本机学习记录仍然保留.*导出学习备份/);
    assert.equal(body.code, 'payload_too_large');
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(writes(), 0);
  const declared = await POST(request({ schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] }, 0, {}, { 'content-length': String(MAX_SYNC_REQUEST_BYTES + 1) }));
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error, SYNC_TOO_LARGE_MESSAGE);
});

test('metadata cannot consume the reserved row space and small uploads keep atomic revision behavior', async t => {
  const { writes } = setup(t);
  const small = { schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] };
  const metadataOverflow = await POST(request(small, 0, { clientUpdatedAt: '2026-10-31' + ' '.repeat(2_000_000) }));
  assert.equal(metadataOverflow.status, 413);
  assert.equal(writes(), 0);
  const first = await Promise.all([POST(request(small)), POST(request(small))]);
  assert.deepEqual(first.map(response => response.status).sort(), [200, 409]);
  const updates = await Promise.all([POST(request(small, 1)), POST(request(small, 1))]);
  assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
  assert.equal((await (await GET()).json()).state.revision, 2);
});

test('existing larger snapshots remain readable without truncation or migration', async t => {
  const { db } = setup(t);
  // Old deployments/SQLite imports can already contain data above the new
  // conservative admission cap. The new limit must not remove or hide it.
  db.exec('DROP TRIGGER d1_limit_INSERT');
  const { authenticatedUserKey } = await import('../lib/server-user.ts');
  const payload = JSON.stringify(backupOfSize(MAX_SYNC_PAYLOAD_BYTES + 1));
  db.prepare('INSERT INTO sync_states VALUES (?, ?, ?, ?, ?, ?)').run(await authenticatedUserKey(), 7, '1.2.0', payload, '2026-10-31T00:00:00Z', '2026-10-31 00:00:00');
  const result = await (await GET()).json();
  assert.equal(result.state.payload, payload);
  assert.equal(result.state.revision, 7);
});

test('client preflight uses the same byte boundary and actionable error', () => {
  assert.doesNotThrow(() => assertSyncPayloadFits('a'.repeat(MAX_SYNC_PAYLOAD_BYTES)));
  assert.throws(() => assertSyncPayloadFits('中'.repeat(Math.floor(MAX_SYNC_PAYLOAD_BYTES / 3) + 1)), { message: SYNC_TOO_LARGE_MESSAGE });
  assert.throws(() => assertSyncPayloadFits('a'.repeat(MAX_SYNC_PAYLOAD_BYTES + 1)), { message: SYNC_TOO_LARGE_MESSAGE });
});
