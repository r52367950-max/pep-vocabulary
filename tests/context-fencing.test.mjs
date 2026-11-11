import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { POST as configure, DELETE as deleteConfig } from './config-client.mjs';
import { handleAssistantRequest, handleChatRequest } from '../lib/assistant/server.ts';
import { readTokenUsage } from '../lib/assistant/usage.ts';
import { budgetDay } from '../lib/http.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { memoryMetadata, resolveLearningContext, verifyLearningContext } from '../lib/learning-memory/context.ts';
import { saveLearningMemory } from '../lib/learning-memory/store.ts';
import { journalDays, journalContext } from '../lib/learning-journal/store.ts';
import { generateWritingTopic } from '../lib/writing-topic-server.ts';
import { WRITING_TOPICS } from '../lib/writing-topics.ts';
import { voiceFeedback } from '../lib/voice/server.ts';
import { recommendVoicePractice, discussVoicePractice } from '../lib/voice/coach-server.ts';
import { planDictation } from '../lib/voice/dictation-server.ts';

let db;
const word = { id:'pep-1e3e7e41accdc5f7',headword:'abandon',chineseCore:'放弃',partsOfSpeech:['v.'],scopes:[],sources:[],flags:{formalReleaseEligible:true} };
beforeEach(() => {
  db?.close(); db = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(`drizzle/${file}`,'utf8'));
  env.DB=sqliteD1(db); env.ASSETS={fetch:async()=>Response.json([word])};
  env.AI_CONFIG_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
  delete env.AI_CONFIG_ENCRYPTION_KEYS; delete env.AI_CONFIG_ENCRYPTION_KEY_ACTIVE;
  requestHeaders.set('host','app.test'); requestHeaders.set('oai-authenticated-user-email','fence@example.test');
});
const request = (path,body) => new Request(`https://app.test${path}`,{method:'POST',headers:{'content-type':'application/json','x-vocab-action':'settings'},body:JSON.stringify(body)});
const conflict = error => error.code==='learning_context_changed';
const settings = {provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol',apiKey:'test-key-not-real-00000000000000',dailyLimit:100,timeoutSeconds:25,dailyTokenBudget:200000};
const generated = result => Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:1500,output_tokens:100,total_tokens:1600}});
const explanation = {summary:'private generated result',meaning:[],grammar:[],collocations:[],examples:[],evidenceIds:[word.id],limitations:[]};
const chatBody = {messages:[{role:'user',text:'计算 6 * 7，给出学习建议。'}],model:'auto'};
const reserveQuery = sql => sql.includes('SELECT ?, ?, ? WHERE ? <= ?');

async function setupConfig() {
  const response=await configure(request('/api/ai/config',settings));
  assert.equal(response.status,200,await response.clone().text());
  return authenticatedUserKey();
}
// Change settings after a real SQLite read has captured its snapshot.
function afterQuery(matches,method,change,occurrence=1) {
  const binding=env.DB;let reads=0;
  env.DB={...binding,prepare(sql){
    const statement=binding.prepare(sql),bind=statement.bind.bind(statement);
    statement.bind=(...args)=>{
      const bound=bind(...args),run=bound[method].bind(bound);
      bound[method]=async(...options)=>{
        const result=await run(...options);
        if(matches(sql)) {
          reads++;
          if(occurrence===0||reads===occurrence) await change();
        }
        return result;
      };
      return bound;
    };
    return statement;
  }};
}
async function changeConfig(key,change) {
  if(change==='delete') {
    const response=await deleteConfig(request('/api/ai/config',{}));
    assert.equal(response.status,200,await response.clone().text());
    return;
  }
  const before=db.prepare('SELECT write_token,updated_at FROM ai_configs WHERE user_key=?').get(key);
  const patch=change==='model'?{model:'gpt-6.1-terra'}:change==='credential'?{apiKey:'replacement-test-key-000000000000'}:{dailyTokenBudget:100000};
  const response=await configure(request('/api/ai/config',{...settings,...patch}));
  assert.equal(response.status,200,await response.clone().text());
  // SQLite timestamps have second resolution; force that legitimate collision.
  db.prepare('UPDATE ai_configs SET updated_at=? WHERE user_key=?').run(before.updated_at,key);
  db.prepare('UPDATE ai_preferences SET updated_at=? WHERE user_key=?').run(before.updated_at,key);
  const after=db.prepare('SELECT write_token,updated_at FROM ai_configs WHERE user_key=?').get(key);
  assert.equal(after.updated_at,before.updated_at);
  assert.notEqual(after.write_token,before.write_token);
}

for (const change of ['none','memory','journal','configuration']) {
  test(`personalized explain completion fences ${change} changes during generation`,async t=>{
    const configured=await configure(request('/api/ai/config',{provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol',apiKey:'test-key-not-real-00000000000000',dailyLimit:100,timeoutSeconds:25,dailyTokenBudget:200000}));
    assert.equal(configured.status,200,await configured.clone().text());
    const key=await authenticatedUserKey();
    t.mock.method(globalThis,'fetch',async()=>{
      if(change==='memory') await saveLearningMemory(key,{revision:0,enabled:false,notes:[],recentTopics:[]});
      if(change==='journal') db.prepare('INSERT INTO learning_journal_settings(user_key,privacy_revision) VALUES (?,1)').run(key);
      if(change==='configuration') db.prepare("UPDATE ai_configs SET model='new-model' WHERE user_key=?").run(key);
      return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'private generated result',meaning:[],grammar:[],collocations:[],examples:[],evidenceIds:[word.id],limitations:[]})}]}],usage:{input_tokens:1500,output_tokens:100,total_tokens:1600}});
    });
    const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
    assert.equal(response.status,change==='none'?200:409,await response.clone().text());
    if(change!=='none') assert.doesNotMatch(await response.text(),/private generated result/);
  });
}

test('metadata-only verification never reads note/event content and permits new activity',async()=>{
  const key=await authenticatedUserKey(),meta=await memoryMetadata(key),binding=env.DB,queries=[];
  env.DB={...binding,prepare(sql){queries.push(sql);return binding.prepare(sql);}};
  await verifyLearningContext(key,meta);
  assert.ok(queries.length>0);
  assert.ok(queries.every(sql=>!sql.includes('learning_journal_events')&&!/SELECT.*\bnotes\b/i.test(sql)));
  db.prepare('INSERT INTO learning_journal_settings(user_key,revision) VALUES (?,1)').run(key);
  await verifyLearningContext(key,meta);
  db.prepare('UPDATE learning_journal_settings SET privacy_revision=1 WHERE user_key=?').run(key);
  await assert.rejects(verifyLearningContext(key,meta),conflict);
});

test('memory/config changes while journal content is loading cannot label stale content as current',async()=>{
  const key=await authenticatedUserKey(),binding=env.DB;
  let changed=false;
  env.DB={...binding,prepare(sql){
    const statement=binding.prepare(sql);
    const bind=statement.bind.bind(statement);
    statement.bind=(...args)=>{
      const bound=bind(...args),all=bound.all.bind(bound);
      bound.all=async()=>{
        const result=await all();
        if(sql.includes('FROM learning_journal_days')&&!changed){changed=true;await saveLearningMemory(key,{revision:0,enabled:false,notes:[],recentTopics:[]});}
        return result;
      };
      return bound;
    };
    return statement;
  }};
  await assert.rejects(resolveLearningContext(key,{}),conflict);
});

test('batched history retains ordering, truncation, deleted exclusions, old references and owner isolation',async()=>{
  const key=await authenticatedUserKey();
  for(const owner of [key,'other']) for(let day=1;day<=31;day++){
    const date=`2026-10-${String(day).padStart(2,'0')}`;
    db.prepare('INSERT INTO learning_journal_days(user_key,date,facts_summary,updated_at) VALUES (?,?,?,?)').run(owner,date,owner,date);
    for(let i=0;i<25;i++) db.prepare("INSERT INTO learning_journal_events(user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash,deleted) VALUES (?,?,?,'UTC',?,'study',?,'','[\"old-reference\"]','{}','hash',?)").run(owner,`${date}-${String(i).padStart(2,'0')}`,date,`${date}T12:00:00.000Z`,owner,i===24?1:0);
  }
  const rows=await journalDays(key);
  assert.equal(rows.length,30);assert.equal(rows[0].date,'2026-10-31');
  for(const row of rows){assert.equal(row.eventCount,24);assert.equal(row.events.length,20);assert.equal(row.eventsTruncated,true);assert.ok(row.events.every(e=>e.title===key));assert.ok(row.events[0].eventId.endsWith('-23'));}
  const context=await journalContext(key);assert.equal(context.length,7);assert.deepEqual(context[0].refIds,['old-reference']);
  assert.deepEqual(await journalDays('empty'),[]);assert.deepEqual(await journalContext('empty'),[]);
});

for(const endpoint of ['explain','chat']) for(const change of ['delete','model','credential','budget']) {
  test(`${endpoint} rejects ${change} after runtime snapshot before context without dispatch or token charge`,async t=>{
    const key=await setupConfig();let calls=0;
    afterQuery(sql=>sql.includes('from "ai_configs"'),'raw',()=>changeConfig(key,change));
    t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(endpoint==='chat'?{text:'answer',actions:[]}:explanation);});
    const response=endpoint==='chat'
      ?await handleChatRequest(request('/api/assistant/chat',chatBody))
      :await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
    assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).error.code,'learning_context_changed');
    assert.equal(calls,0);
    assert.equal((await readTokenUsage(key)).total,0);
  });
}

test('a settings deletion during token reservation is checked at dispatch and refunded exactly once',async t=>{
  const key=await setupConfig();let calls=0,refunds=0;
  afterQuery(reserveQuery,'first',()=>changeConfig(key,'delete'));
  afterQuery(sql=>sql.startsWith('UPDATE ai_rate_limits SET request_count = MAX(0'),'run',()=>{refunds++;},0);
  t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
  assert.equal(response.status,409,await response.clone().text());
  assert.equal(calls,0);assert.equal(refunds,1);assert.equal((await readTokenUsage(key)).total,0);
});

test('dispatch configuration read failure is closed and refunds its unused reservation',async t=>{
  const key=await setupConfig();let calls=0;
  afterQuery(sql=>sql.startsWith('SELECT write_token FROM ai_configs'),'first',()=>{throw new Error('D1 unavailable');});
  t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
  assert.equal(response.status,503,await response.clone().text());
  assert.equal((await response.json()).error.code,'configuration_unavailable');
  assert.equal(calls,0);assert.equal((await readTokenUsage(key)).total,0);
});

test('ambiguous budget storage failure never dispatches and retains its reservation',async t=>{
  const key=await setupConfig();let calls=0;
  afterQuery(reserveQuery,'first',()=>{throw new Error('budget store unavailable');});
  t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
  assert.equal(response.status,503,await response.clone().text());
  assert.equal(calls,0);
  assert.ok((await readTokenUsage(key)).total>0,'an ambiguous budget failure keeps its reservation');
});

test('exhausted budget never dispatches or refunds already consumed tokens',async t=>{
  const key=await setupConfig(),day=budgetDay();let calls=0,refunds=0;
  db.prepare('INSERT INTO ai_rate_limits (bucket_key,request_count,expires_at) VALUES (?,?,?)')
    .run(`tokens:day:${key}:${day.start}`,settings.dailyTokenBudget,day.expiresAt);
  afterQuery(sql=>sql.startsWith('UPDATE ai_rate_limits SET request_count = MAX(0'),'run',()=>{refunds++;});
  t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
  assert.equal(response.status,429,await response.clone().text());
  assert.equal(calls,0);assert.equal(refunds,0);assert.equal((await readTokenUsage(key)).total,settings.dailyTokenBudget);
});

for(const change of ['none','credential','memory','journal']) test(`chat second-round dispatch fences ${change} changes during reservation`,async t=>{
  const key=await setupConfig();let calls=0,settledFirst;
  await saveLearningMemory(key,{revision:0,enabled:true,notes:[{id:'note_1',text:'SYNTHETIC_PRIVATE_NOTE'}],recentTopics:[]});
  afterQuery(reserveQuery,'first',async()=>{
    if(change==='credential')await changeConfig(key,change);
    if(change==='memory')await saveLearningMemory(key,{revision:1,enabled:false,notes:[],recentTopics:[]});
    if(change==='journal')db.prepare('INSERT INTO learning_journal_settings(user_key,privacy_revision) VALUES (?,1) ON CONFLICT(user_key) DO UPDATE SET privacy_revision=privacy_revision+1').run(key);
  },2);
  // Observe settlement before the second reservation; it must never be refunded.
  const binding=env.DB;
  env.DB={...binding,async batch(statements){
    const result=await binding.batch(statements);
    if(statements[0]?.sql?.includes('INSERT INTO ai_rate_limits')&&calls===1) settledFirst=(await readTokenUsage(key)).total;
    return result;
  }};
  t.mock.method(globalThis,'fetch',async()=>generated(++calls===1
    ?{toolCalls:[{id:'sum',name:'calculate',arguments:{expression:'6 * 7'}}]}
    :{text:'结果是 42。',actions:[]}));
  const response=await handleChatRequest(request('/api/assistant/chat',chatBody));
  assert.equal(response.status,change==='none'?200:409,await response.clone().text());
  assert.equal(calls,change==='none'?2:1);
  assert.ok(settledFirst>0);
  if(change!=='none')assert.equal((await readTokenUsage(key)).total,settledFirst);
});

test('same-timestamp credential replacement during generation invalidates the completed context',async t=>{
  const key=await setupConfig();
  t.mock.method(globalThis,'fetch',async()=>{await changeConfig(key,'credential');return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
  assert.equal(response.status,409,await response.clone().text());
  assert.doesNotMatch(await response.text(),/private generated result/);
  assert.ok((await readTokenUsage(key)).total>0,'already dispatched generation stays metered');
});

test('lazy master-key rotation preserves the runtime settings identity and normal generation',async t=>{
  const key=await setupConfig(),before=db.prepare('SELECT write_token FROM ai_configs WHERE user_key=?').get(key);
  db.prepare("UPDATE ai_configs SET updated_at='2000-01-01 00:00:00' WHERE user_key=?").run(key);
  const context=await memoryMetadata(key);
  env.AI_CONFIG_ENCRYPTION_KEYS=JSON.stringify({k1:env.AI_CONFIG_ENCRYPTION_KEY,k2:Buffer.alloc(32,8).toString('base64')});
  env.AI_CONFIG_ENCRYPTION_KEY_ACTIVE='k2';let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return generated(explanation);});
  const response=await handleAssistantRequest(request('/api/assistant/explain',{
    wordId:word.id,accountScope:context.accountScope,contextRevision:context.revision,contextVersion:context.contextVersion,
  }),'explain');
  assert.equal(response.status,200,await response.clone().text());assert.equal(calls,1);
  const after=db.prepare('SELECT write_token,encryption_version,encrypted_api_key FROM ai_configs WHERE user_key=?').get(key);
  assert.equal(after.write_token,before.write_token);assert.equal(after.encryption_version,3);assert.ok(after.encrypted_api_key.startsWith('k2:'));
});

for(const endpoint of ['explain','chat']) for(const change of ['none','memory','journal']) {
  test(`${endpoint} dispatch checks ${change} privacy changes after reservation`,async t=>{
    const key=await setupConfig();let calls=0,sentPrivate=false;
    await saveLearningMemory(key,{revision:0,enabled:true,notes:[{id:'note_1',text:'SYNTHETIC_PRIVATE_NOTE'}],recentTopics:[]});
    db.prepare("INSERT INTO learning_journal_days(user_key,date,facts_summary,updated_at) VALUES (?,'2026-11-11','SYNTHETIC_PRIVATE_JOURNAL','2026-11-11')").run(key);
    afterQuery(reserveQuery,'first',async()=>{
      if(change==='memory') await saveLearningMemory(key,{revision:1,enabled:false,notes:[],recentTopics:[]});
      if(change==='journal') db.prepare('INSERT INTO learning_journal_settings(user_key,privacy_revision) VALUES (?,1) ON CONFLICT(user_key) DO UPDATE SET privacy_revision=privacy_revision+1').run(key);
    });
    t.mock.method(globalThis,'fetch',async(_url,init)=>{
      calls++;sentPrivate=init.body.includes('SYNTHETIC_PRIVATE_NOTE')&&init.body.includes('SYNTHETIC_PRIVATE_JOURNAL');
      return generated(endpoint==='chat'?{text:'answer',actions:[]}:explanation);
    });
    const response=endpoint==='chat'
      ?await handleChatRequest(request('/api/assistant/chat',chatBody))
      :await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
    assert.equal(response.status,change==='none'?200:409,await response.clone().text());
    assert.equal(calls,change==='none'?1:0,`calls=${calls}; sent private material=${sentPrivate}`);
    assert.equal(sentPrivate,change==='none');
    if(change!=='none')assert.equal((await readTokenUsage(key)).total,0);
  });
}

const transcript=[{role:'user',text:'I like reading books.'}];
const personalizedCalls=[
  {name:'writing-topic',run:generateWritingTopic,body:{operationId:'fence-writing-topic-123',kind:'free'},result:WRITING_TOPICS.find(topic=>topic.kind==='free')},
  {name:'voice-feedback',run:voiceFeedback,body:{topicId:'everyday',transcript},result:{strength:'表达了阅读喜好。',improvements:[],retryPrompt:'What do you like to read?',expressions:[]}},
  {name:'voice-recommend',run:recommendVoicePractice,body:{},result:{recommendations:[{topicId:'everyday',level:'B1',minutes:10,title:'阅读交流',goal:'谈一本书',openingPrompt:'What do you like to read?',reason:'练习具体表达。'}]}},
  {name:'voice-discuss',run:discussVoicePractice,body:{transcript,messages:[]},result:{reply:'可以谈谈喜欢的一本书。',memorySuggestions:[]}},
  {name:'dictation-plan',run:planDictation,body:{operationId:'fence-dictation-plan-123',text:'abandon'},result:{itemIds:[`word:${word.id}`],reason:'复习这个词。'}},
];
for(const call of personalizedCalls) for(const phase of ['none','before-dispatch','during-generation']) {
  test(`${call.name} uses its original context for ${phase} privacy changes`,async t=>{
    const key=await setupConfig();let calls=0;
    await saveLearningMemory(key,{revision:0,enabled:true,notes:[{id:'note_1',text:'SYNTHETIC_PRIVATE_NOTE'}],recentTopics:[]});
    env.ASSETS={fetch:async request=>{
      const path=new URL(request.url).pathname;
      return path.startsWith('/readings/')?new Response(readFileSync(`public${path}`,'utf8'),{headers:{'content-type':'application/json'}}):Response.json([word]);
    }};
    const disable=()=>saveLearningMemory(key,{revision:1,enabled:false,notes:[],recentTopics:[]});
    if(phase==='before-dispatch')afterQuery(reserveQuery,'first',disable);
    t.mock.method(globalThis,'fetch',async(_url,init)=>{
      calls++;assert.ok(init.body.includes('SYNTHETIC_PRIVATE_NOTE'));
      if(phase==='during-generation')await disable();
      return generated(call.result);
    });
    const response=await call.run(request(`/api/${call.name}`,call.body));
    assert.equal(response.status,phase==='none'?200:409,await response.clone().text());
    assert.equal(calls,phase==='before-dispatch'?0:1);
    const used=(await readTokenUsage(key)).total;
    if(phase==='before-dispatch')assert.equal(used,0);else assert.ok(used>0);
  });
}
