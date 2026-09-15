import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { countReadingWords, lengthBand, validLibraryArticle, validReadingMeta, safeSourceUrl, loadLibraryArticle, matchReadingWords } from '../lib/reading-library.ts';
import { normalizeReadingText, validateImportedText, markdownText, parseClassification, pdfReadingText, imageDimensions } from '../lib/reading-import.ts';

const article = JSON.parse(await readFile(new URL('../public/readings/v1/articles/a-place-to-begin.json', import.meta.url), 'utf8'));
test('reading metadata, independent length bands and word counts remain consistent', () => {
  assert.ok(validReadingMeta(article)); assert.ok(validLibraryArticle(article, article.id));
  assert.deepEqual([249,250,499,500,899,900].map(lengthBand), [1,2,2,3,3,4]);
  assert.equal(countReadingWords(article.paragraphs.map(p=>p.en).join(' ')), article.wordCount);
});
test('external links and body identity are validated before rendering', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,a', 'http://example.com', 'https://user:pass@example.com', '//example.com']) assert.equal(safeSourceUrl(url), false);
  assert.equal(validLibraryArticle(article, 'different-article'), false);
  assert.equal(validLibraryArticle({...article, paragraphs:[{en:'cut off'}]}, article.id), false);
  assert.equal(validReadingMeta({...article, category:'__proto__'}), false);
});
test('article loading rejects traversal, redirected/html data, and mismatched JSON', async () => {
  const old = globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}});};
  try {
    await assert.rejects(loadLibraryArticle('../private', new AbortController().signal)); assert.equal(calls,0);
    await assert.rejects(loadLibraryArticle('not-html', new AbortController().signal));
    globalThis.fetch=async()=>new Response(JSON.stringify(article),{headers:{'content-type':'application/json'}});
    await assert.rejects(loadLibraryArticle('wrong-identity', new AbortController().signal));
  } finally { globalThis.fetch=old; }
});
test('word matching is bounded, deduplicated and preserves curated target order', () => {
  const index=[{id:'a',headword:'anxious'},{id:'b',headword:'volunteer'},{id:'c',headword:'anxious'}];
  assert.deepEqual(matchReadingWords([{en:'The anxious volunteer was anxious.'}],index).map(x=>x.id), ['a','b']);
  assert.deepEqual(matchReadingWords([],index,['volunteer','anxious']).map(x=>x.id), ['b','a']);
});
test('import normalization preserves paragraphs while reflowing hard line breaks', () => {
  assert.equal(normalizeReadingText('\uFEFFThe read-\ning\r\nroom.\r\n\r\nAnother\nparagraph.'),'The reading room.\n\nAnother paragraph.');
  assert.equal(markdownText('# Title\n\nRead **well** and [learn](https://example.com).'),'Title\n\nRead well and learn.');
  assert.throws(()=>validateImportedText('Too short.'));
  assert.throws(()=>validateImportedText('word '.repeat(6001)));
});
test('AI classification accepts only the closed enum and never changes text', () => {
  assert.deepEqual(parseClassification('```json\n{"category":"essay","difficulty":"B2","html":"<script>bad</script>"}\n```'),{category:'essay',difficulty:'B2'});
  for (const input of ['{}','null','{"category":"__proto__","difficulty":"B2"}','{"category":"science","difficulty":"easy"}']) assert.throws(()=>parseClassification(input));
});
test('PDF extraction retains paragraph gaps and reflows wrapped lines', () => {
  const items = [
    {str:'The first paragraph starts',transform:[12,0,0,12,40,700],width:250,height:12,hasEOL:true},
    {str:'and continues here.',transform:[12,0,0,12,40,684],width:100,height:12,hasEOL:true},
    {str:'A new paragraph begins.',transform:[12,0,0,12,40,652],width:200,height:12,hasEOL:true},
  ];
  assert.equal(normalizeReadingText(pdfReadingText(items)),'The first paragraph starts and continues here.\n\nA new paragraph begins.');
});
test('large imported paragraphs split at sentence boundaries without losing words', () => {
  const body = 'Every reader can learn something useful from this simple story. '.repeat(360);
  const normalized = validateImportedText(body);
  assert.ok(normalized.includes('\n\n'));
  assert.equal(countReadingWords(normalized), countReadingWords(body));
  assert.ok(normalized.split('\n\n').every(p=>p.length<=16000));
  assert.throws(()=>validateImportedText(('One two.\n\n').repeat(301)),/300/);
});
test('image size checks inspect PNG headers before decoding and reject broken files', () => {
  const bytes = new Uint8Array(32); const view = new DataView(bytes.buffer);
  view.setUint32(0,0x89504e47); view.setUint32(4,0x0d0a1a0a); view.setUint32(16,3000); view.setUint32(20,4000);
  assert.deepEqual(imageDimensions(bytes),[3000,4000]);
  assert.equal(imageDimensions(new Uint8Array(2)),null);
  assert.equal(imageDimensions(new Uint8Array(100)),null);
});
