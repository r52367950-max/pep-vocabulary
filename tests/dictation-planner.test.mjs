import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanInput, retrieveDictationCandidates, parseDictationPlan, parseRecognizedRows, parseDictationImage, operationId } from '../lib/voice/dictation-planner.ts';
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
