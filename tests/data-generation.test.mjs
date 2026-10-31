import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  clearUserData, commitReview, exportBackup, getOne, loadLearningState,
  patchSettings, restoreBackup, saveWriting, deleteWriting, updateCardMetadata,
  readCloudLink, saveCloudLink, putOne,
} from '../lib/storage.ts';
import { newStoredCard, scheduleReview } from '../lib/scheduler.ts';
import { newWriting } from '../lib/writing.ts';
import { restoreSession } from '../lib/session.ts';

beforeEach(() => clearUserData());
const review = () => scheduleReview({ stored: null, cardId: 'apple', rating: 3,
  retention: .9, skill: 'meaning', questionType: 'meaning-recall', correct: true,
  responseMs: 1000, hints: 0, errorType: null }).event;
const replaced = /数据已.*(?:替换|清空)/;

test('clearing all data prevents an old page from reintroducing an unseen card', async () => {
  const stale = await loadLearningState();
  const event = review();
  await clearUserData();
  await assert.rejects(commitReview(event, stale.generation), replaced);
  const state = await loadLearningState();
  assert.deepEqual(state.cards, []);
  assert.deepEqual(state.events, []);
  assert.notEqual(state.generation, stale.generation);
  await commitReview(review(), state.generation);
  assert.equal((await loadLearningState()).events.length, 1);
});

test('restoring an identical snapshot still rejects old reviews and queued preferences', async () => {
  const stale = await loadLearningState();
  const backup = await exportBackup();
  await restoreBackup(backup);
  await assert.rejects(commitReview(review(), stale.generation), replaced);
  await assert.rejects(patchSettings({ dailyMinutes: 15 }, stale.generation), replaced);
  await assert.rejects(updateCardMetadata(newStoredCard('apple'), { note: 'old note' }, stale.generation), replaced);
  assert.equal(await getOne('cards', 'apple'), undefined);
  assert.equal((await loadLearningState()).settings.dailyMinutes, 45);
});

test('old writing editors cannot change or delete restored identical records', async () => {
  const stale = await loadLearningState();
  const record = newWriting('free', [], 'A personal story');
  await saveWriting(record, null, stale.generation);
  await restoreBackup(await exportBackup());
  const next = { ...record, title: 'Late old editor' };
  await assert.rejects(saveWriting(next, record, stale.generation), replaced);
  await assert.rejects(deleteWriting(record.id, stale.generation), replaced);
  assert.deepEqual(await getOne('writings', record.id), record);
});

test('failed restoration leaves both the data and its generation unchanged', async () => {
  const original = await loadLearningState();
  const backup = await exportBackup();
  await assert.rejects(restoreBackup({ ...backup, cards: [null] }));
  assert.deepEqual(await loadLearningState(), original);
  await commitReview(review(), original.generation);
});

test('a late upload response cannot bind replacement data to its former cloud revision', async () => {
  const { generation } = await loadLearningState();
  const link = { identity: 'a'.repeat(64), revision: 4 };
  await saveCloudLink(link, generation);
  assert.deepEqual(await readCloudLink(generation), link);
  const nextGeneration = await restoreBackup(await exportBackup(generation), generation);
  await assert.rejects(saveCloudLink({ ...link, revision: 5 }, generation), replaced);
  await assert.rejects(exportBackup(generation), replaced);
  assert.equal(await readCloudLink(nextGeneration), null);
  await saveCloudLink({ ...link, revision: 6 }, nextGeneration);
  assert.equal((await readCloudLink(nextGeneration)).revision, 6);
});

test('legacy cloud bindings migrate only before the first dataset replacement', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const link = { identity: 'b'.repeat(64), revision: 8 };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify(link) } });
  try {
    await putOne('meta', { key: 'data-generation', value: 'initial' });
    assert.deepEqual(await readCloudLink('initial'), link);
    const generation = await restoreBackup(await exportBackup());
    assert.equal(await readCloudLink(generation), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('stale restore confirmations cannot replace a newer dataset', async () => {
  const { generation } = await loadLearningState();
  const backup = await exportBackup(generation);
  await clearUserData();
  const current = await loadLearningState();
  await assert.rejects(restoreBackup(backup, generation), replaced);
  await assert.rejects(clearUserData(generation), replaced);
  assert.deepEqual(await loadLearningState(), current);
});

test('session recovery binds to its dataset, including legacy checkpoints', () => {
  const now = Date.now();
  const session = { id: 'checkpoint', mode: 'daily', title: '学习', queue: ['apple'],
    position: 0, startedAt: now, results: [], retries: {} };
  const ids = new Set(['apple']);
  assert.ok(restoreSession(JSON.stringify(session), ids, [], now, 'initial'));
  assert.equal(restoreSession(JSON.stringify(session), ids, [], now, 'new-data'), null);
  const bound = { ...session, dataGeneration: 'new-data' };
  assert.ok(restoreSession(JSON.stringify(bound), ids, [], now, 'new-data'));
  assert.equal(restoreSession(JSON.stringify(bound), ids, [], now, 'other-data'), null);
});

test('successful replacements notify other pages after the transaction commits', async (t) => {
  const channel = new BroadcastChannel('vocab-changes');
  t.after(() => channel.close());
  const received = new Promise((resolve) => channel.addEventListener('message', ({ data }) => resolve(data), { once: true }));
  const backup = await exportBackup();
  const generation = await restoreBackup(backup);
  assert.equal(await received, 'replaced');
  assert.equal((await loadLearningState()).generation, generation);
});

test('database version 4 preserves older records and stops unguarded version 3 clients', async (t) => {
  const original = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  t.after(() => { globalThis.indexedDB = original; });
  const open = (version) => new Promise((resolve, reject) => {
    const request = indexedDB.open('pep-vocab-studio', version);
    request.onupgradeneeded = () => {
      for (const name of ['cards', 'events', 'lists', 'settings', 'meta', 'writings'])
        request.result.createObjectStore(name, { keyPath: name === 'events' ? 'eventId' : ['settings', 'meta'].includes(name) ? 'key' : 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const old = await open(3);
  const card = newStoredCard('apple');
  await new Promise((resolve) => {
    const tx = old.transaction('cards', 'readwrite');
    tx.objectStore('cards').put(card);
    tx.oncomplete = resolve;
  });
  let closed = false;
  old.onversionchange = () => { closed = true; old.close(); };
  const state = await loadLearningState();
  assert.equal(closed, true);
  assert.deepEqual(state.cards, [card]);
  assert.equal(state.generation, 'initial');
  await assert.rejects(open(3), (error) => error.name === 'VersionError');
  assert.deepEqual((await loadLearningState()).cards, [card]);
});
