import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// Actual message components and React DOM; only the store is replaced by a
// controlled context to count historical RichText work during a single reveal.
// This isolates the rendering regression, not whole-app latency or INP.
const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../..');
const component = resolve(root, 'components/studio/companion/components/messages.tsx');
const baselineRevision = 'a9bb92642780cee06bb1d990a9a807536a6904de';
const baseline = execFileSync('git', ['--no-replace-objects', 'show', `${baselineRevision}:components/studio/companion/components/messages.tsx`], { cwd: root, encoding: 'utf8' });
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MessageList } from './components/studio/companion/components/messages';
import { Context } from 'review-store';
const noop = () => {};
const id = 'pep-1e3e7e41accdc5f7';
let words = new Map([[id, {id, headword:'abandon', flags:{formalReleaseEligible:true}, sources:[{bookId:'HS-S3',volume:'QA volume',unit:'QA unit',printedPage:109}]}]]);
const assistant = (key, text, status='done') => ({id:key, role:'assistant', at:1800000000000, status, blocks:[{type:'text',text}], revealed:text.length, request:{model:'gpt-6.1-sol',reasoning:{effort:'medium'}},provenance:{evidenceIds:[id]}});
const history = Array.from({length:59}, (_, i) => [
 {id:'user-'+i, role:'user', at:1800000000000, text:'QA question '+i, quotes:[], attachments:[], via:'text'},
 assistant('history-'+i, 'history-answer-'+i+' '+('A synthetic explanation with several ordinary words. '.repeat(30)))
]).flat();
const initial = [...history, {id:'user-current',role:'user',at:1800000000000,text:'Current question',quotes:[],attachments:[],via:'text'}, assistant('current','current answer','streaming')];
let messages=initial;
const root=createRoot(document.getElementById('root'));
let serial=0;
function render(){flushSync(()=>root.render(<Context.Provider value={{words,send:noop,dispatch:noop,runAction:noop,state:{serial:serial++}}}><MessageList messages={messages} conversationId="qa" place="full" /></Context.Provider>));}
const split=String.prototype.split;
window.counts={history:0,current:0};
String.prototype.split=function(separator,...rest){
 if(separator instanceof RegExp && separator.source==='\\\\n{2,}') {
   if(this.startsWith('history-answer-')) window.counts.history++;
   else if(this.startsWith('current answer')) window.counts.current++;
 }
 return split.call(this,separator,...rest);
};
render();
window.ready=true;
window.measure=async()=>{
 window.counts={history:0,current:0};
 const updateMs=[];
 for(let i=1;i<=20;i++){
  messages=[...messages.slice(0,-1),assistant('current','current answer '+('new words '.repeat(i)),'streaming')];
  const start=performance.now();render();updateMs.push(performance.now()-start);
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const progressive={...window.counts};
 const initialSourceCount=document.querySelectorAll('.ai-provenance').length;
 window.counts={history:0,current:0};
 words=new Map();render();
 const vocabularyRefresh={...window.counts,sourceCount:document.querySelectorAll('.ai-provenance').length};
 const currentText=document.querySelector('.message-assistant:last-child .ai-text').textContent;
 return {progressive,updates:20,updateMs,initialSourceCount,vocabularyRefresh,currentText,assistantRows:document.querySelectorAll('.message-assistant').length};
};
`;
async function bundle(source) {
  const built = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'controlled-store', setup(api) {
    api.onResolve({ filter: /^(?:review-store|\.\.\/store)$/ }, () => ({ path: 'review-store', namespace: 'controlled-store' }));
    api.onLoad({ filter: /.*/, namespace: 'controlled-store' }, () => ({ contents: 'import {createContext,useContext} from "react"; export const Context=createContext(null); export const useStore=()=>useContext(Context);', loader: 'js', resolveDir: root }));
    api.onLoad({ filter: /components\/studio\/companion\/components\/messages\.tsx$/ }, () => ({ contents: source, loader: 'tsx', resolveDir: dirname(component) }));
  } }] });
  return built.outputFiles[0].text;
}
const sources = { baseline, current: await readFile(component, 'utf8') };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const runs = [];
try {
  const bundles = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, source]) => [name, await bundle(source)])));
  for (let round = 1; round <= 3; round++) for (const variant of ['baseline', 'current']) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ type: 'module', content: bundles[variant] });
    await page.waitForFunction(() => window.ready);
    const result = await page.evaluate(() => window.measure());
    assert.deepEqual(errors, []);
    assert.equal(result.assistantRows, 60);
    assert.equal(result.initialSourceCount, 60);
    assert.equal(result.vocabularyRefresh.sourceCount, 0, 'Changed vocabulary must invalidate stale provenance');
    assert.equal(result.vocabularyRefresh.history, 59);
    assert.equal(result.progressive.current, 20);
    assert.equal(result.progressive.history, variant === 'baseline' || process.argv.includes('--expect-regression') ? 59 * 20 : 0);
    assert.equal(result.currentText, 'current answer ' + 'new words '.repeat(20));
    runs.push({ variant, round, ...result });
    await page.close();
  }
} finally {
  await browser.close();
  const measured = { baselineRevision, scope: 'Production React DOM with actual MessageList/RichText/AiProvenance, 120 messages (59 historical assistant answers), 20 updates spaced at 20 ms. Controlled store and synthetic answers. Timings measure synchronous commit work only, exclude app/network/real-provider latency; not an INP benchmark.', runs };
  await writeFile(resolve(out, process.argv.includes('--expect-regression') ? 'stream-render-before.json' : 'stream-render-results.json'), JSON.stringify(measured, null, 2) + '\n');
}
console.log(JSON.stringify(runs.map(({variant,round,progressive,updateMs})=>({variant,round,progressive,commitTotalMs:updateMs.reduce((a,b)=>a+b,0)})), null, 2));
