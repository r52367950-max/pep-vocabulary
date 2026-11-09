import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPersonalReadings, savePersonalArticle, readPersonalArticle, listPersonalReadings, removePersonalArticle, personalReadingsGeneration, exportPersonalArticle } from '../lib/personal-readings.ts';
const original=JSON.parse(await readFile(new URL('../public/readings/v1/articles/a-place-to-begin.json',import.meta.url),'utf8'));
const article={...original,id:'personal-test-reading',form:'imported',sourceUrl:'',rights:{label:'个人导入',basis:'本人导入的阅读材料。',url:''}};
test('personal readings persist, deduplicate by body, load separately and delete atomically', async()=>{
  await clearPersonalReadings();
  assert.equal(await savePersonalArticle(article),article.id);
  assert.equal(await savePersonalArticle({...article,id:'personal-other-id',title:'Duplicate'}),article.id);
  const catalog=await listPersonalReadings();assert.equal(catalog.length,1);assert.equal(catalog[0].paragraphs,undefined);
  assert.deepEqual((await readPersonalArticle(article.id)).paragraphs,article.paragraphs);
  await removePersonalArticle(article.id);assert.equal((await listPersonalReadings()).length,0);
  await assert.rejects(readPersonalArticle(article.id));
});
test('invalid imported bodies are rejected before changing the personal library', async()=>{
  await clearPersonalReadings();
  await assert.rejects(savePersonalArticle({...article,wordCount:4000}));
  await assert.rejects(savePersonalArticle({...article,id:'a-first-party-id'}));
  assert.equal((await listPersonalReadings()).length,0);
});
test('cancelling an asynchronous save leaves no hidden personal article', async()=>{
  await clearPersonalReadings();
  const controller = new AbortController();
  const saving = savePersonalArticle(article,controller.signal); controller.abort();
  await assert.rejects(saving,{name:'AbortError'});
  await assert.rejects(savePersonalArticle(article,controller.signal),{name:'AbortError'});
  assert.equal((await listPersonalReadings()).length,0);
});

test('single-article removal fences the old ID while preserving other drafts and intentional re-imports', async () => {
  await clearPersonalReadings();
  const generation = await personalReadingsGeneration();
  await savePersonalArticle(article, undefined, generation);
  await removePersonalArticle(article.id);
  assert.equal(await personalReadingsGeneration(), generation, 'single removal must not invalidate unrelated drafts');
  await assert.rejects(savePersonalArticle(article, undefined, generation), /文章已被移除/);
  const changed = { ...article, paragraphs: [{ en: article.paragraphs.map(p => p.en).join(' ') + ' Another sentence.' }] };
  changed.wordCount = changed.paragraphs[0].en.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g).length;
  await assert.rejects(savePersonalArticle(changed, undefined, generation), /文章已被移除/);
  const other = { ...changed, id: 'personal-unrelated-draft', title: 'Other draft' };
  assert.equal(await savePersonalArticle(other, undefined, generation), other.id);
  const fresh = { ...article, id: 'personal-intentional-reimport' };
  assert.equal(await savePersonalArticle(fresh, undefined, generation), fresh.id);
  assert.equal(await savePersonalArticle({ ...fresh, id: 'personal-duplicate-import' }, undefined, generation), fresh.id);
  assert.deepEqual((await listPersonalReadings()).map(row => row.id).sort(), [other.id, fresh.id].sort());
  await clearPersonalReadings();
  await assert.rejects(savePersonalArticle(article, undefined, generation), /替换或清空/);
  assert.equal(await savePersonalArticle(article), article.id, 'a new library generation can import the same ID again');
});

test('export re-reads the current article and cannot download a removed cached copy', async t => {
  await clearPersonalReadings();
  await savePersonalArticle(article);
  const previous = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const downloads = [];
  globalThis.document = { createElement: () => ({ click() { downloads.push(this.href); } }) };
  URL.createObjectURL = () => 'blob:personal-export-control';
  URL.revokeObjectURL = () => {};
  t.after(() => { globalThis.document = previous.document; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke; });
  await exportPersonalArticle(article);
  assert.equal(downloads.length, 1);
  await removePersonalArticle(article.id);
  await assert.rejects(exportPersonalArticle(article), /没有找到/);
  assert.equal(downloads.length, 1, 'a stale menu closure must not trigger another download');
});

test('v2 personal libraries retain data when upgraded and old v2 clients cannot restore removed IDs', async t => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  t.after(() => { globalThis.indexedDB = previous; });
  let legacyClosed = false;
  const legacy = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pep-vocab-personal-readings', 2);
    request.onupgradeneeded = () => { for (const name of ['index', 'articles', 'meta']) request.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' }); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  legacy.onversionchange = () => { legacyClosed = true; legacy.close(); };
  await new Promise((resolve, reject) => {
    const tx = legacy.transaction(['index', 'articles'], 'readwrite');
    const { paragraphs: _paragraphs, questions: _questions, targets: _targets, ...meta } = article;
    void _paragraphs; void _questions; void _targets;
    tx.objectStore('index').put({ ...meta, contentHash: 'legacy' });
    tx.objectStore('articles').put(article);
    tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
  });
  assert.deepEqual((await readPersonalArticle(article.id)).paragraphs, article.paragraphs);
  assert.equal((await listPersonalReadings())[0].id, article.id);
  assert.equal(legacyClosed, true);
  await removePersonalArticle(article.id);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = indexedDB.open('pep-vocab-personal-readings', 2);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  }), { name: 'VersionError' });
  await assert.rejects(readPersonalArticle(article.id));
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('pep-vocab-personal-readings', 4);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  await assert.rejects(listPersonalReadings(), /较新版本更新，请刷新页面/);
});

test('single removals reach hidden tabs and foreground checks recover missed messages without replacing unrelated drafts', async t => {
  const previous = { window: globalThis.window, document: globalThis.document, channel: globalThis.BroadcastChannel, storage: globalThis.localStorage };
  const channels = [], windowEvents = new Map(), heldDeliveries = [];
  let dropMessages = false;
  let heldMessageId = null;
  globalThis.window = { addEventListener(name, listener) { windowEvents.set(name, [...(windowEvents.get(name) ?? []), listener]); } };
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
  globalThis.localStorage = { setItem() {} };
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(data) {
      if (dropMessages) return;
      for (const channel of channels) if (channel !== this && channel.name === this.name) {
        const deliver = () => channel.onmessage?.({ data });
        if (data?.id === heldMessageId) heldDeliveries.push(deliver);
        else queueMicrotask(deliver);
      }
    }
  };
  const directory = await mkdtemp(join(tmpdir(), 'personal-removal-tabs-'));
  t.after(async () => {
    Object.assign(globalThis, { window: previous.window, document: previous.document, BroadcastChannel: previous.channel, localStorage: previous.storage });
    await rm(directory, { recursive: true, force: true });
  });
  const source = (await readFile(new URL('../lib/personal-readings.ts', import.meta.url), 'utf8'))
    .replace('"./storage"', JSON.stringify(new URL('../lib/storage.ts', import.meta.url).href))
    .replace('"./reading-library"', JSON.stringify(new URL('../lib/reading-library.ts', import.meta.url).href));
  const tabs = [];
  for (const id of ['a', 'b']) {
    const file = join(directory, `${id}.ts`); await writeFile(file, source);
    tabs.push(await import(pathToFileURL(file).href));
  }
  const [tabA, tabB] = tabs;
  const unsubscribeA = tabA.subscribePersonalReadingRemovals(() => {});
  const unsubscribeB = tabB.subscribePersonalReadingRemovals(() => {});
  const settle = async predicate => {
    for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(predicate(), true);
  };
  await tabA.clearPersonalReadings();
  await tabA.savePersonalArticle(article);
  await settle(() => tabB.personalReadingsReplacementEpoch() > 0);
  const generation = await tabB.personalReadingsGeneration();
  const beforeA = tabA.personalReadingsReplacementEpoch(), beforeB = tabB.personalReadingsReplacementEpoch();
  unsubscribeB();
  await tabA.removePersonalArticle(article.id);
  await settle(() => tabB.removedPersonalReadingIds().has(article.id));
  assert.equal(tabA.removedPersonalReadingIds().has(article.id), true);
  assert.equal(tabA.personalReadingsReplacementEpoch(), beforeA);
  assert.equal(tabB.personalReadingsReplacementEpoch(), beforeB, 'single removal must keep the view generation and unrelated import state');
  await assert.rejects(tabB.savePersonalArticle(article, undefined, generation), /文章已被移除/);
  await assert.rejects(tabB.exportPersonalArticle(article), /没有找到/);
  const other = { ...article, id: 'personal-surviving-draft', title: 'Surviving draft' };
  assert.equal(await tabB.savePersonalArticle(other, undefined, generation), other.id);
  dropMessages = true;
  await tabA.removePersonalArticle(other.id);
  assert.equal(tabB.removedPersonalReadingIds().has(other.id), false);
  for (const listener of windowEvents.get('focus') ?? []) listener();
  await settle(() => tabB.removedPersonalReadingIds().has(other.id));
  dropMessages = false;
  const missed = { ...article, id: 'personal-missed-before-refresh' };
  const arriving = { ...article, id: 'personal-arriving-during-refresh', paragraphs: [{ en: article.paragraphs.map(p => p.en).join(' ') + ' Another sentence.' }] };
  arriving.wordCount += 2;
  await tabA.savePersonalArticle(missed);
  await tabA.savePersonalArticle(arriving);
  dropMessages = true;
  await tabA.removePersonalArticle(missed.id);
  dropMessages = false;
  assert.equal(tabB.removedPersonalReadingIds().has(missed.id), false);
  heldMessageId = arriving.id;
  await tabA.removePersonalArticle(arriving.id);
  assert.equal(heldDeliveries.length, 1);
  // Start B's durable read, then deliver Y before its asynchronous open resolves.
  // The read must still recover the previously missed deletion of X.
  windowEvents.get('focus').at(-1)();
  for (const deliver of heldDeliveries) deliver();
  assert.equal(tabB.removedPersonalReadingIds().has(arriving.id), true);
  await settle(() => tabB.removedPersonalReadingIds().has(missed.id));
  await tabA.clearPersonalReadings();
  await settle(() => tabB.personalReadingsReplacementEpoch() > beforeB && tabB.removedPersonalReadingIds().size === 0);
  await tabB.savePersonalArticle(article);
  for (const channel of channels) channel.onmessage?.({ data: { id: article.id, generation } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tabB.removedPersonalReadingIds().has(article.id), false, 'late removal notices from a cleared generation cannot hide a fresh import');
  assert.equal((await tabB.readPersonalArticle(article.id)).id, article.id);
  unsubscribeA();
});

test('committed clears invalidate this reader and hidden independent tabs while retaining stale-save guards', async t => {
  const previous = { window: globalThis.window, document: globalThis.document, channel: globalThis.BroadcastChannel, storage: globalThis.localStorage };
  const channels = [];
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
  globalThis.localStorage = { setItem() {} };
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) queueMicrotask(() => channel.onmessage?.({ data })); }
  };
  const directory = await mkdtemp(join(tmpdir(), 'personal-reading-tabs-'));
  t.after(async () => {
    Object.assign(globalThis, { window: previous.window, document: previous.document, BroadcastChannel: previous.channel, localStorage: previous.storage });
    await rm(directory, { recursive: true, force: true });
  });
  const source = (await readFile(new URL('../lib/personal-readings.ts', import.meta.url), 'utf8'))
    .replace('"./storage"', JSON.stringify(new URL('../lib/storage.ts', import.meta.url).href))
    .replace('"./reading-library"', JSON.stringify(new URL('../lib/reading-library.ts', import.meta.url).href));
  const tabs = [];
  for (const id of ['a', 'b']) {
    const file = join(directory, `${id}.ts`);
    await writeFile(file, source);
    tabs.push(await import(pathToFileURL(file).href));
  }
  const [tabA, tabB] = tabs;
  const notifications = [0, 0];
  const unsubscribeA = tabA.subscribePersonalReadingsReplacement(() => { notifications[0]++; });
  const unsubscribeB = tabB.subscribePersonalReadingsReplacement(() => { notifications[1]++; });
  await new Promise(resolve => setImmediate(resolve));
  await tabA.savePersonalArticle(article);
  const staleGeneration = await tabB.personalReadingsGeneration();
  const beforeA = tabA.personalReadingsReplacementEpoch(), beforeB = tabB.personalReadingsReplacementEpoch();
  await tabA.clearPersonalReadings();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(tabA.personalReadingsReplacementEpoch() > beforeA);
  assert.ok(tabB.personalReadingsReplacementEpoch() > beforeB);
  assert.ok(notifications.every(value => value > 0));
  assert.deepEqual(await tabB.listPersonalReadings(), []);
  await assert.rejects(tabB.readPersonalArticle(article.id));
  await assert.rejects(tabB.savePersonalArticle(article, undefined, staleGeneration), /已在其他页面替换或清空/);
  unsubscribeB();
  const hiddenEpoch = tabB.personalReadingsReplacementEpoch();
  await tabA.clearPersonalReadings();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(tabB.personalReadingsReplacementEpoch() > hiddenEpoch, 'hidden Activity must observe replacements when it subscribes again');
  const freshGeneration = await tabB.personalReadingsGeneration();
  await tabB.savePersonalArticle(article, undefined, freshGeneration);
  assert.equal((await tabB.readPersonalArticle(article.id)).title, article.title);
  unsubscribeA();
});
