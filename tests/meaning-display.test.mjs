import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeEntry, repairMeaning } from '../lib/lexicon.ts';
import { decodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';

test('PDF font fragments disappear without losing different noun and verb senses', () => {
  assert.equal(repairMeaning('滥用；虐待；辱骂 /bjuz/ vt. 滥用；虐待；辱骂'), '滥用；虐待；辱骂');
  assert.equal(repairMeaning('矛盾；冲突 /knflkt/ vi. 冲突；抵触'), '矛盾；冲突 vi. 冲突；抵触');
  assert.equal(repairMeaning('细绳；线 vt. （ strung /r/, strung ）悬挂'), '细绳；线 vt. （ strung , strung ）悬挂');
  assert.equal(repairMeaning('n / vt · 通道；进入；使用'), 'n / vt · 通道；进入；使用');
  assert.equal(repairMeaning('（缩写 a.m./p.m.）上午/下午'), '（缩写 a.m./p.m.）上午/下午');
});

test('affected release entries become readable while stable data and source evidence stay intact', () => {
  const entries=decodeLexiconIndex(JSON.parse(readFileSync(new URL('../public/data/v1/index.json',import.meta.url),'utf8')));
  const affected=entries.filter(row=>/[\uE000-\uF8FF]/.test(row.chineseCore));
  for(const original of affected){
    const snapshot=structuredClone(original);const fixed=normalizeEntry(original);
    assert.doesNotMatch(fixed.chineseCore,/[\uE000-\uF8FF]/,original.headword);
    assert.ok(fixed.chineseCore.trim(),original.headword);
    assert.equal(fixed.id,original.id);assert.deepEqual(fixed.sources,original.sources);
    assert.deepEqual(original,snapshot,'original evidence is never rewritten');
    assert.strictEqual(normalizeEntry(fixed),fixed,'normalization is idempotent');
  }
  const band=entries.find(row=>row.headword==='band');
  assert.equal(normalizeEntry({...band,chineseCore:'乐队；带子 rap​ /rp/ n. 快速敲击；说唱音乐'}).chineseCore,'乐队；带子');
  const clean={...band,chineseCore:'乐队；带子；频带'};
  assert.strictEqual(normalizeEntry(clean),clean,'a clean future release is not truncated');
});
