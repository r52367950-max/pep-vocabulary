import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import 'fake-indexeddb/auto';
import { clearUserData, exportBackup, restoreBackup, saveWriting, listWritings, deleteWriting, WritingConflictError,
  putOne, getOne, patchSettings, loadSettings, loadLearningState } from '../lib/storage.ts';
import { newWriting } from '../lib/writing.ts';
import { newStoredCard } from '../lib/scheduler.ts';
import { clearAssistantCache, runAssistant, assistantCacheSize } from '../lib/ai-client.ts';

beforeEach(async () => { await clearUserData(); await clearAssistantCache(); });

test('concurrent edits of one writing accept one version and preserve reviewed history', async () => {
  const base = newWriting('practical', []);
  base.versions[0].text = 'An already saved draft.';
  base.versions[0].review = { reviewedAt: base.updatedAt, model: 'test', result: { overall: 'Saved feedback.' } };
  await saveWriting(base);
  const edit = (text) => ({ ...base, versions: [...base.versions, { id: text, text, savedAt: base.updatedAt }] });
  const results = await Promise.allSettled([saveWriting(edit('First tab'), base), saveWriting(edit('Second tab'), base)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.find((result) => result.status === 'rejected').reason instanceof WritingConflictError);
  const [saved] = await listWritings();
  assert.equal(saved.versions.length, 2);
  assert.deepEqual(saved.versions[0], base.versions[0]);
  await deleteWriting(base.id);
  await assert.rejects(saveWriting(edit('Stale queued save'), saved), WritingConflictError);
  assert.equal((await listWritings()).length, 0, 'deleted records stay deleted');
});

test('invalid writing backup variants never replace the existing database', async () => {
  const base = newWriting('practical', []);
  await saveWriting(base);
  const safe = await exportBackup();
  const brokenResults = [
    { issues: [null] }, { issues: [{ quote: 3 }] }, { targetWords: [null] }, { band: {} },
    { structure: {} }, { sentences: {} }, { nextSteps: [{}] }, { scores: { content: {} } },
    { issues: [{ quote: 'x', type: '__proto__', suggestion: 'y', reason: 'z' }] },
  ];
  for (const result of brokenResults) {
    const corrupt = structuredClone(safe);
    corrupt.writings[0].versions[0].review = { reviewedAt: base.updatedAt, model: 'test', result };
    await assert.rejects(restoreBackup(corrupt), /写作记录/);
    assert.deepEqual(await listWritings(), [base]);
  }
  const empty = structuredClone(safe); empty.writings[0].versions = [];
  await assert.rejects(restoreBackup(empty), /写作记录/);
  assert.deepEqual(await listWritings(), [base]);
});

test('extra skill properties cannot change mastery through imported data', async () => {
  const saved = newStoredCard('apple'); await putOne('cards', saved);
  for (const extra of [999, { value: 1 }]) {
    const backup = await exportBackup(); backup.cards[0].skills.extra = extra;
    await assert.rejects(restoreBackup(backup), /词卡/);
    assert.deepEqual(await getOne('cards', 'apple'), saved);
  }
});

test('concurrent setting patches preserve unrelated fields and snapshots use one open', async () => {
  await Promise.all([patchSettings({ theme: 'dark' }), patchSettings({ dailyMinutes: 60 })]);
  assert.deepEqual([(await loadSettings()).theme, (await loadSettings()).dailyMinutes], ['dark', 60]);
  await putOne('cards', newStoredCard('apple'));
  const original = indexedDB.open;
  let opens = 0; indexedDB.open = function (...args) { opens++; return original.apply(this, args); };
  try {
    const snapshot = await loadLearningState();
    assert.equal(snapshot.cards[0].id, 'apple');
    assert.equal(snapshot.settings.theme, 'dark');
    assert.deepEqual(snapshot.events, []);
    assert.equal(opens, 1);
  } finally { indexedDB.open = original; }
});

test('learning diagnosis never reuses an answer from an old learning profile', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => Response.json({ ok: true, model: 'm', result: { summary: String(++calls) } });
  assert.equal((await runAssistant('diagnose', {})).result.summary, '1');
  assert.equal((await runAssistant('diagnose', {})).result.summary, '2');
  assert.equal(await assistantCacheSize(), 0);
});

test('AI cache has a deterministic 600-entry maximum', async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ ok: true, model: 'm', result: { summary: 's' } });
  for (let i = 0; i < 603; i++) await runAssistant('explain', { wordId: `cache-${i}` });
  assert.equal(await assistantCacheSize(), 600);
});
