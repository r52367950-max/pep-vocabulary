import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The reviewed production component is rendered with the same fixed journal in
// both versions. This counts initial rendered elements, not browser latency.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = 'c2362d007d368efdcee984f691d0f29c1bb4a826';
const componentPath = 'components/studio/voice/learning-memory.tsx';
const memory = { accountScope: 'test-account', enabled: true, notes: [], recentTopics: [], revision: 1, contextVersion: 'test' };
const journal = { accountScope: 'test-account', enabled: true, revision: 1, privacyRevision: 1, days: Array.from({ length: 30 }, (_, day) => ({
  date: `2026-10-${String(day + 1).padStart(2, '0')}`, summary: '完成词汇和阅读练习。', summarySource: 'facts',
  events: Array.from({ length: 3 }, (_, event) => ({ eventId: `${day}-${event}`, title: '词汇练习', summary: '复习并订正本次作答。' })),
})) };
const contextFixture = `const snapshot = ${JSON.stringify({ memory, temporary: false, epoch: 0, error: '' })};
export const learningContextStore = { subscribe: () => () => {}, get: () => snapshot, getServerSnapshot: () => snapshot };
export const localProfileAllowed = () => false;
export const setLocalProfileAllowed = async () => {};
export const refreshLearningContext = async () => snapshot.memory;
export const saveLearningMemory = async () => {};
export const setTemporaryMode = () => {};`;
const journalFixture = `const snapshot = ${JSON.stringify({ journal, error: '', pending: 0 })};
export const learningJournalStore = { subscribe: () => () => {}, get: () => snapshot, getServerSnapshot: () => snapshot };
export const refreshLearningJournal = async () => snapshot.journal;
export const updateLearningJournal = async () => {};
export const deleteLearningJournal = async () => {};`;
const controls = { memory, error: '', busy: false, load() {}, save() {}, remember() {}, temporary: false, setTemporary() {}, localProfileEnabled: false, setProfileAllowed() {} };
async function inspect(source) {
  const built = await build({
    stdin: { contents: source, loader: 'tsx', resolveDir: root, sourcefile: componentPath },
    bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false, jsx: 'automatic',
    plugins: [{ name: 'fixed-learning-records', setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/learning-(context|journal)-client$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.includes('journal') ? journalFixture : contextFixture, loader: 'js' }));
    } }],
  });
  const compiledModule = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
  const html = renderToStaticMarkup(React.createElement(compiledModule.exports.LearningMemoryPanel, { controls }));
  const region = html.match(/<section aria-label="自动学习日志">[\s\S]*?<\/section>/)?.[0];
  if (!region) throw new Error('Learning journal region missing');
  return {
    elements: [...region.matchAll(/<[a-z][a-z0-9]*(?:\s|>)/g)].length,
    summaryInputs: [...region.matchAll(/<textarea\b/g)].length,
    htmlBytes: Buffer.byteLength(region),
  };
}
const previous = execFileSync('git', ['show', `${baseline}:${componentPath}`], { cwd: root, encoding: 'utf8' });
const current = await readFile(path.join(root, componentPath), 'utf8');
const report = {
  description: 'Collapsed learning journal, identical fixture with 30 days and 90 activities',
  method: 'React renderToStaticMarkup with fixed learning stores; rendered element and textarea counts',
  baseline,
  before: await inspect(previous),
  after: await inspect(current),
  scope: 'Initial collapsed content only. Browser timing and expanded interaction are separate checks.',
};
await writeFile(new URL('./learning-memory-performance.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
