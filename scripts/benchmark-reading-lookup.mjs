import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { matchReadingWords } from '../lib/reading-library.ts';
import { decodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';
const baseline = process.argv[2] || '0b8610b';
const source = execFileSync('git', ['show', `${baseline}:lib/reading-library.ts`], { encoding: 'utf8' });
const js = ts.transpileModule(source.slice(source.indexOf('const common =')), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const before = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).matchReadingWords;
const index = decodeLexiconIndex(JSON.parse(readFileSync('public/data/v1/index.json', 'utf8')));
const articles = readdirSync('public/readings/v1/articles').filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(`public/readings/v1/articles/${f}`, 'utf8')));
for (const article of articles) {
  if (JSON.stringify(before(article.paragraphs, index, article.targets)) !== JSON.stringify(matchReadingWords(article.paragraphs, index, article.targets))) throw new Error(`Changed result: ${article.id}`);
}
function median(run) {
  for (let i = 0; i < 4; i++) run();
  const values = Array.from({ length: 9 }, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a,b) => a-b);
  return Number(values[4].toFixed(3));
}
const measure = fn => median(() => { for (let i = 0; i < 4; i++) for (const article of articles) fn(article.paragraphs, index, article.targets); });
const previous = measure(before), current = measure(matchReadingWords);
console.log(JSON.stringify({ baseline, node: process.version, entries: index.length, articles: articles.length, callsPerSample: articles.length * 4, method: '4 warmups; median of 9 samples, 4 full reading-corpus passes per sample; same Node process, no network or provider latency', sameResults: true, matchingMs: { before: previous, after: current }, reductionPercent: Number(((1-current/previous)*100).toFixed(1)), illustrationCache: { maxEntries: 48, maxPixels: 12000000, rgbaBytesAtPixelBudget: 48000000 } }, null, 2));
