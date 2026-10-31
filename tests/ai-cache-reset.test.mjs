import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAssistant, clearAssistantCache, assistantCacheSize } from '../lib/ai-client.ts';
import { clearLocalPracticeData } from '../lib/local-practice-data.ts';
import { invalidateLearningContext, learningContextStore, setTemporaryMode } from '../lib/learning-context-client.ts';
import { localPracticeGeneration } from '../lib/local-practice-generation.ts';
import { installPracticeLocks } from './local-practice-locks.mjs';

const CACHE = 'pep-vocab-ai-cache';
function setup(t, withLocks = true) {
  installPracticeLocks(t);
  if (!withLocks) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const previous = { indexedDB: globalThis.indexedDB, storage: globalThis.localStorage, fetch: globalThis.fetch, window: globalThis.window, channel: globalThis.BroadcastChannel };
  const values = new Map();
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  globalThis.localStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  };
  globalThis.window = { addEventListener() {} };
  // Other tabs receive no asynchronous reset message in these tests.
  globalThis.BroadcastChannel = class { postMessage() {} };
  const fixture = { factory, values, calls: 0, model: null, memory: { accountScope: 'cache-account', revision: 1, enabled: true, notes: [], recentTopics: [], contextVersion: 'cache-model' } };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/learning-memory')) return Response.json(fixture.memory);
    fixture.calls++;
    const input = JSON.parse(init.body);
    if (fixture.model) return fixture.model(input);
    return Response.json({ ok: true, model: 'offline-model', result: { summary: `answer-${fixture.calls}` }, accountScope: fixture.memory.accountScope, contextRevision: fixture.memory.revision });
  };
  setTemporaryMode(false); invalidateLearningContext();
  t.after(() => {
    setTemporaryMode(false); invalidateLearningContext();
    globalThis.indexedDB = previous.indexedDB; globalThis.localStorage = previous.storage;
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.BroadcastChannel = previous.channel;
  });
  return fixture;
}

async function seedLegacy(factory) {
  const db = await new Promise((resolve, reject) => {
    const request = factory.open(CACHE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('results', { keyPath: 'key' }).createIndex('createdAt', 'createdAt');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite');
    tx.objectStore('results').put({ key: 'legacy', task: 'review-essay', createdAt: '2026-01-01', model: 'legacy', result: { summary: 'private legacy essay' } });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function independentTab(t) {
  const root = await mkdtemp(join(tmpdir(), 'vocab-cache-tab-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generation = new URL('../lib/local-practice-generation.ts', import.meta.url).href;
  const context = (await readFile(new URL('../lib/learning-context-client.ts', import.meta.url), 'utf8'))
    .replace('"./local-practice-generation"', JSON.stringify(generation));
  const contextPath = join(root, 'learning-context.ts');
  await writeFile(contextPath, context);
  const client = (await readFile(new URL('../lib/ai-client.ts', import.meta.url), 'utf8'))
    .replace('"./stable-json"', JSON.stringify(new URL('../lib/stable-json.ts', import.meta.url).href))
    .replace('"./learning-context-client"', JSON.stringify(pathToFileURL(contextPath).href))
    .replace('"./local-practice-generation"', JSON.stringify(generation));
  const clientPath = join(root, 'ai-client.ts');
  await writeFile(clientPath, client);
  return import(pathToFileURL(clientPath).href);
}

test('global device reset clears legacy and current AI answers, then fresh answers cache normally', async t => {
  const f = setup(t);
  await seedLegacy(f.factory);
  assert.equal(await assistantCacheSize(), 1, 'v1 cache upgrades without losing ordinary cached answers');
  await runAssistant('explain', { wordId: 'before-reset' });
  assert.equal(await assistantCacheSize(), 2);
  const generation = localPracticeGeneration();
  await clearLocalPracticeData();
  assert.notEqual(localPracticeGeneration(), generation);
  assert.equal(await assistantCacheSize(), 0);
  await runAssistant('explain', { wordId: 'after-reset' });
  assert.ok((await runAssistant('explain', { wordId: 'after-reset' })).cachedAt);
  assert.equal(await assistantCacheSize(), 1);
  assert.equal(f.calls, 2);
});

test('an independent tab cannot cache or display a pre-reset model answer before its broadcast arrives', async t => {
  const f = setup(t), tab = await independentTab(t);
  let started, release;
  const modelStarted = new Promise(resolve => { started = resolve; });
  f.model = () => new Promise(resolve => {
    release = () => resolve(Response.json({ ok: true, model: 'offline', result: { summary: 'private stale answer' }, accountScope: f.memory.accountScope, contextRevision: f.memory.revision }));
    started();
  });
  const pending = tab.runAssistant('explain', { wordId: 'in-flight' });
  const rejected = assert.rejects(pending, error => error.code === 'aborted');
  await modelStarted;
  await clearLocalPracticeData();
  assert.equal(await assistantCacheSize(), 0);
  release(); await rejected;
  assert.equal(await assistantCacheSize(), 0);
  f.model = null;
  await tab.runAssistant('explain', { wordId: 'new-practice' });
  assert.equal(await assistantCacheSize(), 1);
});

test('atomic cache generation rejects a write delayed at IndexedDB open after standalone clear', async t => {
  const f = setup(t, false);
  const open = f.factory.open.bind(f.factory);
  let opens = 0, paused, release;
  const writeWaiting = new Promise(resolve => { paused = resolve; });
  f.factory.open = (...args) => {
    const request = open(...args);
    if (args[0] !== CACHE || ++opens !== 2) return request;
    return new Proxy(request, {
      get: (target, property) => Reflect.get(target, property, target),
      set(target, property, value) {
        if (property === 'onsuccess') {
          target.onsuccess = event => { release = () => value.call(target, event); paused(); };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  };
  const generation = localPracticeGeneration();
  const pending = runAssistant('explain', { wordId: 'queued-write' }, { refresh: true });
  await writeWaiting;
  await clearAssistantCache();
  assert.equal(localPracticeGeneration(), generation, 'cache-only erasure must not stop unrelated practice');
  release();
  assert.equal((await pending).result.summary, 'answer-1', 'ordinary answer remains usable after cache-only erasure');
  assert.equal(await assistantCacheSize(), 0, 'old queued write cannot repopulate the cleared cache');
  await runAssistant('explain', { wordId: 'fresh-write' });
  assert.ok((await runAssistant('explain', { wordId: 'fresh-write' })).cachedAt);
  assert.equal(await assistantCacheSize(), 1, 'no-Web-Locks browsers still safely cache new answers');
});

test('global reset waits for the IndexedDB erasure while holding its cross-tab reset lock', async t => {
  const f = setup(t);
  await runAssistant('explain', { wordId: 'private-answer' });
  const open = f.factory.open.bind(f.factory);
  let paused, release;
  const clearWaiting = new Promise(resolve => { paused = resolve; });
  f.factory.open = (...args) => {
    const request = open(...args);
    return new Proxy(request, {
      get: (target, property) => Reflect.get(target, property, target),
      set(target, property, value) {
        if (property === 'onsuccess') {
          target.onsuccess = event => { release = () => value.call(target, event); paused(); };
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  };
  let finished = false;
  const reset = clearLocalPracticeData().then(() => { finished = true; });
  await clearWaiting;
  assert.equal(learningContextStore.get().memory, null, 'privacy invalidation precedes the asynchronous erase');
  assert.equal(finished, false);
  f.factory.open = open;
  release(); await reset;
  assert.equal(await assistantCacheSize(), 0);
});

test('an IndexedDB reset failure propagates instead of reporting successful local erasure', async t => {
  const f = setup(t);
  await runAssistant('explain', { wordId: 'not-yet-cleared' });
  const open = f.factory.open.bind(f.factory);
  f.factory.open = () => { throw new Error('cache unavailable'); };
  await assert.rejects(clearLocalPracticeData(), /cache unavailable/);
  f.factory.open = open;
  assert.equal(await assistantCacheSize(), 1);
});
