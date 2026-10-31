import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLocalPracticeData } from '../lib/local-practice-data.ts';
import { learningContextStore, refreshLearningContext, setLocalProfileAllowed, localProfileAllowed, setTemporaryMode, invalidateLearningContext } from '../lib/learning-context-client.ts';
import { LOCAL_PRACTICE_GENERATION_KEY } from '../lib/local-practice-generation.ts';
import { installPracticeLocks } from './local-practice-locks.mjs';

function setup(t) {
  installPracticeLocks(t);
  const previous = { storage: globalThis.localStorage, fetch: globalThis.fetch };
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const memory = { accountScope: 'account-a', revision: 1, enabled: true, notes: [], recentTopics: [] };
  globalThis.fetch = async () => Response.json(memory);
  setTemporaryMode(false); invalidateLearningContext();
  t.after(() => {
    globalThis.localStorage = previous.storage; globalThis.fetch = previous.fetch;
    setTemporaryMode(false); invalidateLearningContext();
  });
  return values;
}

test('device reset removes legacy and all account-scoped practice data and revokes profile permission', async t => {
  const values = setup(t);
  await refreshLearningContext(); await setLocalProfileAllowed(true);
  assert.equal(localProfileAllowed(learningContextStore.get().memory), true);
  const removed = [
    'pep-vocab-voice-history-v1',
    'pep-vocab-voice-history-v1:account-a',
    'pep-vocab-voice-history-v1:account-b',
    'pep-vocab-voice-captions-v1',
    'vocab-studio:voice-dictation:v1',
    'vocab-studio:voice-dictation:v1:account:account-a',
    'vocab-studio:voice-dictation:v1:account:account%2Fb%3Aother',
  ];
  const retained = ['other-app-private-data', 'pep-vocab-voice-history-v10', 'vocab-studio:voice-dictation:v10', 'unrelated:pep-vocab-voice-history-v1'];
  for (const key of [...removed, ...retained]) values.set(key, 'private record');
  let notifications = 0;
  const epoch = learningContextStore.get().epoch;
  const unsubscribe = learningContextStore.subscribe(() => { notifications++; });
  t.after(unsubscribe);
  await clearLocalPracticeData();
  for (const key of removed) assert.equal(values.has(key), false, key);
  for (const key of retained) assert.equal(values.get(key), 'private record', key);
  assert.equal(values.has('vocab-local-profile-owner-v1'), false);
  assert.equal(learningContextStore.get().memory, null);
  assert.ok(learningContextStore.get().epoch > epoch);
  assert.equal(notifications, 1, 'mounted practice panels receive the policy invalidation');
  await refreshLearningContext();
  assert.equal(localProfileAllowed(learningContextStore.get().memory), false, 'reloading server metadata cannot restore local consent');
});

test('device reset revokes consent while account metadata is absent or practice is temporary', async t => {
  const values = setup(t);
  for (const temporary of [false, true]) {
    setTemporaryMode(temporary); invalidateLearningContext();
    values.set('vocab-local-profile-owner-v1', 'old-account');
    values.set('pep-vocab-voice-history-v1:old-account', 'private transcript');
    await clearLocalPracticeData();
    assert.deepEqual([...values.keys()], [LOCAL_PRACTICE_GENERATION_KEY]);
    assert.equal(learningContextStore.get().memory, null);
  }
});

test('reset opens the policy channel to invalidate practice in other tabs even before metadata was read', async t => {
  const values = setup(t);
  const previousWindow = globalThis.window, previousChannel = globalThis.BroadcastChannel;
  const messages = [];
  globalThis.window = { addEventListener() {} };
  globalThis.BroadcastChannel = class {
    constructor(name) { assert.equal(name, 'vocab-learning-context-v1'); }
    postMessage(message) { messages.push(message); }
  };
  t.after(() => { globalThis.window = previousWindow; globalThis.BroadcastChannel = previousChannel; });
  values.set('vocab-local-profile-owner-v1', 'old-account');
  await clearLocalPracticeData();
  assert.deepEqual(messages, [{ changed: true }]);
  assert.deepEqual([...values.keys()], [LOCAL_PRACTICE_GENERATION_KEY]);
});
