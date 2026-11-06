import assert from 'node:assert/strict';
import test from 'node:test';
import { learningContextStore, invalidateLearningContext, setTemporaryMode, refreshLearningContext } from '../lib/learning-context-client.ts';
import { recordLearningActivity, refreshLearningJournal, learningJournalStore, updateLearningJournal, flushLearningActivities } from '../lib/learning-journal-client.ts';
function setup(t) {
  const original=globalThis.fetch;
  setTemporaryMode(false); invalidateLearningContext();
  const f={scope:'a',enabled:true,revision:0,privacy:0,posts:[],failPost:false};
  const journal=()=>({accountScope:f.scope,enabled:f.enabled,revision:f.revision,privacyRevision:f.privacy,days:[]});
  globalThis.fetch=async(url,init={})=>{
    if(String(url).startsWith('/api/learning-memory'))return Response.json({accountScope:f.scope,enabled:true,revision:1,contextVersion:`v-${f.privacy}`,notes:[],recentTopics:[]});
    if(init.method==='POST') {if(f.failPost)throw Error('offline');f.posts.push(JSON.parse(init.body)); f.revision++;}
    if(init.method==='PUT'){f.enabled=JSON.parse(init.body).enabled;f.privacy++;f.revision++;}
    return Response.json(journal());
  };
  t.after(()=>{setTemporaryMode(true);setTemporaryMode(false);globalThis.fetch=original;invalidateLearningContext();});return f;
}
test('activity writes stable ID and account guard without privacy epoch changes',async t=>{
  const f=setup(t);await refreshLearningContext();const epoch=learningContextStore.get().epoch;
  assert.equal(await recordLearningActivity({eventId:'review-1',kind:'vocabulary',title:'复习',counts:{reviewed:2}}),true);
  assert.equal(f.posts[0].eventId,'review-1');assert.equal(f.posts[0].accountScope,'a');assert.equal(f.posts[0].privacyRevision,0);
  assert.equal(learningContextStore.get().epoch,epoch);
});
test('temporary, disabled and stale account completion cannot write',async t=>{
  const f=setup(t); const event={eventId:'x',kind:'study',title:'学习'};
  setTemporaryMode(true);assert.equal(await recordLearningActivity(event),false);
  setTemporaryMode(false);f.enabled=false;assert.equal(await recordLearningActivity(event),false);
  f.enabled=true;f.scope='b';assert.equal(await recordLearningActivity(event,{accountScope:'a'}),false);assert.equal(f.posts.length,0);
});
test('failed sends remain bounded to current tab and are dropped on temporary mode',async t=>{
  const f=setup(t);f.failPost=true;
  assert.equal(await recordLearningActivity({eventId:'retry',kind:'study',title:'学习'}),false);
  assert.equal(learningJournalStore.get().pending,1);
  setTemporaryMode(true);assert.equal(learningJournalStore.get().pending,0);
  setTemporaryMode(false);f.failPost=false;await flushLearningActivities();assert.equal(f.posts.length,0);
});
test('closing journal invalidates privacy context and drops queued activity',async t=>{
  setup(t);await refreshLearningJournal(); const epoch=learningContextStore.get().epoch;
  await updateLearningJournal({enabled:false});assert.ok(learningContextStore.get().epoch>epoch);
  assert.equal(learningJournalStore.get().journal.enabled,false);
});

test('retry revalidates journal privacy revision and never resurrects deleted activity',async t=>{
  const f=setup(t);f.failPost=true;
  await recordLearningActivity({eventId:'old-event',kind:'dictation',title:'听写'});
  assert.equal(learningJournalStore.get().pending,1);
  f.failPost=false;f.privacy++;
  await flushLearningActivities();
  assert.equal(f.posts.length,0);assert.equal(learningJournalStore.get().pending,0);
});
test('editing never silently overwrites a newer journal revision',async t=>{
  const f=setup(t);await refreshLearningJournal();f.revision++;
  await assert.rejects(updateLearningJournal({date:'2026-10-31',summary:'我的总结'}),/日志已更新/);
});

test('temporary round trip while initial policy is pending cannot backfill an old activity',async t=>{
  setup(t);const original=globalThis.fetch;let release;
  const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async(url,init)=>{if(String(url).startsWith('/api/learning-memory'))await gate;return original(url,init);};
  const result=recordLearningActivity({eventId:'late',kind:'study',title:'旧学习'});
  setTemporaryMode(true);setTemporaryMode(false);release();
  assert.equal(await result,false);assert.equal(learningJournalStore.get().pending,0);
});
