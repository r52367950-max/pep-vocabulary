import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { runAssistant, readCached, clearAssistantCache, assistantCacheSize, profileSnapshot } from '../lib/ai-client.ts';
import { learningContextStore, refreshLearningContext, setTemporaryMode, setLocalProfileAllowed, localProfileAllowed, saveLearningMemory, invalidateLearningContext } from '../lib/learning-context-client.ts';

function setup(t) {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) };
  setTemporaryMode(false); invalidateLearningContext();
  const fixture = { memory: { accountScope:'account-a', revision:1, enabled:true, notes:[{id:'note-a',text:'Use short explanations.'}], recentTopics:[],contextVersion:'model-v1' }, modelCalls: [], reads: [], afterModel: null };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/learning-memory')) {
      fixture.reads.push(String(url));
      if (init.method === 'PUT') {
        const next = JSON.parse(init.body);
        fixture.memory = {...next, revision:fixture.memory.revision+1};
      }
      return Response.json(String(url).includes('temporary=1') ? {...fixture.memory,enabled:false,notes:[],recentTopics:[]} : fixture.memory);
    }
    const body = JSON.parse(init.body);
    fixture.modelCalls.push(body);
    const response = Response.json({ ok:true, model:'test-model', result:{summary:`answer-${fixture.modelCalls.length}`}, accountScope:fixture.memory.accountScope, contextRevision:fixture.memory.revision });
    fixture.afterModel?.();
    return response;
  };
  t.after(() => { globalThis.fetch=originalFetch; globalThis.localStorage=originalStorage; setTemporaryMode(false); invalidateLearningContext(); });
  return fixture;
}

test('cache isolates accounts, revisions and model context versions; unknown policy never reads legacy output', async t => {
  const f=setup(t); await clearAssistantCache();
  const input={wordId:'example'};
  await runAssistant('explain',input);
  assert.ok((await runAssistant('explain',input)).cachedAt);
  assert.equal(f.modelCalls.length,1);
  f.memory={...f.memory,revision:2,notes:[]};
  assert.equal((await runAssistant('explain',input)).cachedAt,null);
  f.memory={...f.memory,contextVersion:'model-v2'};
  assert.equal((await runAssistant('explain',input)).cachedAt,null);
  f.memory={...f.memory,accountScope:'account-b'};
  assert.equal((await runAssistant('explain',input)).cachedAt,null);
  assert.equal(f.modelCalls.length,4);
  globalThis.fetch=async()=>{ throw new Error('offline'); };
  assert.equal(await readCached('explain',input),null);
  await assert.rejects(runAssistant('explain',input),e=>e.code==='context_unavailable');
});

test('local history requires scope-specific opt-in; same-count note edits invalidate profile output', async t => {
  const f=setup(t); await clearAssistantCache();
  const first={date:'today',notes:[{id:'one',text:'first note'}]};
  await runAssistant('explain',{wordId:'same'},{profile:first});
  assert.equal(f.modelCalls[0].profile,undefined);
  setLocalProfileAllowed(true);
  await runAssistant('explain',{wordId:'same'},{profile:first});
  assert.deepEqual(f.modelCalls[1].profile,first);
  const changed={...first,notes:[{id:'one',text:'edited note'}]};
  await runAssistant('explain',{wordId:'same'},{profile:changed});
  assert.deepEqual(f.modelCalls[2].profile,changed);
  f.memory={...f.memory,accountScope:'account-b'};
  await runAssistant('explain',{wordId:'same'},{profile:first});
  assert.equal(f.modelCalls[3].profile,undefined);
  assert.equal(localProfileAllowed(learningContextStore.get().memory),false);
  assert.equal(profileSnapshot(1,'same',()=>changed),changed);
});

test('paused and temporary modes omit profiles; temporary does not persist model cache or memory', async t => {
  const f=setup(t); await clearAssistantCache();
  await refreshLearningContext(); setLocalProfileAllowed(true);
  f.memory={...f.memory,enabled:false,revision:2};
  await runAssistant('explain',{wordId:'paused'},{profile:{notes:['private']}});
  assert.equal(f.modelCalls[0].profile,undefined);
  await clearAssistantCache();
  setTemporaryMode(true);
  await runAssistant('explain',{wordId:'temporary'},{profile:{notes:['private']}});
  await runAssistant('explain',{wordId:'temporary'});
  assert.equal(f.modelCalls.at(-1).temporary,true);
  assert.equal(f.modelCalls.at(-2).profile,undefined);
  assert.ok(f.reads.at(-1).includes('temporary=1'));
  assert.equal(await assistantCacheSize(),0);
  await assert.rejects(saveLearningMemory(f.memory),/临时练习不会保存/);
});

test('a remote deletion during model generation discards its response and skips cache', async t => {
  const f=setup(t); await clearAssistantCache();
  f.afterModel=()=>{f.memory={...f.memory,revision:2,notes:[]};};
  await assert.rejects(runAssistant('explain',{wordId:'inflight'}),e=>e.code==='aborted');
  assert.equal(await assistantCacheSize(),0);
});

test('account change between editor read and save cannot write into the replacement account',async t=>{
  const f=setup(t);
  const old=await refreshLearningContext();
  f.memory={...f.memory,accountScope:'account-b'};
  await assert.rejects(saveLearningMemory({...old,notes:[]}),/账户或记忆已更新/);
  assert.equal(f.memory.revision,1);
  assert.equal(f.memory.notes.length,1);
});

test('concurrent panels share metadata read without one cancellation aborting the other',async t=>{
  const f=setup(t);
  let release;
  globalThis.fetch=()=>new Promise(resolve=>{release=()=>resolve(Response.json(f.memory));});
  const controller=new AbortController();
  const first=refreshLearningContext(controller.signal);
  const second=refreshLearningContext();
  const rejected=assert.rejects(first,e=>e.name==='AbortError');
  controller.abort();
  release();
  await rejected;
  assert.equal((await second).accountScope,'account-a');
});
