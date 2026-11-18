import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { GET, POST, PUT, DELETE } from '../app/api/learning-journal/route.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { resolveLearningContext } from '../lib/learning-memory/context.ts';
import { recordLearningActivity } from '../lib/learning-journal-client.ts';
import { invalidateLearningContext, setTemporaryMode } from '../lib/learning-context-client.ts';
const migration='0010_learning_journal_privacy.sql';
function setup(legacy=false) {
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) if(!legacy||f!==migration) db.exec(readFileSync(`drizzle/${f}`,'utf8'));
  env.DB=sqliteD1(db);requestHeaders.set('oai-authenticated-user-email','journal-privacy@example.test');return db;
}
const req=(method='GET',body)=>new Request('https://app.test/api/learning-journal',{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const view=async()=>await (await GET(req())).json();
async function ok(r){assert.equal(r.status,200,await r.clone().text());return r.json();}
const marker='PRIVATE_TRANSCRIPT_MARKER';
const event=(meta,kind='voice',extra={})=>({accountScope:meta.accountScope,privacyRevision:meta.privacyRevision,eventId:`${kind}-one`,kind,title:marker,summary:marker,refIds:[`personal-${marker}`],counts:{seconds:42,turns:3,discussions:1,tasks:1,opened:1,total:4,correct:3,assisted:1,privateCounter:99},occurredAt:new Date(Date.now()-1000).toISOString(),timezone:'UTC',...extra});

test('old clients cannot persist free text, private references or arbitrary count keys through structural journal kinds',async()=>{
  const db=setup();let meta=await view();
  for(const kind of ['voice','assistant','dictation','reading']){
    meta=await ok(await POST(req('POST',event(meta,kind,{refIds:kind==='reading'?['public-reading']: [`personal-${marker}`]}))));
    const saved=meta.days[0].events.find(e=>e.kind===kind);
    assert.equal(saved.summary,'');assert.deepEqual(saved.refIds,[]);assert.doesNotMatch(JSON.stringify(saved),new RegExp(marker));assert.equal(saved.counts.privateCounter,undefined);
  }
  assert.deepEqual(meta.days[0].events.find(e=>e.kind==='voice').counts,{seconds:42,turns:3});
  assert.deepEqual(meta.days[0].events.find(e=>e.kind==='dictation').counts,{total:4,correct:3,assisted:1});
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM learning_journal_events').all()),new RegExp(marker));
  assert.doesNotMatch(JSON.stringify((await resolveLearningContext(await authenticatedUserKey(),{})).memory.learningJournal),new RegExp(marker));
  assert.equal((await POST(req('POST',event(meta,'reading',{eventId:`reading-personal-${marker}-2026-11-10`})))).status,400);
  assert.equal((await POST(req('POST',event(meta,'reading',{eventId:'other-reading-id'})))).status,400);
});

test('client omits private markers before any request and skips personal article events',async t=>{
  setup();const original=globalThis.fetch;const posts=[];
  setTemporaryMode(false);invalidateLearningContext();
  globalThis.fetch=async(url,init={})=>{
    if(String(url).startsWith('/api/learning-memory'))return Response.json({accountScope:'scope',enabled:true,revision:0,contextVersion:'v1',notes:[],recentTopics:[]});
    if(init.method==='POST')posts.push(JSON.parse(init.body));
    return Response.json({accountScope:'scope',enabled:true,revision:0,privacyRevision:0,days:[]});
  };
  t.after(()=>{setTemporaryMode(true);setTemporaryMode(false);invalidateLearningContext();globalThis.fetch=original;});
  for(const kind of ['voice','assistant','dictation']) assert.equal(await recordLearningActivity(event({accountScope:'scope',privacyRevision:0},kind)),true);
  assert.doesNotMatch(JSON.stringify(posts),new RegExp(marker));assert.equal(posts.length,3);
  assert.equal(await recordLearningActivity(event({},'reading',{eventId:`reading-personal-${marker}`})),false);assert.equal(posts.length,3);
});

test('migration scrubs old events and daily copies, preserves explicit edits and unrelated vocabulary, and fences old context',async()=>{
  const db=setup(true),key=await authenticatedUserKey(),at=new Date(Date.now()-1000).toISOString(),date=at.slice(0,10);
  db.prepare('INSERT INTO learning_journal_settings(user_key,revision,privacy_revision) VALUES (?,4,2)').run(key);
  const insert=db.prepare("INSERT INTO learning_journal_events(user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash,edited) VALUES (?,?,?,'UTC',?,?,?,?,?,?,?,?)");
  for(const kind of ['voice','assistant','dictation'])insert.run(key,`${kind}-old`,date,at,kind,marker,marker,JSON.stringify([`personal-${marker}`]),JSON.stringify({turns:3,total:4,privateCounter:1}),'h'.repeat(64),0);
  insert.run(key,`reading-personal-${marker}`,date,at,'reading',marker,marker,JSON.stringify([`personal-${marker}`]),'{}','h'.repeat(64),0);
  insert.run(key,'vocabulary-old',date,at,'vocabulary','词汇复习','完成 3 词','["word-one"]','{"reviewed":3}','h'.repeat(64),0);
  insert.run(key,'voice-edited',date,at,'voice','主动编辑','保留我手动填写的内容','[]','{}','h'.repeat(64),1);
  insert.run(key,'dictation-edited',date,at,'dictation','手动听写标题','手动听写摘要',JSON.stringify([`personal-${marker}`]),'{"total":4,"privateCounter":1}','h'.repeat(64),1);
  insert.run(key,`reading-personal-edited-${marker}`,date,at,'reading','手动标题','手动摘要',JSON.stringify([`personal-${marker}`]),'{}','h'.repeat(64),1);
  db.prepare('INSERT INTO learning_journal_days(user_key,date,facts_summary,edited_summary,updated_at) VALUES (?,?,?,?,?)').run(key,date,marker.repeat(8),'我主动保存的每日摘要',at);
  const before=await view();db.exec(readFileSync(`drizzle/${migration}`,'utf8'));
  const after=await view();assert.equal(after.privacyRevision,before.privacyRevision+1);assert.equal(after.revision,before.revision+1);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM learning_journal_events').all()),new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM learning_journal_days').all()),new RegExp(marker));
  assert.equal(after.days[0].summary,'我主动保存的每日摘要');assert.equal(after.days[0].eventCount,7);
  assert.equal(after.days[0].events.find(e=>e.eventId==='voice-edited').summary,'保留我手动填写的内容');
  const editedDictation=after.days[0].events.find(e=>e.eventId==='dictation-edited');
  assert.equal(editedDictation.summary,'手动听写摘要');assert.deepEqual(editedDictation.refIds,[]);assert.deepEqual(editedDictation.counts,{total:4});
  assert.deepEqual(after.days[0].events.find(e=>e.eventId==='vocabulary-old').refIds,['word-one']);
  assert.equal((await POST(req('POST',event(before,'voice')))).status,409);
  assert.equal((await ok(await POST(req('POST',event(after,'voice',{eventId:'late-old',occurredAt:at}))))).accepted,false);
});

test('whole-journal deletion erases all data, rejects stale writes and edits, preserves account isolation and permits new activity',async()=>{
  const db=setup();let meta=await view();const old=event(meta,'voice');meta=await ok(await POST(req('POST',old)));
  meta=await ok(await PUT(req('PUT',{accountScope:meta.accountScope,revision:meta.revision,date:meta.days[0].date,summary:marker})));
  const stale=meta;const removed=await ok(await DELETE(req('DELETE',{accountScope:meta.accountScope,revision:meta.revision,all:true})));
  assert.deepEqual(removed.days,[]);assert.equal(db.prepare('SELECT count(*) n FROM learning_journal_events').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM learning_journal_days').get().n,0);
  assert.equal(db.prepare('SELECT storage_bytes,event_count FROM learning_journal_settings').get().storage_bytes,0);
  assert.equal((await POST(req('POST',old))).status,409);
  assert.equal((await ok(await POST(req('POST',{...old,privacyRevision:removed.privacyRevision})))).accepted,false);
  assert.equal((await DELETE(req('DELETE',{accountScope:stale.accountScope,revision:stale.revision,all:true}))).status,409);
  const fresh=await ok(await POST(req('POST',event(removed,'voice',{eventId:'new-voice',occurredAt:new Date(Date.now()+1000).toISOString()}))));assert.equal(fresh.accepted,true);
  assert.equal((await DELETE(req('DELETE',{accountScope:fresh.accountScope,revision:fresh.revision,all:true,eventId:'new-voice'}))).status,400);
  assert.equal((await DELETE(req('DELETE',{accountScope:fresh.accountScope,revision:fresh.revision,all:true,temporary:true}))).status,409);
  requestHeaders.set('oai-authenticated-user-email','other-journal@example.test');const other=await view();await ok(await DELETE(req('DELETE',{accountScope:other.accountScope,revision:other.revision,all:true})));
  requestHeaders.set('oai-authenticated-user-email','journal-privacy@example.test');assert.equal((await view()).days[0].eventCount,1);
});

test('clearing a clock-skewed event keeps its suppression fence across disable/enable and concurrent stale posts',async()=>{
  setup();let meta=await view();const old=event(meta,'voice',{occurredAt:new Date(Date.now()+120000).toISOString()});
  meta=await ok(await POST(req('POST',old)));
  const cleared=await ok(await DELETE(req('DELETE',{accountScope:meta.accountScope,revision:meta.revision,all:true})));
  meta=await ok(await PUT(req('PUT',{accountScope:cleared.accountScope,revision:cleared.revision,enabled:false})));
  meta=await ok(await PUT(req('PUT',{accountScope:meta.accountScope,revision:meta.revision,enabled:true})));
  const responses=await Promise.all([POST(req('POST',old)),POST(req('POST',{...old,privacyRevision:meta.privacyRevision}))]);
  assert.equal(responses[0].status,409);assert.equal((await ok(responses[1])).accepted,false);assert.deepEqual((await view()).days,[]);
});

test('a POST already past its metadata read cannot resurrect content after a concurrent whole-journal clear',async()=>{
  setup();const initial=await view();let reached,release;
  const gate=new Promise(resolve=>{release=resolve;});const pendingBatch=new Promise(resolve=>{reached=resolve;});
  const batch=env.DB.batch.bind(env.DB);
  env.DB.batch=async statements=>{if(statements.some(s=>s.sql.includes('INSERT INTO learning_journal_events'))){reached();await gate;}return batch(statements);};
  const delayed=POST(req('POST',event(initial,'voice')));await pendingBatch;
  await ok(await DELETE(req('DELETE',{accountScope:initial.accountScope,revision:initial.revision,all:true})));
  release();assert.equal((await delayed).status,409);assert.deepEqual((await view()).days,[]);
});
