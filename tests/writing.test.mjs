import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { countWords, findTargetUses, localWritingChecks, newWriting, suggestTargets, targetMatcher, wordForms, writingTitle } from '../lib/writing.ts';
import { clearUserData, deleteWriting, exportBackup, listWritings, putOne, restoreBackup, saveWriting, USER_DATA_SCHEMA_VERSION, validateBackup, defaultSettings } from '../lib/storage.ts';
import { newStoredCard } from '../lib/scheduler.ts';
import { assistantCacheSize, cacheKey, clearAssistantCache, profileSnapshot, readCached, runAssistant } from '../lib/ai-client.ts';

const entry = (id, headword) => ({ id, headword, lookup: headword, chineseCore: '', scopes: [], sources: [], partsOfSpeech: [], flags: { properName: false }, britishIpa: '' });

test('target words are found through regular and irregular forms and phrases', () => {
  assert.ok(wordForms('study').includes('studied'));
  assert.ok(wordForms('stop').includes('stopped'));
  assert.ok(wordForms('choose').includes('chose'));
  assert.ok(wordForms('make').includes('making'));
  const text = 'She chose to study abroad. They studied hard and never gave up, so they achieved their goals. I will take it easy.';
  const uses = findTargetUses(text, [entry('a', 'choose'), entry('b', 'study'), entry('c', 'give up'), entry('d', 'achieve'), entry('e', 'take it easy'), entry('f', 'volunteer'), entry('g', 'look forward to')]);
  assert.deepEqual(uses.map((use) => use.count), [1, 2, 1, 1, 1, 0, 0]);
  assert.equal(text.slice(...uses[2].ranges[0]), 'gave up');
  assert.equal(targetMatcher('...'), null);
  // Inside another word is not a use.
  assert.equal(findTargetUses('Understudy roles', [entry('b', 'study')])[0].count, 0);
});

test('local checks cover length, coverage, repetition and capitals', () => {
  const text = 'i think volunteering is important. we should help others and help others and help others and help others.';
  const checks = localWritingChecks(text, findTargetUses(text, [entry('v', 'volunteer'), entry('o', 'opportunity')]), [80, 120]);
  const ids = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(ids.length.level, 'issue');
  assert.match(ids.targets.message, /opportunity/);
  assert.match(ids.repeat.message, /others/);
  assert.equal(ids.capital.level, 'issue');
  assert.equal(ids.pronoun.level, 'issue');
  assert.equal(countWords("It's a well-known fact."), 4);
});

test('target suggestions start from recent mistakes and skip paused words', () => {
  const byId = new Map(['a', 'b', 'c', 'd'].map((id) => [id, entry(id, `word${id}`)]));
  const events = ['a', 'b', 'c', 'd'].map((id, i) => ({ eventId: id, cardId: id, correct: id !== 'b', eventType: 'review', timestampUtc: `2026-09-2${i}T00:00:00Z` }));
  const cards = new Map([['c', { status: 'paused' }]]);
  assert.deepEqual(suggestTargets(events, cards, byId, 3).map((item) => item.id), ['b', 'd', 'a']);
});

test('writings live in the learning database and in backups (schema 1.2.0)', async () => {
  assert.equal(USER_DATA_SCHEMA_VERSION, '1.2.0');
  await clearUserData();
  await putOne('cards', newStoredCard('apple'));
  await putOne('settings', defaultSettings);
  const record = newWriting('practical', ['pep-a46c38628a99e102'], 'Write to Tom.');
  record.versions[0].text = 'Dear Tom, I am writing to invite you.';
  record.versions[0].review = { reviewedAt: new Date().toISOString(), model: 'deepseek-v4-flash', result: { kind: 'review-essay', overall: '好' } };
  await saveWriting(record);
  assert.equal(writingTitle(record), 'Dear Tom, I am writing to…');
  const backup = await exportBackup();
  assert.equal(backup.schemaVersion, '1.2.0');
  assert.equal(backup.writings.length, 1);
  await clearUserData();
  assert.equal((await listWritings()).length, 0);
  await restoreBackup(backup);
  assert.deepEqual(await listWritings(), [record]);
  await deleteWriting(record.id);
  assert.equal((await listWritings()).length, 0);
  await assert.rejects(saveWriting({ ...record, genre: 'poem' }), /写作记录无效/);
  assert.throws(() => validateBackup({ ...backup, writings: [{ ...record, versions: [{ id: 'x', text: 1, savedAt: 'now' }] }] }), /写作记录/);
  assert.throws(() => validateBackup({ ...backup, writings: undefined }), /字段缺失/);
});

test('older backups still import and gain an empty writings list', async () => {
  const old = { schemaVersion: '1.1.0', cards: [newStoredCard('apple')], events: [], lists: [], settings: [defaultSettings] };
  const migrated = validateBackup(old);
  assert.equal(migrated.schemaVersion, '1.2.0');
  assert.deepEqual(migrated.writings, []);
  await restoreBackup(old);
  assert.equal((await exportBackup()).cards.length, 1);
  const oldest = validateBackup({ schemaVersion: '1.0.0', cards: [], events: [], lists: [], settings: [] });
  assert.deepEqual(oldest.writings, []);
});

test('assistant answers are cached locally and a repeat view sends no request', async (t) => {
  await clearAssistantCache();
  const calls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ ok: true, model: 'm', result: { kind: 'explain', summary: 's' }, usage: { prompt: 10, completion: 5, cacheHit: 8, total: 15, estimated: false, today: 15, budget: 1000 } });
  };
  const input = { wordId: 'pep-a46c38628a99e102', focus: 'grammar' };
  const first = await runAssistant('explain', input, { profile: { date: '2026-09-29' } });
  assert.equal(first.cachedAt, null);
  assert.equal(calls[0].body.profile.date, '2026-09-29');
  const second = await runAssistant('explain', { focus: 'grammar', wordId: 'pep-a46c38628a99e102' });
  assert.ok(second.cachedAt, 'served from the cache regardless of key order');
  assert.equal(calls.length, 1);
  await runAssistant('explain', input, { refresh: true });
  assert.equal(calls.length, 2);
  assert.equal(await assistantCacheSize(), 1);
  assert.equal(cacheKey('explain', { b: 1, a: 2 }), cacheKey('explain', { a: 2, b: 1 }));
  globalThis.fetch = async () => Response.json({ ok: false, error: { code: 'token_budget_exhausted', message: '预算用完' } }, { status: 429 });
  await assert.rejects(runAssistant('explain', { wordId: 'pep-other0000000000' }), (error) => error.code === 'token_budget_exhausted');
  await clearAssistantCache();
  assert.equal(await readCached('explain', input), null);
  let builds = 0;
  const build = () => ({ built: ++builds });
  assert.equal(profileSnapshot(10, 'w0', build), profileSnapshot(29, 'w0', build));
  assert.notEqual(profileSnapshot(30, 'w0', build), profileSnapshot(29, 'w0', build));
});

test('review marks are placed once each, in text order, case-insensitively', async () => {
  const { locateIssues } = await import('../lib/writing.ts');
  const marks = locateIssues('I go there. i go there too.', [{ quote: 'i go there' }, { quote: 'I go there' }, { quote: 'missing' }, { quote: 'too' }]);
  assert.deepEqual(marks.map((mark) => [mark.index, mark.start]), [[0, 0], [1, 12], [3, 23]]);
});
