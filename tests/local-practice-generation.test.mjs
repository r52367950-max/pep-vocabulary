import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { clearLocalPracticeData } from '../lib/local-practice-data.ts';
import { localPracticeGeneration, writeLocalPracticeData } from '../lib/local-practice-generation.ts';
import { readLocalVoiceHistory, saveLocalVoiceRecord, deleteLocalVoiceRecord, VOICE_HISTORY_KEY } from '../lib/voice/client.ts';
import { readLocalDictationHistory, saveLocalDictationAttempt, DICTATION_HISTORY_KEY, DICTATION_SENTENCES } from '../lib/voice/dictation.ts';
import { installPracticeLocks } from './local-practice-locks.mjs';

function setup(t) {
  const locks = installPracticeLocks(t);
  const previous = { storage: globalThis.localStorage, fetch: globalThis.fetch, window: globalThis.window, channel: globalThis.BroadcastChannel };
  const values = new Map(), delayedMessages = [];
  globalThis.localStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  };
  globalThis.window = { addEventListener() {} };
  // Deliberately never deliver these messages: persistence cannot depend on a
  // queued cross-tab callback stopping a stale ended/feedback/undo handler.
  globalThis.BroadcastChannel = class { postMessage(message) { delayedMessages.push(message); } };
  const memory = { accountScope: 'account-a', revision: 1, enabled: true, notes: [], recentTopics: [] };
  globalThis.fetch = async () => Response.json(memory);
  t.after(() => {
    globalThis.localStorage = previous.storage; globalThis.fetch = previous.fetch;
    globalThis.window = previous.window; globalThis.BroadcastChannel = previous.channel;
  });
  return { locks, values, memory, delayedMessages };
}
const record = id => ({ id, createdAt: '2026-10-31', topicId: 'everyday', level: 'B1', seconds: 1, transcript: [{ role: 'user', text: `private-${id}` }] });

async function independentTab(t) {
  const root = await mkdtemp(join(tmpdir(), 'vocab-privacy-tab-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (await readFile(new URL('../lib/learning-context-client.ts', import.meta.url), 'utf8'))
    .replace('"./local-practice-generation"', JSON.stringify(new URL('../lib/local-practice-generation.ts', import.meta.url).href));
  const file = join(root, 'tab-context.ts');
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}

test('reset fences another tab’s ended/feedback saves, deleted-record undo and dictation attempts before broadcast delivery', async t => {
  const { values } = setup(t);
  const tabBVoice = await readLocalVoiceHistory('account-a');
  const tabBDictation = await readLocalDictationHistory('account-a');
  const old = record('old');
  await saveLocalVoiceRecord(tabBVoice, old);
  await saveLocalDictationAttempt('account-a', tabBDictation.generation, DICTATION_SENTENCES[0], 'private old answer');
  await clearLocalPracticeData();
  for (const staleSave of [
    () => saveLocalVoiceRecord(tabBVoice, { ...old, feedback: { strength: 'stale feedback' } }),
    () => saveLocalVoiceRecord(tabBVoice, old), // undo / an already-open record
    () => deleteLocalVoiceRecord(tabBVoice, 'another-record'),
    () => saveLocalDictationAttempt('account-a', tabBDictation.generation, DICTATION_SENTENCES[0], 'stale answer'),
  ]) await assert.rejects(staleSave(), /已清空/);
  assert.equal(values.has(`${VOICE_HISTORY_KEY}:account-a`), false);
  assert.equal(values.has(`${DICTATION_HISTORY_KEY}:account:account-a`), false);
  const freshVoice = await readLocalVoiceHistory('account-a');
  const freshDictation = await readLocalDictationHistory('account-a');
  assert.deepEqual(freshVoice.rows, []);
  assert.deepEqual(freshDictation.value, []);
  assert.deepEqual((await saveLocalVoiceRecord(freshVoice, record('new'))).map(row => row.id), ['new']);
  const dictationRows = await saveLocalDictationAttempt('account-a', freshDictation.generation, DICTATION_SENTENCES[1], 'new answer');
  assert.deepEqual(dictationRows.map(row => row.lastAnswer), ['new answer']);
  await assert.rejects(saveLocalVoiceRecord(tabBVoice, old), /已清空/);
  assert.deepEqual((await readLocalVoiceHistory('account-a')).rows.map(row => row.id), ['new']);
});

test('reset and real persistence callbacks serialize, including a writer queued behind reset', async t => {
  const { locks, values } = setup(t);
  const before = localPracticeGeneration();
  let release;
  const blocker = locks.request('vocab-local-practice-storage-v1', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const reset = clearLocalPracticeData();
  const stale = writeLocalPracticeData(before, storage => storage.setItem(`${VOICE_HISTORY_KEY}:account-a`, 'stale transcript'));
  const rejection = assert.rejects(stale, /已清空/);
  release(); await blocker; await reset; await rejection;
  assert.equal(values.has(`${VOICE_HISTORY_KEY}:account-a`), false);
  const current = localPracticeGeneration();
  await writeLocalPracticeData(current, storage => storage.setItem(`${VOICE_HISTORY_KEY}:account-a`, 'new transcript'));
  assert.equal(values.get(`${VOICE_HISTORY_KEY}:account-a`), 'new transcript');
});

test('queued practice persistence rechecks account and temporary policy inside the lock', async t => {
  const { locks, values } = setup(t);
  const snapshot = await readLocalVoiceHistory('account-a');
  let release, allowed = true;
  const blocker = locks.request('vocab-local-practice-storage-v1', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const voice = saveLocalVoiceRecord(snapshot, record('queued'), () => allowed);
  const dictation = saveLocalDictationAttempt('account-a', snapshot.generation, DICTATION_SENTENCES[0], 'queued answer', () => allowed);
  const failures = Promise.all([assert.rejects(voice, /学习模式已改变/), assert.rejects(dictation, /学习模式已改变/)]);
  allowed = false; release(); await blocker; await failures;
  assert.equal(values.has(`${VOICE_HISTORY_KEY}:account-a`), false);
  assert.equal(values.has(`${DICTATION_HISTORY_KEY}:account:account-a`), false);
});

test('independent stale tab cannot restore profile consent; an in-flight metadata response cannot adopt the new generation', async t => {
  const { values, memory } = setup(t);
  const tabB = await independentTab(t);
  await tabB.refreshLearningContext(); await tabB.setLocalProfileAllowed(true);
  assert.equal(tabB.localProfileAllowed(tabB.learningContextStore.get().memory), true);
  let resolveFetch;
  globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  const staleRead = tabB.refreshLearningContext();
  const rejectedRead = assert.rejects(staleRead, /本机数据已改变/);
  await clearLocalPracticeData();
  await assert.rejects(tabB.setLocalProfileAllowed(true), /已清空/);
  assert.equal(values.has('vocab-local-profile-owner-v1'), false);
  resolveFetch(Response.json(memory)); await rejectedRead;
  assert.equal(tabB.learningContextStore.get().memory, null);
  globalThis.fetch = async () => Response.json(memory);
  await tabB.refreshLearningContext(); await tabB.setLocalProfileAllowed(true);
  assert.equal(tabB.localProfileAllowed(tabB.learningContextStore.get().memory), true, 'a fresh explicit choice remains available');
});

test('without Web Locks practice writes and consent enabling fail closed, but reading, erasure and consent revocation remain available', async t => {
  const { values } = setup(t);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const tab = await independentTab(t);
  await tab.refreshLearningContext();
  values.set('vocab-local-profile-owner-v1', 'account-a');
  await tab.setLocalProfileAllowed(false);
  assert.equal(values.has('vocab-local-profile-owner-v1'), false);
  await assert.rejects(tab.setLocalProfileAllowed(true), /不支持安全保存/);
  const snapshot = await readLocalVoiceHistory('account-a');
  await assert.rejects(saveLocalVoiceRecord(snapshot, record('blocked')), /不支持安全保存/);
  values.set(`${VOICE_HISTORY_KEY}:account-a`, JSON.stringify([record('legacy')]));
  assert.equal((await readLocalVoiceHistory('account-a')).rows[0].id, 'legacy');
  await clearLocalPracticeData();
  assert.equal(values.has(`${VOICE_HISTORY_KEY}:account-a`), false);
});
