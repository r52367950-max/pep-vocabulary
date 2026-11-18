import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { GET, POST, PUT, DELETE } from '../app/api/learning-journal/route.ts';
import { memoryMetadata, resolveLearningContext } from '../lib/learning-memory/context.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { saveLearningMemory } from '../lib/learning-memory/store.ts';
import { dateInZone } from '../lib/learning-journal/input.ts';
function setup() { const db=new DatabaseSync(':memory:'); for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(`drizzle/${f}`,'utf8')); env.DB=sqliteD1(db); requestHeaders.set('oai-authenticated-user-email','journal-owner@example.test'); return db; }
const req=(method='GET',body,query='',extra={})=>new Request(`https://app.test/api/learning-journal${query}`,{method,headers:{'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
const view=async()=>await (await GET(req())).json();
const event=(metadata,extra={})=>({accountScope:metadata.accountScope,privacyRevision:metadata.privacyRevision,eventId:'study:one',kind:'vocabulary',title:'复习 Unit 1',summary:'完成词汇练习，记录作答而非推断掌握。',refIds:['unit-1'],counts:{reviewed:3,correct:2,aided:1},occurredAt:new Date(Date.now()-1000).toISOString(),timezone:'Asia/Shanghai',...extra});
async function ok(response) { assert.equal(response.status,200,await response.clone().text()); return response.json(); }

test('journal is empty without activity, account isolated, authenticates and never calls AI',async t=>{
  setup(); const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);globalThis.fetch=()=>{throw Error('No AI calls for journal');};
  const initial=await view();assert.deepEqual(initial.days,[]);assert.equal(initial.enabled,true);
  requestHeaders.delete('oai-authenticated-user-email');assert.equal((await GET(req())).status,401);assert.equal((await POST(req('POST',event(initial)))).status,401);
  requestHeaders.set('oai-authenticated-user-email','journal-owner@example.test');
  assert.equal((await POST(req('POST',event(initial),'',{origin:'https://other.test'}))).status,403);
  const saved=await ok(await POST(req('POST',event(initial))));assert.equal(saved.days.length,1);assert.equal(saved.days[0].events[0].source,'learning_activity');
  requestHeaders.set('oai-authenticated-user-email','other@example.test');assert.deepEqual((await view()).days,[]);
  assert.equal((await POST(req('POST',event(initial)))).status,409);
});

test('parallel retries count once, changed payload conflicts, auto additions do not change privacy context',async()=>{
  const db=setup(), initial=await view(), key=await authenticatedUserKey(), before=await memoryMetadata(key), body=event(initial);
  const results=await Promise.all([POST(req('POST',body)),POST(req('POST',body))]);assert.deepEqual(results.map(r=>r.status),[200,200]);
  const state=await view();assert.equal(state.revision,1);assert.equal(state.privacyRevision,0);assert.equal(state.days[0].eventCount,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM learning_journal_events').get().n,1);
  const after=await memoryMetadata(key);assert.equal(after.contextVersion,before.contextVersion);assert.equal(after.revision,before.revision);assert.equal(after.journalRevision,1);
  assert.equal((await POST(req('POST',{...body,title:'changed'}))).status,409);
  assert.match(state.days[0].summary,/1 项学习活动/);assert.match(state.days[0].summary,/Unit 1/);
});

test('timezone grouping handles midnight and DST with original event timezone retained',async()=>{
  assert.equal(dateInZone('2026-10-30T23:30:00Z','Asia/Shanghai'),'2026-10-31');
  assert.equal(dateInZone('2026-03-08T06:59:00Z','America/New_York'),'2026-03-08');
  assert.equal(dateInZone('2026-03-08T07:01:00Z','America/New_York'),'2026-03-08');
  setup();const initial=await view(),at=new Date(Date.now()-12*3600000).toISOString();
  const saved=await ok(await POST(req('POST',event(initial,{occurredAt:at,timezone:'America/Los_Angeles'}))));
  assert.equal(saved.days[0].date,dateInZone(at,'America/Los_Angeles'));assert.equal(saved.days[0].events[0].timezone,'America/Los_Angeles');
  assert.equal((await POST(req('POST',event(initial,{timezone:'Not/A_Zone'})))).status,400);
});

test('event and day deletion remove content, invalidate privacy and suppress offline resurrection',async()=>{
  const db=setup(),initial=await view(),body=event(initial),saved=await ok(await POST(req('POST',body))),key=await authenticatedUserKey(),before=await memoryMetadata(key);
  const removed=await ok(await DELETE(req('DELETE',{accountScope:saved.accountScope,revision:saved.revision,eventId:body.eventId})));
  assert.deepEqual(removed.days,[]);assert.notEqual((await memoryMetadata(key)).contextVersion,before.contextVersion);
  const tombstone=db.prepare('SELECT title,summary,ref_ids,counts,deleted,content_hash FROM learning_journal_events').get();assert.deepEqual({...tombstone},{title:'',summary:'',ref_ids:'[]',counts:'{}',deleted:1,content_hash:''});
  assert.equal((await ok(await POST(req('POST',{...body,privacyRevision:removed.privacyRevision})))).ignored,'deleted');
  const second=await ok(await POST(req('POST',event(removed,{eventId:'study:two'}))));
  const date=second.days[0].date;
  const dayRemoved=await ok(await DELETE(req('DELETE',{accountScope:second.accountScope,revision:second.revision,date})));
  const delayed=await ok(await POST(req('POST',event(dayRemoved,{eventId:'study:offline',occurredAt:body.occurredAt}))));assert.equal(delayed.accepted,false);assert.deepEqual(delayed.days,[]);
  const future=await ok(await POST(req('POST',event(dayRemoved,{eventId:'study:new',occurredAt:new Date(Date.now()+1000).toISOString()}))));assert.equal(future.accepted,true);assert.equal(future.days[0].eventCount,1);
});

test('edits are CAS protected, provenance stays visible and replay does not overwrite edits',async()=>{
  setup();const initial=await view(),body=event(initial),saved=await ok(await POST(req('POST',body)));
  const changed=await ok(await PUT(req('PUT',{accountScope:saved.accountScope,revision:saved.revision,eventId:body.eventId,title:'订正后的路径',summary:'只完成两词。'})));
  assert.equal(changed.days[0].events[0].edited,true);assert.match(changed.days[0].factsSummary,/订正/);
  const replay=await ok(await POST(req('POST',{...body,privacyRevision:changed.privacyRevision})));assert.equal(replay.days[0].events[0].title,'订正后的路径');
  assert.equal((await PUT(req('PUT',{accountScope:changed.accountScope,revision:saved.revision,date:changed.days[0].date,summary:'stale'}))).status,409);
  const edited=await ok(await PUT(req('PUT',{accountScope:changed.accountScope,revision:changed.revision,date:changed.days[0].date,summary:'今天主要复习了易错词。'})));
  assert.equal(edited.days[0].summarySource,'edited');assert.equal(edited.days[0].summary,'今天主要复习了易错词。');
});

test('recording switch is independent, temporary writes are rejected and paused queues cannot replay after re-enable',async()=>{
  setup();const initial=await view(),key=await authenticatedUserKey();
  await saveLearningMemory(key,{revision:0,enabled:false,notes:[],recentTopics:[]});
  const saved=await ok(await POST(req('POST',event(initial))));assert.equal(saved.accepted,true,'record while personalization is off');
  const context=await resolveLearningContext(key,{});assert.equal(context.memory.learningJournal,undefined);
  assert.equal((await POST(req('POST',event(saved,{eventId:'temp',temporary:true})))).status,409);
  const paused=await ok(await PUT(req('PUT',{accountScope:saved.accountScope,revision:saved.revision,enabled:false})));
  const pausedEvent=event(paused,{eventId:'queued'});const ignored=await ok(await POST(req('POST',pausedEvent)));assert.equal(ignored.ignored,'disabled');
  const resumed=await ok(await PUT(req('PUT',{accountScope:paused.accountScope,revision:paused.revision,enabled:true})));
  assert.equal((await POST(req('POST',pausedEvent))).status,409);
  const replay=await ok(await POST(req('POST',{...pausedEvent,privacyRevision:resumed.privacyRevision})));assert.equal(replay.accepted,false);
  const temp=await ok(await GET(req('GET',undefined,'?temporary=1')));assert.deepEqual(temp.days,[]);assert.equal(temp.enabled,false);
  await saveLearningMemory(key,{revision:1,enabled:true,notes:[],recentTopics:[]});
  assert.equal((await resolveLearningContext(key,{})).memory.learningJournal.length,1);
  assert.equal((await resolveLearningContext(key,{temporary:true})).memory.learningJournal,undefined);
});

test('daily context retains bounded material references and edits while recording is paused; deletion removes sources',async()=>{
  setup();const initial=await view(),key=await authenticatedUserKey();
  const saved=await ok(await POST(req('POST',event(initial,{refIds:['pep-word-one','reading:city','pep-word-one']}))));
  const edited=await ok(await PUT(req('PUT',{accountScope:saved.accountScope,revision:saved.revision,date:saved.days[0].date,summary:'复习一个词并读了城市文章。'})));
  const paused=await ok(await PUT(req('PUT',{accountScope:edited.accountScope,revision:edited.revision,enabled:false})));
  const context=(await resolveLearningContext(key,{})).memory.learningJournal;
  assert.deepEqual(context[0].refIds,['pep-word-one','reading:city']);
  assert.equal(context[0].source,'user_edited_daily_summary');assert.equal(context[0].summary,'复习一个词并读了城市文章。');
  assert.deepEqual(context[0].sourceEventIds,['study:one']);
  const deleted=await ok(await DELETE(req('DELETE',{accountScope:paused.accountScope,revision:paused.revision,date:paused.days[0].date})));
  assert.deepEqual((await resolveLearningContext(key,{})).memory.learningJournal,[]);
  assert.deepEqual(deleted.days,[]);
});

test('daily source references are deduplicated and capped at thirty',async()=>{
  setup();const initial=await view(),key=await authenticatedUserKey();
  const first=await ok(await POST(req('POST',event(initial,{refIds:Array.from({length:30},(_,i)=>`word-${i}`)}))));
  await ok(await POST(req('POST',event(first,{eventId:'study:references',refIds:Array.from({length:30},(_,i)=>`word-${i+10}`)}))));
  const refs=(await resolveLearningContext(key,{})).memory.learningJournal[0].refIds;
  assert.equal(refs.length,30);assert.equal(new Set(refs).size,30);assert.ok(refs.every(ref=>/^word-\d+$/.test(ref)));
});


test('browser client normalizes optional fields against real journal routes and skips existing stable IDs',async t=>{
  setup();
  const { GET: memoryGET } = await import('../app/api/learning-memory/route.ts');
  const { recordLearningActivity } = await import('../lib/learning-journal-client.ts');
  const { invalidateLearningContext, setTemporaryMode } = await import('../lib/learning-context-client.ts');
  const original=globalThis.fetch;let posts=0;
  setTemporaryMode(false);invalidateLearningContext();
  globalThis.fetch=async(url,init={})=>{
    const request=new Request(`https://app.test${url}`,init);
    if(String(url).startsWith('/api/learning-memory'))return memoryGET(request);
    if(init.method==='POST'){posts++;return POST(request);}
    return GET(request);
  };
  t.after(()=>{setTemporaryMode(true);setTemporaryMode(false);globalThis.fetch=original;invalidateLearningContext();});
  assert.equal(await recordLearningActivity({eventId:'reading:daily',kind:'reading',title:'阅读练习',refIds:['reading-one']}),true);
  let state=await view();
  assert.deepEqual(state.days[0].events[0].counts,{});
  assert.equal(state.days[0].events[0].summary,'');
  assert.equal(await recordLearningActivity({eventId:'discussion:one',kind:'assistant',title:'学习复盘',summary:'完成复盘',counts:{tasks:1}}),true);
  state=await view();assert.deepEqual(state.days[0].events.find(e=>e.eventId==='discussion:one').refIds,[]);
  const before=posts;
  assert.equal(await recordLearningActivity({eventId:'reading:daily',kind:'reading',title:'阅读练习',occurredAt:new Date(Date.now()+500).toISOString()}),true);
  assert.equal(posts,before);assert.equal((await view()).days[0].eventCount,2);
  await ok(await DELETE(req('DELETE',{accountScope:state.accountScope,revision:state.revision,eventId:'reading:daily'})));
  await recordLearningActivity({eventId:'reading:daily',kind:'reading',title:'阅读练习'});
  assert.equal((await view()).days[0].eventCount,1);
});

test('ignored offline activity preserves the visible day and its timestamp after recording resumes', async () => {
  const db = setup();
  const initial = await view();
  const oldEvent = event(initial);
  const saved = await ok(await POST(req('POST', oldEvent)));
  const toggle = (state, enabled) => PUT(req('PUT', { accountScope: state.accountScope, revision: state.revision, enabled })).then(ok);
  const resumed = await toggle(await toggle(saved, false), true);
  db.prepare('UPDATE learning_journal_days SET updated_at=?').run('2026-01-01T00:00:00Z');
  const current = await view();
  const replay = await ok(await POST(req('POST', { ...oldEvent, privacyRevision: resumed.privacyRevision, eventId: 'offline:delayed' })));
  assert.equal(replay.ignored, 'excluded');
  assert.deepEqual(replay.days, current.days);
  assert.equal(replay.revision, current.revision);
});

test('day previews and assistant sources preserve ordering, full-day references and account isolation', async () => {
  setup();
  const initial = await view();
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const activity = (i, meta = initial) => event(meta, {
    eventId: 'event:' + String(i).padStart(2, '0'), occurredAt, refIds: ['ref-' + i],
  });
  for (let i = 0; i < 24; i++) await ok(await POST(req('POST', activity(i))));
  const beforeDelete = await view();
  await ok(await DELETE(req('DELETE', { accountScope: initial.accountScope, revision: beforeDelete.revision, eventId: 'event:22' })));
  requestHeaders.set('oai-authenticated-user-email', 'second-journal@example.test');
  const other = await view();
  await ok(await POST(req('POST', { ...activity(23, other), title: '其他账号', refIds: ['other-ref'] })));
  requestHeaders.set('oai-authenticated-user-email', 'journal-owner@example.test');
  const [day] = (await view()).days;
  const orderedIds = Array.from({ length: 24 }, (_, i) => activity(23 - i).eventId).filter(id => id !== 'event:22');
  assert.deepEqual(day.events.map(e => e.eventId), orderedIds.slice(0, 20));
  assert.equal(day.eventCount, 23);
  assert.equal(day.eventsTruncated, true);
  assert.ok(day.events.every(e => e.title !== '其他账号'));
  const [context] = (await resolveLearningContext(await authenticatedUserKey(), {})).memory.learningJournal;
  assert.deepEqual(context.sourceEventIds, orderedIds.slice(0, 8));
  assert.deepEqual(context.refIds, Array.from({ length: 24 }, (_, i) => 'ref-' + i).filter(id => id !== 'ref-22').sort());
});
