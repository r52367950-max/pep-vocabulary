import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import 'fake-indexeddb/auto';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { GET, POST, DELETE } from '../app/api/ai/config/route.ts';
import { GET as syncGet, POST as syncPost } from '../app/api/sync/route.ts';
import { getLearningMemory, putLearningMemory } from '../lib/learning-memory/server.ts';
import { reserveTokens, settleTokens, readTokenUsage } from '../lib/assistant/usage.ts';
import { parseUsage } from '../lib/assistant/core.ts';
import { inspectPhoto, compressDictationPhoto } from '../lib/image-input.ts';
import { personalReadingsGeneration, clearPersonalReadings, savePersonalArticle, listPersonalReadings } from '../lib/personal-readings.ts';
import { installPracticeLocks } from './local-practice-locks.mjs';
import { readLocalVoiceHistory, saveLocalVoiceRecord, deleteLocalVoiceRecord } from '../lib/voice/client.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
const binding = sqliteD1(db);
const config = { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', apiKey: 'offline-test-key-never-real', dailyLimit: 30, timeoutSeconds: 25 };
const req = (body, method = 'POST', path = '/api/ai/config') => new Request(`https://app.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: JSON.stringify(body) });
const readView = async () => { const { accountScope, generation, writeToken } = await (await GET()).json(); return { accountScope, generation, writeToken }; };
beforeEach(() => {
  for (const table of ['ai_rate_limits', 'ai_configs', 'ai_config_generations', 'ai_preferences', 'sync_states']) db.exec(`DELETE FROM ${table}`);
  env.DB = binding; env.AI_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  requestHeaders.set('oai-authenticated-user-email', 'cloud-a@example.test');
});

test('stale config forms cannot mutate another account, overwrite an update or delete a newer key', async () => {
  const a = await readView();
  requestHeaders.set('oai-authenticated-user-email', 'cloud-b@example.test');
  for (const method of ['POST', 'DELETE']) assert.equal((await (method === 'POST' ? POST : DELETE)(req({ ...config, ...a }, method))).status, 409);
  assert.equal((await POST(req(config))).status, 409, 'missing view is rejected');
  const b = await readView();
  assert.equal((await POST(req({ ...config, ...b }))).status, 200);
  assert.equal((await POST(req({ ...config, ...b, model: 'stale' }))).status, 409);
  assert.equal((await DELETE(req(b, 'DELETE'))).status, 409);
  const saved = await readView();
  assert.equal((await DELETE(req(saved, 'DELETE'))).status, 200);
  assert.equal((await POST(req({ ...config, ...saved }))).status, 409, 'delete invalidates old views');
  assert.equal((await POST(req({ ...config, ...await readView() }))).status, 200);
  assert.equal(db.prepare('SELECT model FROM ai_configs').get().model, config.model);
});

test('sync requires read identity and fails closed before backup writes when limiter migration is absent', async () => {
  const body = { schemaVersion: '1.2.0', baseRevision: 0, clientUpdatedAt: new Date().toISOString(), payload: { schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] } };
  assert.equal((await syncPost(req(body, 'POST', '/api/sync'))).status, 409);
  const { identity } = await (await syncGet()).json();
  assert.equal((await syncPost(req({ ...body, expectedIdentity: identity }, 'POST', '/api/sync'))).status, 200);
  db.exec('ALTER TABLE ai_rate_limits RENAME TO hidden_rate_limits');
  try { assert.equal((await syncPost(req({ ...body, baseRevision: 1, expectedIdentity: identity }, 'POST', '/api/sync'))).status, 503); }
  finally { db.exec('ALTER TABLE hidden_rate_limits RENAME TO ai_rate_limits'); }
  assert.equal(db.prepare('SELECT revision FROM sync_states').get().revision, 1);
});

test('both learning-memory aliases reject omitted and wrong account scope; current scoped updates work', async () => {
  for (const path of ['/api/learning-memory', '/api/voice/memory']) {
    const current = await (await getLearningMemory(new Request(`https://app.test${path}`))).json();
    for (const accountScope of [undefined, 'other-account']) assert.equal((await putLearningMemory(req({ ...current, accountScope, enabled: true }, 'PUT', path))).status, 409);
    assert.equal((await putLearningMemory(req({ ...current, enabled: true }, 'PUT', path))).status, 200);
  }
});

test('implausible provider usage cannot poison SQL counters; normal audio overages remain charged', async () => {
  assert.equal(parseUsage({ prompt_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }), null);
  assert.equal(parseUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: Number.MAX_SAFE_INTEGER }), null);
  const reservation = await reserveTokens('bounded', 100000, 'prompt', 2048);
  const poisoned = await settleTokens(reservation, { prompt: Number.MAX_SAFE_INTEGER, completion: 0, total: Number.MAX_SAFE_INTEGER, cacheHit: 0, estimated: false }, 'answer');
  assert.equal(poisoned.today, reservation.amount); assert.equal(poisoned.usage.estimated, true);
  assert.ok((await readTokenUsage('bounded')).total < 10000);
  await reserveTokens('bounded', 100000, 'next prompt', 2048);
  const honest = { prompt: 1000, completion: 4000, total: 5000, cacheHit: 100, estimated: false };
  const audio = await reserveTokens('audio', 100000, 'prompt', 2048);
  assert.equal((await settleTokens(audio, honest, 'answer')).today, 5000);
});

test('photo budgets and animation flags are checked before a native decode for both photo workflows', async t => {
  let decodes = 0;
  const oldBitmap = globalThis.createImageBitmap; t.after(() => { globalThis.createImageBitmap = oldBitmap; });
  globalThis.createImageBitmap = async () => { decodes++; throw new Error('decode should not run'); };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xCIAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(await inspectPhoto(new Blob([png])), [1, 1]);
  const giant = Buffer.from(png); giant.writeUInt32BE(100000, 16); giant.writeUInt32BE(100000, 20);
  await assert.rejects(compressDictationPhoto(new Blob([giant])), /尺寸过大/);
  const animation = Buffer.concat([png.subarray(0, 33), Buffer.from([0,0,0,8]), Buffer.from('acTL'), Buffer.alloc(12), png.subarray(33)]);
  await assert.rejects(compressDictationPhoto(new Blob([animation])), /静态/);
  await assert.rejects(compressDictationPhoto(new Blob(['<svg width="100000"/>'])), /格式/);
  assert.equal(decodes, 0);
  for (const file of ['components/studio/voice/paper-dictation.tsx', 'components/studio/writing/handwriting-upload.tsx']) assert.match(readFileSync(file, 'utf8'), /from "@\/lib\/image-input"/);
});

test('personal article import started before erase cannot resurrect content, while a new import works', async () => {
  await clearPersonalReadings();
  const old = await personalReadingsGeneration();
  const original = JSON.parse(readFileSync('public/readings/v1/articles/a-place-to-begin.json', 'utf8'));
  const article = { ...original, id: 'personal-generation-test', form: 'imported', sourceUrl: '', rights: { label: '个人导入', basis: '个人文章', url: '' } };
  await clearPersonalReadings();
  await assert.rejects(savePersonalArticle(article, undefined, old), /替换或清空/);
  assert.deepEqual(await listPersonalReadings(), []);
  assert.equal(await savePersonalArticle(article, undefined, await personalReadingsGeneration()), article.id);
});

test('voice record CAS preserves another tab updates, blocks late save after delete and permits explicit absent-only undo', async t => {
  installPracticeLocks(t);
  const values = new Map();
  const oldStorage = globalThis.localStorage; t.after(() => { globalThis.localStorage = oldStorage; });
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const record = { id: 'cas-voice', createdAt: '2026-11-03', topicId: 'everyday', level: 'B1', seconds: 2, transcript: [{ role: 'user', text: 'old' }], customTopic: 'a'.repeat(600), goal: 'b'.repeat(600), openingPrompt: 'c'.repeat(600) };
  const fresh = await readLocalVoiceHistory('scope');
  await saveLocalVoiceRecord(fresh, record);
  assert.equal((await readLocalVoiceHistory('scope')).rows[0].customTopic.length, 600);
  const a = await readLocalVoiceHistory('scope'), b = await readLocalVoiceHistory('scope');
  const updated = { ...record, transcript: [{ role: 'user', text: 'new' }] };
  await saveLocalVoiceRecord(a, updated);
  await assert.rejects(saveLocalVoiceRecord(b, record), /其他页面/);
  await assert.rejects(deleteLocalVoiceRecord(b, record.id), /其他页面/);
  const current = await readLocalVoiceHistory('scope');
  await deleteLocalVoiceRecord(current, record.id);
  await assert.rejects(saveLocalVoiceRecord(current, updated), /其他页面/);
  const empty = await readLocalVoiceHistory('scope');
  await saveLocalVoiceRecord(empty, updated);
  await assert.rejects(saveLocalVoiceRecord(empty, record), /其他页面/);
});

test('reading generator rejects traversal and duplicate IDs before writing either output tree', t => {
  const root = mkdtempSync(join(tmpdir(), 'pep-corpus-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts/build-reading-corpus.py', 'data/readings', 'public/readings/v1']) cpSync(path, join(root, path), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"safe":true}');
  const curationPath = join(root, 'data/readings/curation.json');
  const initial = JSON.parse(readFileSync(curationPath, 'utf8'));
  const catalogPath = join(root, 'public/readings/v1/index.json');
  const originalCatalog = readFileSync(catalogPath, 'utf8');
  for (const id of ['../../../../package', '/tmp/escape', 'dot.name', initial[1].id]) {
    writeFileSync(curationPath, JSON.stringify(initial.map((row, index) => index ? row : { ...row, id })));
    const result = spawnSync('python', [join(root, 'scripts/build-reading-corpus.py')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid reading ID|Duplicate reading ID/);
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{"safe":true}'); assert.equal(readFileSync(catalogPath, 'utf8'), originalCatalog);
  }
  writeFileSync(curationPath, JSON.stringify(initial));
  const supplemental = join(root, 'data/readings/supplemental', readdirSync(join(root, 'data/readings/supplemental'))[0]);
  const article = JSON.parse(readFileSync(supplemental, 'utf8'));
  writeFileSync(supplemental, JSON.stringify({ ...article, id: '../../../../package' }));
  assert.match(spawnSync('python', [join(root, 'scripts/build-reading-corpus.py')], { encoding: 'utf8' }).stderr, /Invalid reading ID/);
  writeFileSync(supplemental, JSON.stringify(article));
  const valid = spawnSync('python', [join(root, 'scripts/build-reading-corpus.py')], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
});

test('public provenance contains no private upload inventory and its generator cannot resurrect it', () => {
  for (const path of ['source_manifest.json', 'SOURCE_MANIFEST.md', 'scripts/build-source-manifest.mjs']) assert.doesNotMatch(readFileSync(path, 'utf8'), /UPLOAD-|user-upload-out-of-scope|PEP_VOCAB_UPLOADS|project_sources/);
});
