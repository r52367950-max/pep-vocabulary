import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {sqliteD1} from '/workspace/pep-vocabulary/tests/sqlite-d1.mjs';
import {env} from '/workspace/pep-vocabulary/tests/worker-env.mjs';
import {requestHeaders} from '/workspace/pep-vocabulary/tests/request-headers.mjs';
import {POST as configure, DELETE as deleteConfig} from '/workspace/pep-vocabulary/tests/config-client.mjs';
import {handleAssistantRequest} from '/workspace/pep-vocabulary/lib/assistant/server.ts';
import {authenticatedUserKey} from '/workspace/pep-vocabulary/lib/server-user.ts';
const word={id:'pep-1e3e7e41accdc5f7',headword:'abandon',chineseCore:'放弃',partsOfSpeech:['v.'],scopes:[],sources:[],flags:{formalReleaseEligible:true}};
const request=(path,body)=>new Request('https://app.test'+path,{method:'POST',headers:{'content-type':'application/json','x-vocab-action':'settings'},body:JSON.stringify(body)});
for (const change of ['model','delete']) {
const db=new DatabaseSync(':memory:');
for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+f,'utf8'));
env.DB=sqliteD1(db);env.ASSETS={fetch:async()=>Response.json([word])};env.AI_CONFIG_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');requestHeaders.set('host','app.test');requestHeaders.set('oai-authenticated-user-email','review@example.test');
assert.equal((await configure(request('/api/ai/config',{provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-sol',apiKey:'local-fake-key-0000000000000000',dailyLimit:100,timeoutSeconds:25,dailyTokenBudget:200000}))).status,200);
const key=await authenticatedUserKey(),binding=env.DB;let changed=false,calls=0,usedModel;
env.DB={...binding,prepare(sql){const statement=binding.prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),raw=bound.raw.bind(bound);bound.raw=async()=>{const result=await raw();if(sql.includes('from "ai_configs"')&&!changed){changed=true;if(change==='model')assert.equal((await configure(request('/api/ai/config',{provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra',apiKey:'local-fake-key-0000000000000000',dailyLimit:100,timeoutSeconds:25,dailyTokenBudget:200000}))).status,200);else assert.equal((await deleteConfig(request('/api/ai/config',{}))).status,200);}return result;};return bound;};return statement;}};
globalThis.fetch=async(url,init)=>{calls++;usedModel=JSON.parse(init.body).model;return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'private generated result',meaning:[],grammar:[],collocations:[],examples:[],evidenceIds:[word.id],limitations:[]})}]}],usage:{input_tokens:1500,output_tokens:100,total_tokens:1600}});};
const response=await handleAssistantRequest(request('/api/assistant/explain',{wordId:word.id}),'explain');
console.log(JSON.stringify({change,changed,calls,usedModel,status:response.status,responseModel:(await response.json()).model,current:db.prepare('SELECT model FROM ai_configs WHERE user_key=?').get(key)?.model??null}));db.close();
}
