import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { planDictation,recognizeDictation } from '../lib/voice/dictation-server.ts';
const json=(body,origin='https://app.test')=>new Request('https://app.test/api/voice/dictation-plan',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
function setup(){const db=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));env.DB=sqliteD1(db);env.AI_CONFIG_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');requestHeaders.set('oai-authenticated-user-email','dictation-owner@example.test');return db;}
async function configure(){const {POST}=await import('../app/api/ai/config/route.ts');const req=json({provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6-astra',apiKey:'not-real-offline-test-key',timeoutSeconds:25,dailyLimit:100,dailyTokenBudget:200000});req.headers.set('x-vocab-action','settings');assert.equal((await POST(req)).status,200);}
test('admission rejects cross-origin, unauthenticated, oversized and malformed images before paid calls',async()=>{
 setup();assert.equal((await planDictation(json({},'https://evil.test'))).status,403);
 requestHeaders.delete('oai-authenticated-user-email');assert.equal((await recognizeDictation(json({}))).status,401);
 requestHeaders.set('oai-authenticated-user-email','dictation-owner@example.test');
 assert.equal((await recognizeDictation(json({image:'x'.repeat(4*1024*1024)}))).status,413);
 assert.equal((await recognizeDictation(json({operationId:'operation-test-1234',image:'https://bad.test'}))).status,400);
});
test('planner grounds output and durably rejects repeated operation without second upstream call',async()=>{
 setup();await configure();env.ASSETS={fetch:async(request)=>new URL(request.url).pathname.startsWith('/readings/') ? new Response(readFileSync(new URL('../public'+new URL(request.url).pathname,import.meta.url),'utf8'),{headers:{'content-type':'application/json'}}) : Response.json([{id:'pep-1',headword:'apple',chineseCore:'苹果',sources:[{bookId:'HS-R1',volume:'必修第一册',unit:'Unit 1'}],flags:{formalReleaseEligible:true}}])};
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;assert.equal(JSON.parse(init.body).model,'gpt-6.1-terra');return Response.json({id:'resp_test',object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"itemIds":["word:pep-1"],"reason":"根据你的选题"}'}]}],usage:{input_tokens:100,output_tokens:50,total_tokens:150}});};
 try{const body={operationId:'operation-test-1234',text:'apple'};const first=await planDictation(json(body));assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json()).items[0].text,'apple');assert.equal((await planDictation(json(body))).status,409);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('vision sends only image/instructions, keeps spelling, forces confirmation and prevents duplicate charge',async()=>{
 setup();await configure();const bytes=Buffer.alloc(33);bytes.writeUInt32BE(0x89504e47,0);bytes.writeUInt32BE(0x0d0a1a0a,4);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(800,16);bytes.writeUInt32BE(600,20);
 const original=globalThis.fetch;let calls=0,payload;
 globalThis.fetch=async(_url,init)=>{calls++;payload=JSON.parse(init.body);return Response.json({id:'resp_vision',object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"rows":[{"label":"1","text":"aple","uncertain":true}],"score":100}'}]}],usage:{input_tokens:2000,output_tokens:30,total_tokens:2030}});};
 try{const body={operationId:'recognize-test-1234',image:'data:image/png;base64,'+bytes.toString('base64'),answer:'SECRET_TARGET',text:'SECRET_TARGET'};const response=await recognizeDictation(json(body));assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.requiresConfirmation,true);assert.equal(result.rows[0].text,'aple');assert.equal('score' in result,false);assert.equal(JSON.stringify(payload).includes('SECRET_TARGET'),false);assert.equal(payload.store,false);assert.equal(payload.model,'gpt-6.1-terra');assert.equal((await recognizeDictation(json(body))).status,409);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('article request retrieves real library sentences and unavailable article never falls back to words',async()=>{
 setup();await configure();const paths=[];env.ASSETS={fetch:async(request)=>{const path=new URL(request.url).pathname;paths.push(path);try{return new Response(readFileSync(new URL('../public'+path,import.meta.url),'utf8'),{headers:{'content-type':'application/json'}});}catch{return new Response('',{status:404});}}};
 const catalog=JSON.parse(readFileSync(new URL('../public/readings/v1/index.json',import.meta.url),'utf8'));const article=catalog[0];
 const original=globalThis.fetch;let chosen,calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const payload=JSON.parse(init.body);const supplied=JSON.parse(payload.input[1].content);chosen=supplied.candidates[0];assert.match(chosen.id,/^reading:/);return Response.json({id:'resp_article',object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({itemIds:[chosen.id]})}]}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}});};
 try{const result=await planDictation(json({operationId:'article-test-1234',text:`听写文章《${article.title}》`}));assert.equal(result.status,200,await result.clone().text());assert.equal((await result.json()).items[0].text,chosen.text);assert.ok(paths.some(path=>path.includes('/articles/')));
 const missing=await planDictation(json({operationId:'article-test-missing',text:'听写文章《This Article Definitely Does Not Exist 938294》'}));assert.equal(missing.status,200,await missing.clone().text());assert.deepEqual((await missing.json()).items,[]);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
