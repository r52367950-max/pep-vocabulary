import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanInput, allowsTopicWords, retrieveDictationCandidates, parseDictationPlan, parseRecognizedRows, parseDictationImage, operationId } from '../lib/voice/dictation-planner.ts';
const row = { id:'pep-1',headword:'apple',chineseCore:'苹果',flags:{formalReleaseEligible:true},sources:[{bookId:'HS-R1',volume:'必修第一册',unit:'Unit 1'}] };
const input = text => parsePlanInput({text});
test('retrieval uses real release IDs and sources; blank metadata never matches',()=>{
  assert.equal(retrieveDictationCandidates([row],input('必修第一册 Unit 1'))[0].text,'apple');
  assert.deepEqual(retrieveDictationCandidates([{...row,chineseCore:'',sources:[{bookId:'',volume:'',unit:''}]}],input('unrelated')),[]);
  assert.deepEqual(retrieveDictationCandidates([{...row,flags:{formalReleaseEligible:false}}],input('apple')),[]);
  const candidates=retrieveDictationCandidates([row],input('apple'));
  assert.equal(parseDictationPlan('{"itemIds":["word:pep-1"]}',candidates).items[0].text,'apple');
  assert.throws(()=>parseDictationPlan('{"itemIds":["invented"]}',candidates));
  assert.throws(()=>parseDictationPlan('{"itemIds":["word:pep-1","word:pep-1"]}',candidates));
});
test('article provenance remains user-provided and text cannot be model-rewritten',()=>{
  const parsed=parsePlanInput({articleCandidates:[{id:'article:one',text:'Actual sentence.',source:'Test'}]});
  const candidates=retrieveDictationCandidates([],parsed);
  assert.match(candidates[0].source,/用户提供文章/);
  assert.equal(parseDictationPlan('{"itemIds":["article:one"],"text":"changed"}',candidates).items[0].text,'Actual sentence.');
  assert.throws(()=>parsePlanInput({articleCandidates:[{id:'word:fake',text:'bad',source:'Test'}]}));
});
test('recognition always requires explicit confirmation and preserves misspellings',()=>{
  assert.deepEqual(parseRecognizedRows('{"rows":[{"label":"1","text":"aple","uncertain":true}],"score":100}'),{rows:[{label:'1',text:'aple',uncertain:true}],requiresConfirmation:true});
  assert.throws(()=>parseRecognizedRows('{"rows":[{"label":"1","text":"apple"}]}'));
  assert.throws(()=>operationId('short'));
});
function png(width=800,height=600){ const b=Buffer.alloc(33);b.writeUInt32BE(0x89504e47,0);b.writeUInt32BE(0x0d0a1a0a,4);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return 'data:image/png;base64,'+b.toString('base64'); }
export { png };
test('images enforce signatures, byte/pixel limits and reject urls',()=>{
 assert.equal(parseDictationImage(png()).width,800);
 assert.throws(()=>parseDictationImage(png(2401,800)));
 assert.throws(()=>parseDictationImage(png(2200,2200)));
 assert.throws(()=>parseDictationImage(png().replace('image/png','image/jpeg')));
 assert.throws(()=>parseDictationImage('https://example.test/photo.jpg'));
 assert.throws(()=>parseDictationImage('data:image/png;base64,'+'A'.repeat(2_800_004)));
});
test('default recommendation uses trusted journal refs, bounded real defaults, and never invents a path',()=>{
 const other={...row,id:'pep-2',headword:'banana',chineseCore:'香蕉'};
 assert.equal(retrieveDictationCandidates([row,other],parsePlanInput({topic:'everyday',path:'pep-1'}),{recentRefs:['pep-2'],allowDefault:true})[0].wordId,'pep-2');
 assert.equal(retrieveDictationCandidates([row,other],parsePlanInput({topic:'everyday'}),{allowDefault:true}).length,2);
 assert.deepEqual(retrieveDictationCandidates([row],parsePlanInput({text:'未知教材第九册',topic:'everyday'}),{recentRefs:['pep-1'],allowDefault:true}),[]);
 assert.deepEqual(retrieveDictationCandidates([row],parsePlanInput({text:'unfindableword'}),{allowDefault:true}),[]);
 assert.equal(retrieveDictationCandidates([row],parsePlanInput({topic:'everyday',text:'开始听写'}),{allowDefault:true}).length,1);
});
test('common Chinese book/unit aliases match exact source, latest correction replaces old scope',()=>{
 const other={...row,id:'pep-2',headword:'banana',sources:[{bookId:'HS-R2',volume:'必修第二册',unit:'Unit 1'}]};
 const unit10={...row,id:'pep-3',headword:'pear',sources:[{bookId:'HS-R1',volume:'必修第一册',unit:'Unit 10'}]};
 for(const text of ['必修一第一单元','第一册 Unit1','必修第一册 Unit 1']) assert.deepEqual(retrieveDictationCandidates([row,other,unit10],input(text)).map(i=>i.wordId),['pep-1']);
 assert.deepEqual(retrieveDictationCandidates([row,other],parsePlanInput({messages:[{role:'user',text:'必修一'},{role:'user',text:'改成必修二'}]})).map(i=>i.wordId),['pep-2']);
});
test('semantic expansion is opt-in and never overrides a textbook scope or supplied article',()=>{
 assert.equal(allowsTopicWords(parsePlanInput({text:'和冬天（与冬天的意象）有关的单词',allowTopicWords:true})),true);
 assert.equal(allowsTopicWords(input('冬天意象')),false);
 for(const text of ['开始听写','未知教材第九册','必修一冬天的词','Unit 2 winter','HS-R9','JH-7A','textbook winter']) assert.equal(allowsTopicWords(parsePlanInput({text,allowTopicWords:true})),false,text);
 assert.equal(allowsTopicWords(parsePlanInput({text:'与冬天意象有关的词，适合高中水平',allowTopicWords:true})),true);
 assert.equal(allowsTopicWords(parsePlanInput({text:'冬天',allowTopicWords:true,articleCandidates:[{id:'article:one',text:'The winter sun.',source:'用户片段'}]})),false);
 assert.throws(()=>parsePlanInput({allowTopicWords:'true'}));
});
test('theme words reuse trusted textbook records and mark additional words as AI instead of inventing provenance',()=>{
 const content=JSON.stringify({itemIds:[],words:[{word:' Apple ',meaning:'FAKE',source:'伪造出处',wordId:'fake'},{word:'frost',meaning:'霜',source:'伪造教材',id:'word:fake'}]});
 const result=parseDictationPlan(content,[],{allowTopicWords:true,rows:[row]});
 assert.deepEqual(result.items[0],{id:'word:pep-1',wordId:'pep-1',mode:'words',text:'apple',hint:'苹果',source:'必修第一册 Unit 1'});
 assert.deepEqual(result.items[1],{id:'ai-word:frost',mode:'words',text:'frost',hint:'霜',source:'AI 主题选词'});
 assert.throws(()=>parseDictationPlan(content,[]),'strict callers cannot create new targets');
 assert.throws(()=>parseDictationPlan('{"itemIds":["fake"],"words":[]}',[],{allowTopicWords:true,rows:[row]}));
});
test('theme parsing bounds and deduplicates English targets, excluding unreleased lexicon records',()=>{
 const candidates=retrieveDictationCandidates([row],input('apple'));
 const result=parseDictationPlan(JSON.stringify({itemIds:['word:pep-1'],words:[{word:'APPLE',meaning:'苹果'},{word:'snow  covered',meaning:'被雪覆盖的'},{word:'snow covered',meaning:'被雪覆盖的'},{word:'frost',meaning:'霜'}]}),candidates,{allowTopicWords:true,rows:[{...row,headword:'frost',flags:{formalReleaseEligible:false}}]});
 assert.deepEqual(result.items.map(item=>item.id),['word:pep-1','ai-word:snow_covered','ai-word:frost']);
 const parse=words=>parseDictationPlan(JSON.stringify({itemIds:[],words}),[],{allowTopicWords:true});
 for(const word of ['雪','<script>','one two three four five six seven','x'.repeat(81),'https://bad.test']) assert.throws(()=>parse([{word,meaning:'词义'}]),word);
 assert.throws(()=>parse([{word:'frost',meaning:''}]));
 assert.throws(()=>parse([{word:'frost',meaning:'长'.repeat(141)}]));
 assert.throws(()=>parse(Array.from({length:21},()=>({word:'frost',meaning:'霜'}))));
});
