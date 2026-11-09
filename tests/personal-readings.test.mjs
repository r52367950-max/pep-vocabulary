import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPersonalReadings, savePersonalArticle, readPersonalArticle, listPersonalReadings, removePersonalArticle } from '../lib/personal-readings.ts';
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
