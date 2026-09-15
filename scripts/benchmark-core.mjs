import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import '../tests/register.mjs';
const base = process.argv[2] || '3b12529';
const index = JSON.parse(readFileSync('public/data/v1/index.json', 'utf8'));
const manifest = JSON.parse(readFileSync('public/data/v1/manifest.json', 'utf8'));
async function load(path, baseline) {
  if (!baseline) return import(pathToFileURL(resolve(path)).href);
  const source = baseline ? execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' }) : readFileSync(path, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
function median(fn) {
  for (let i = 0; i < 20; i++) fn();
  return Array.from({ length: 9 }, () => { const start = performance.now(); for (let i = 0; i < 100; i++) fn(); return performance.now() - start; }).sort((a,b) => a-b)[4];
}
const before = await load('lib/questions.ts', true), after = await load('lib/questions.ts', false);
const entry = index.find(e => e.headword === 'apple') || index[0];
const result = { baseline: base, node: process.version, entries: index.length, choice_100_calls_median_ms: {
  before: median(() => before.buildQuestion(entry, undefined, 'listening-choice', index)),
  after: median(() => after.buildQuestion(entry, undefined, 'listening-choice', index)),
}, concurrent_20_index_loads: {} };
const originalFetch = globalThis.fetch;
try {
  for (const [label, baseline] of [['before', true], ['after', false]]) {
    let count = 0;
    globalThis.fetch = async url => { count++; await new Promise(resolve => setImmediate(resolve)); return Response.json(url.endsWith('index.json') ? index : manifest); };
    const lexiconModule = await load('lib/lexicon.ts', baseline);
    await Promise.all(Array.from({ length: 20 }, () => lexiconModule.loadLexicon()));
    result.concurrent_20_index_loads[label] = count;
  }
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify(result, null, 2));
