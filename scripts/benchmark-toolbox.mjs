// Offline tool benchmark: bounded production lexicon, no provider or network calls.
// node --import ./tests/register.mjs scripts/benchmark-toolbox.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { executeTool } from '../lib/assistant/toolbox.ts';
import { decodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';
import { benchmarkBaseline } from './benchmark-baseline.mjs';

const approved = benchmarkBaseline('toolbox', process.argv[2]);
const js = ts.transpileModule(approved.source('lib/assistant/toolbox.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const before = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).executeTool;
const rows = decodeLexiconIndex(JSON.parse(readFileSync('public/data/v1/index.json', 'utf8')));
const sources = { article: null, files: [], quotes: [] };
const context = { loadLexicon: async () => rows, sources };
const call = (fn, name, args, ctx = context) => fn({ id: 'benchmark', name, arguments: args }, ctx);
const selections = new Map();
for (const row of rows) if (row.flags?.formalReleaseEligible) for (const source of row.sources) {
  selections.set(`${source.bookId}\0${source.unit}`, { book: source.bookId, unit: source.unit, limit: 8 });
}
const queries = [...selections.values(), ...['a', 'book', '学习', 'ＡＰＰ', 'zzzzzzzz'].map(query => ({ query, limit: 8 })),
  { unit: 'Unit 1', limit: 8 }, { book: '不存在' }, { unit: 'Unit 999' }, { query: 'a', limit: 9 }];
for (const args of queries) assert.deepEqual(await call(executeTool, 'search_lexicon', args), await call(before, 'search_lexicon', args));
for (const words of [['book', 'stopped', 'studies', 'a great deal of'], ['appx', 'nonsensewordqwerty'], []]) {
  assert.deepEqual(await call(executeTool, 'lookup_words', { words }), await call(before, 'lookup_words', { words }));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const cases = [];
for (const [name, args, cold] of [
  ['Book and unit, warm index', { book: 'HS-R1', unit: 'Unit 2', limit: 8 }, false],
  ['Broad text search, warm index', { query: 'a', limit: 8 }, false],
  ['Unit across books, warm index', { unit: 'Unit 1', limit: 8 }, false],
  ['First textbook search, cold index', { book: 'HS-R1', unit: 'Unit 2', limit: 8 }, true],
]) {
  const iterations = cold ? 1 : 100;
  for (let run = 0; run < 4; run++) {
    for (const fn of [before, executeTool]) await call(fn, 'search_lexicon', args, cold ? { ...context, loadLexicon: async () => [...rows] } : context);
  }
  const timings = { before: [], after: [] };
  for (let run = 0; run < 15; run++) {
    for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
      // The array is an immutable release identity; a new identity forces index construction.
      const inputRows = cold ? [...rows] : rows;
      const ctx = { ...context, loadLexicon: async () => inputRows };
      const start = performance.now();
      for (let n = 0; n < iterations; n++) await call(label === 'before' ? before : executeTool, 'search_lexicon', args, ctx);
      timings[label].push(performance.now() - start);
    }
  }
  const previous = median(timings.before), current = median(timings.after);
  cases.push({ name, callsPerSample: iterations, beforeMedianMs: previous, afterMedianMs: current,
    reductionPercent: Number(((1 - current / previous) * 100).toFixed(1)), samples: 15, rawSamplesMs: timings });
}
console.log(JSON.stringify({ baseline: approved.revision, node: process.version, measuredAt: new Date().toISOString(), entries: rows.length,
  scope: 'Node tool execution including result serialization, same process, alternating before/after; excludes provider latency and browser rendering',
  equivalentCases: queries.length + 3, sameResults: true, cases }, null, 2));
