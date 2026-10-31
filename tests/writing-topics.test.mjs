import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {WRITING_TOPICS,WRITING_TOPIC_SOURCES,validWritingTopic,topicPrompt,recommendWritingTopic,randomWritingTopic} from '../lib/writing-topics.ts';
import {validWriting} from '../lib/backup.ts';
import {newWriting} from '../lib/writing.ts';
import {HANDWRITING_DIMENSIONS,parseWritingRecognition} from '../lib/writing-recognition.ts';
import {generateWritingTopic} from '../lib/writing-topic-server.ts';
import {env} from './worker-env.mjs';
import {requestHeaders} from './request-headers.mjs';
import {sqliteD1} from './sqlite-d1.mjs';
const req=(body,origin='https://app.test')=>new Request('https://app.test/api/writing/generate-topic',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
function setup(){const db=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));env.DB=sqliteD1(db);env.AI_CONFIG_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');requestHeaders.set('oai-authenticated-user-email','topic-test@example.test');return db;}
test('48 original practice tasks have complete continuation passages, bounded prompts and real source references',()=>{
 assert.equal(WRITING_TOPICS.length,48);assert.equal(new Set(WRITING_TOPICS.map(t=>t.id)).size,48);
 const sources=new Set(WRITING_TOPIC_SOURCES.map(s=>s.id));assert.ok(sources.size>=8);
 for(const t of WRITING_TOPICS){assert.ok(validWritingTopic(t),t.id);assert.ok(t.sourceIds.every(id=>sources.has(id)));assert.ok(topicPrompt(t).length<=4000);if(t.kind==='continuation'){assert.equal(t.paragraphStarters.length,2);const count=t.readingText.split(/\s+/).length;assert.ok(count>=150&&count<=220,t.id);}}
 assert.equal(WRITING_TOPICS.filter(t=>t.kind==='continuation').length,12);
 const first=recommendWritingTopic('practical',{themes:['environment'],cefr:'B1'});assert.equal(first.kind,'practical');assert.notEqual(recommendWritingTopic('practical',{themes:['environment'],recentTitles:[first.title]}).id,first.id);
 assert.notEqual(randomWritingTopic('practical',first.id).id,first.id);
 const broken={...WRITING_TOPICS.find(t=>t.kind==='continuation'),readingText:undefined};assert.equal(validWritingTopic(broken),false);
});
test('old writing backups remain valid; confirmed handwriting round-trips while images and inflated scores fail validation',()=>{
 const record=newWriting('free',[],'Describe a useful routine.');assert.ok(validWriting(record));
 const h=parseWritingRecognition(JSON.stringify({text:'My writing.',uncertainSpans:[],handwriting:{photoQuality:{status:'usable',issues:[]},dimensions:HANDWRITING_DIMENSIONS.map(id=>({id,score:4,evidence:'Visible baseline and spacing.',suggestion:'Keep spacing even.'})),summary:'Practice reference.'}})).handwriting;
 record.versions[0].handwriting=h;assert.ok(validWriting(record));assert.deepEqual(JSON.parse(JSON.stringify(record)).versions[0].handwriting,h);
 record.versions[0].handwriting={...h,score:20};assert.equal(validWriting(record),false);record.versions[0].handwriting={...h,image:'data:image/png;base64,private'};assert.equal(validWriting(record),false);
});
test('topic generation uses Terra and journal context, marks original output and admits an operation once',async()=>{
 const db=setup();const {POST}=await import('../app/api/ai/config/route.ts');const configure=req({provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6-astra',apiKey:'test-only-never-real-key',timeoutSeconds:25,dailyLimit:100,dailyTokenBudget:200000});configure.headers.set('x-vocab-action','settings');assert.equal((await POST(configure)).status,200);
 const original=globalThis.fetch;let calls=0,payload;globalThis.fetch=async(_url,init)=>{calls++;payload=JSON.parse(init.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...WRITING_TOPICS[0],sourceIds:['fake-official-exam'],provenance:'exam'})}]}],usage:{input_tokens:200,output_tokens:100,total_tokens:300}});};
 try{const body={operationId:'topic-operation-123456',kind:'free'};const response=await generateWritingTopic(req(body));assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.topic.provenance,'ai-original');assert.deepEqual(result.topic.sourceIds,[]);assert.equal(payload.model,'gpt-6.1-terra');assert.equal(payload.store,false);assert.equal((await generateWritingTopic(req(body))).status,409);assert.equal(calls,1);assert.equal((await generateWritingTopic(req({},'https://evil.test'))).status,403);}finally{globalThis.fetch=original;db.close();}
});
test('incomplete and wrong-genre generated tasks are rejected; continuation starters cannot be blank',async()=>{
 const db=setup();const {POST}=await import('../app/api/ai/config/route.ts');const configured=req({provider:'openai-compatible',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra',apiKey:'test-only-not-real-key',timeoutSeconds:25,dailyLimit:100,dailyTokenBudget:200000});configured.headers.set('x-vocab-action','settings');assert.equal((await POST(configured)).status,200);
 const original=globalThis.fetch;let incomplete=false;globalThis.fetch=async()=>Response.json({status:incomplete?'incomplete':'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({...WRITING_TOPICS[0],kind:incomplete?'free':'practical'})}]}],usage:{input_tokens:100,output_tokens:100,total_tokens:200}});
 try{assert.equal((await generateWritingTopic(req({operationId:'wrong-genre-topic-123',kind:'free'}))).status,502);incomplete=true;assert.equal((await generateWritingTopic(req({operationId:'truncated-topic-1234',kind:'free'}))).status,502);const continuation=WRITING_TOPICS.find(t=>t.kind==='continuation');assert.equal(validWritingTopic({...continuation,paragraphStarters:['   ',continuation.paragraphStarters[1]]}),false);}finally{globalThis.fetch=original;db.close();}
});
