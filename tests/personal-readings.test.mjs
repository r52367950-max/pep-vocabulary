import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
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
