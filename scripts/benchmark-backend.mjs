import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { resolveLexiconEvidence } from '../lib/assistant/core.ts';
import { decodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';
import { benchmarkBaseline } from './benchmark-baseline.mjs';

// Benchmark the exact old resolver, independently of unrelated module changes.
const approved = benchmarkBaseline('backend', process.argv[2]);
const baseline = approved.revision;
const source = approved.source('lib/assistant/core.ts');
const start = source.indexOf('export function resolveLexiconEvidence');
const end = source.indexOf('\nfunction privateIpv4', start);
if (start < 0 || end < 0) throw new Error('Baseline resolver not found');
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const previous = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).resolveLexiconEvidence;
const rows = decodeLexiconIndex(JSON.parse(readFileSync('public/data/v1/index.json', 'utf8')));
const ids = rows.filter((row) => row.flags?.formalReleaseEligible).slice(0, 6).map((row) => row.id);
const expected = JSON.stringify(previous(rows, ids));
if (JSON.stringify(resolveLexiconEvidence(rows, ids)) !== expected) throw new Error('Resolver results differ');
function median(fn) {
  for (let i = 0; i < 50; i++) fn();
  const samples = Array.from({ length: 7 }, () => {
    const begin = performance.now();
    for (let i = 0; i < 1000; i++) fn();
    return performance.now() - begin;
  }).sort((a, b) => a - b);
  return Number(samples[3].toFixed(3));
}
console.log(JSON.stringify({ baseline, node: process.version, entries: rows.length, requestedIds: ids.length,
  method: '50 warmups; median of 7 runs, 1000 valid evidence resolutions per run; no network or provider inference',
  resolver_1000_calls_ms: { before: median(() => previous(rows, ids)), after: median(() => resolveLexiconEvidence(rows, ids)) },
  sameResult: true }, null, 2));
