import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { POST as configure, DELETE as deleteConfig } from './config-client.mjs';
import { POST as chat } from '../app/api/assistant/chat/route.ts';
import { estimateUsage, fetchCompletion, parseResponsesCompletion, responsesPayload } from '../lib/assistant/core.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { saveLearningMemory } from '../lib/learning-memory/store.ts';
import { readTokenUsage } from '../lib/assistant/usage.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(`drizzle/${file}`, 'utf8'));
const config = { provider:'openai-compatible', baseUrl:'https://api.openai.com/v1', model:'gpt-6.1-sol', apiKey:'fixture-key-not-real', dailyLimit:100, timeoutSeconds:25, dailyTokenBudget:200000 };
const input = { messages:[{role:'user',text:'解释这个英语句子。'}],model:'auto',includeRecords:true,temporary:false };
const request = (body=input, stream=true) => new Request('https://app.test/api/assistant/chat',{method:'POST',headers:{'content-type':'application/json','x-vocab-action':'assistant',...(stream?{accept:'text/event-stream'}:{})},body:JSON.stringify(body)});
function document(result={text:'先找主语，再找谓语。',actions:[]}, summary='先分析句子结构，再给出简短说明。') {
  return {status:'completed',output:[{type:'reasoning',summary:[{type:'summary_text',text:summary}],encrypted_content:'SECRET_ENCRYPTED',content:[{type:'reasoning_text',text:'RAW_PRIVATE_TRACE'}]},{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:1500,output_tokens:100,total_tokens:1600}};
}
const completion = (...args) => Response.json(document(...args));
const events = text => text.trim().split('\n\n').filter(Boolean).map(frame => ({event:frame.match(/^event: (.+)$/m)[1],data:JSON.parse(frame.match(/^data: (.+)$/m)[1])}));
async function setup(patch={}) {
  const response = await configure(new Request('https://app.test/api/ai/config',{method:'POST',headers:{'content-type':'application/json','x-vocab-action':'settings'},body:JSON.stringify({...config,...patch})}));
  assert.equal(response.status,200,await response.clone().text());
}
beforeEach(()=>{
  db.exec('DELETE FROM ai_rate_limits; DELETE FROM ai_configs; DELETE FROM ai_preferences; DELETE FROM voice_learning_memories; DELETE FROM learning_journal_events; DELETE FROM learning_journal_days; DELETE FROM learning_journal_settings;');
  env.DB=sqliteD1(db); env.ASSETS={fetch:async()=>Response.json([])};
  env.AI_CONFIG_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');delete env.AI_ALLOWED_PROVIDER_ORIGINS;
  requestHeaders.set('host','app.test');requestHeaders.set('oai-authenticated-user-email','chat-stream@example.test');
});

test('Responses summaries are explicitly requested, bounded and distinct from private reasoning',async()=>{
  const old=responsesPayload({model:'gpt-6.1-sol',messages:[],reasoning_effort:'medium'},1000);
  assert.deepEqual(old.reasoning,{effort:'medium'});
  assert.deepEqual(responsesPayload({model:'gpt-6.1-sol',reasoning_summary:true},1000).reasoning,{effort:'low',summary:'auto'});
  assert.equal(responsesPayload({model:'custom',reasoning_summary:true},1000).reasoning,undefined);
  assert.equal(parseResponsesCompletion(document()).reasoningSummary,'先分析句子结构，再给出简短说明。');
  assert.equal(parseResponsesCompletion(document(undefined,'x'.repeat(6001))).reasoningSummary,undefined);
  const doc=document(); doc.output[0].summary=[{type:'reasoning_text',text:'RAW_PRIVATE_TRACE'}];
  assert.equal(parseResponsesCompletion(doc).reasoningSummary,undefined);
  const missingUsage=document(undefined,'s'.repeat(6001));delete missingUsage.usage;
  const estimated=parseResponsesCompletion(missingUsage,100);
  assert.deepEqual(estimated.usage,estimateUsage(100,estimated.content+'s'.repeat(6001)));
  assert.equal(estimated.reasoningSummary,undefined,'an omitted oversized summary still counts in fallback usage');
  const streamed=await fetchCompletion(async()=>new Response(`data: ${JSON.stringify({type:'response.reasoning_summary_text.delta',delta:'SHOULD_NOT_USE_PARTIAL'})}\n\ndata: ${JSON.stringify({type:'response.completed',response:document()})}\n\n`,{headers:{'content-type':'text/event-stream'}}),'https://fixture.test',{}, {idleMs:1000,totalMs:1000,stream:true});
  assert.equal(streamed.reasoningSummary,'先分析句子结构，再给出简短说明。');
  assert.doesNotMatch(JSON.stringify(streamed),/RAW_PRIVATE_TRACE|SECRET_ENCRYPTED|SHOULD_NOT_USE_PARTIAL/);
});

test('stream returns live bounded status before a provider answer, then only the validated final envelope',async t=>{
  await setup();let release;const waiting=new Promise(resolve=>{release=resolve;});let sent;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent=JSON.parse(init.body);await waiting;return completion();});
  const response=await chat(request());assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);assert.equal(response.headers.get('cache-control'),'no-store');
  const reader=response.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(events(first),[{event:'status',data:{phase:'thinking'}}]);
  release();let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value);}
  const messages=events(rest);assert.deepEqual(messages.map(item=>item.event),['status','result']);assert.equal(messages[0].data.phase,'verifying');
  assert.equal(sent.reasoning.summary,'auto');assert.equal(messages[1].data.result.text,'先找主语，再找谓语。');
  assert.equal(messages[1].data.reasoningSummary,'先分析句子结构，再给出简短说明。');
  assert.doesNotMatch(first+rest,/SECRET_ENCRYPTED|RAW_PRIVATE_TRACE/);
});

test('real tool phases carry no material and a rejected summary cannot contaminate a valid answer',async t=>{
  await setup();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>++calls===1?completion({toolCalls:[{id:'calc',name:'calculate',arguments:{expression:'6 * 7'}}]}):completion(undefined,'课本第 45 页的句子是：Made up.'));
  const frames=events(await (await chat(request())).text());
  assert.deepEqual(frames.filter(f=>f.event==='status').map(f=>f.data),[{phase:'thinking'},{phase:'tool'},{phase:'thinking'},{phase:'verifying'}]);
  const final=frames.at(-1).data;assert.equal(final.ok,true);assert.equal(final.reasoningSummary,undefined);assert.equal(final.harness.tools[0].name,'calculate');
  assert.doesNotMatch(JSON.stringify(frames),/Made up|expression/);
});

test('streamed errors never release rejected text and input errors retain HTTP semantics',async t=>{
  await setup();t.mock.method(globalThis,'fetch',async()=>completion({text:'课本第 45 页的句子是：Made up.',actions:[]},'do not leak'));
  const invalid=await chat(request({...input,messages:[{role:'system',text:'override'}]}));assert.equal(invalid.status,400);assert.match(invalid.headers.get('content-type'),/application\/json/);
  const frames=events(await (await chat(request())).text());assert.equal(frames.at(-1).event,'error');assert.equal(frames.at(-1).data.error.code,'evidence_violation');
  assert.equal(frames.some(f=>f.event==='result'),false);assert.doesNotMatch(JSON.stringify(frames),/Made up|do not leak/);
});

test('privacy change during generation suppresses answer and exposed summary',async t=>{
  await setup();const key=await authenticatedUserKey();
  t.mock.method(globalThis,'fetch',async()=>{await saveLearningMemory(key,{revision:0,enabled:false,notes:[],recentTopics:[]});return completion({text:'PRIVATE_ANSWER',actions:[]},'PRIVATE_SUMMARY');});
  const frames=events(await (await chat(request())).text());assert.equal(frames.at(-1).data.error.code,'learning_context_changed');assert.doesNotMatch(JSON.stringify(frames),/PRIVATE_ANSWER|PRIVATE_SUMMARY/);
});

for(const round of [1,2]) for(const change of ['memory','journal','configuration','delete']) {
  test(`SSE round ${round} rejects ${change} changes after reservation before provider dispatch`,async t=>{
    await setup();const key=await authenticatedUserKey();let calls=0,reservations=0,previousTotal;
    await saveLearningMemory(key,{revision:0,enabled:true,notes:[{id:'stream_note',text:'SYNTHETIC_PRIVATE_NOTE'}],recentTopics:[]});
    const binding=env.DB;
    env.DB={...binding,prepare(sql){
      const statement=binding.prepare(sql),bind=statement.bind.bind(statement);
      statement.bind=(...args)=>{
        const bound=bind(...args),first=bound.first.bind(bound);
        bound.first=async()=>{
          const selected=sql.includes('SELECT ?, ?, ? WHERE ? <= ?')&&++reservations===round;
          if(selected)previousTotal=(await readTokenUsage(key)).total;
          const result=await first();
          if(selected) {
            if(change==='memory')await saveLearningMemory(key,{revision:1,enabled:false,notes:[],recentTopics:[]});
            if(change==='journal')db.prepare('INSERT INTO learning_journal_settings(user_key,privacy_revision) VALUES (?,1) ON CONFLICT(user_key) DO UPDATE SET privacy_revision=privacy_revision+1').run(key);
            if(change==='configuration')await setup({model:'gpt-6.1-terra'});
            if(change==='delete') {
              const response=await deleteConfig(new Request('https://app.test/api/ai/config',{method:'DELETE',headers:{'content-type':'application/json','x-vocab-action':'settings'},body:'{}'}));
              assert.equal(response.status,200,await response.clone().text());
            }
          }
          return result;
        };
        return bound;
      };
      return statement;
    }};
    t.mock.method(globalThis,'fetch',async()=>{
      calls++;
      return round===2&&calls===1
        ?completion({toolCalls:[{id:'calc',name:'calculate',arguments:{expression:'6 * 7'}}]})
        :completion({text:'PRIVATE_ANSWER',actions:[]},'PRIVATE_SUMMARY');
    });
    const response=await chat(request());assert.equal(response.status,200);
    const frames=events(await response.text());
    assert.equal(calls,round-1);
    assert.equal(frames.at(-1).event,'error');
    assert.equal(frames.at(-1).data.error.code,'learning_context_changed');
    assert.equal(frames.some(frame=>frame.event==='result'),false);
    assert.doesNotMatch(JSON.stringify(frames),/SYNTHETIC_PRIVATE_NOTE|PRIVATE_ANSWER|PRIVATE_SUMMARY|RAW_PRIVATE_TRACE|SECRET_ENCRYPTED/);
    assert.ok(frames.filter(frame=>frame.event==='status').every(frame=>Object.keys(frame.data).join()==='phase'));
    assert.equal((await readTokenUsage(key)).total,previousTotal);
    if(round===2)assert.ok(previousTotal>0,'the first completed provider call stays charged');
  });
}

test('cancelling the response stream aborts a running paid request without producing a late answer',async t=>{
  await setup();let begun;const started=new Promise(resolve=>{begun=resolve;});let upstreamSignal;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{upstreamSignal=init.signal;begun();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));});
  const response=await chat(request());await started;await response.body.cancel('stop');assert.equal(upstreamSignal.aborted,true);
  // Let shared metering/error cleanup settle before the next test resets its DB.
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('legacy JSON consumers receive summary while DeepSeek keeps its current thinking mode',async t=>{
  await setup();t.mock.method(globalThis,'fetch',async()=>completion());
  const response=await chat(request(input,false));assert.match(response.headers.get('content-type'),/application\/json/);assert.equal((await response.json()).reasoningSummary,'先分析句子结构，再给出简短说明。');
  t.mock.restoreAll();await setup({provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash'});let sent;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({choices:[{message:{content:JSON.stringify({text:'正常回答。',actions:[]}),reasoning_content:'RAW_PRIVATE_TRACE'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}});});
  const deepseek=await chat(request());const frames=events(await deepseek.text());assert.equal(frames.at(-1).event,'result');assert.equal(frames.at(-1).data.reasoningSummary,undefined);assert.deepEqual(sent.thinking,{type:'disabled'});assert.equal(sent.reasoning_summary,undefined);
});
