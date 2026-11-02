import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { retrieveReadingDictationCandidates, articleDictationSentences } from '../lib/voice/reading-candidates.ts';
import { validLibraryArticle } from '../lib/reading-library.ts';
const catalog = JSON.parse(readFileSync(new URL('../public/readings/v1/index.json', import.meta.url), 'utf8'));
const request = () => new Request('https://app.test/api/voice/dictation-plan');
function fixture(transform) {
  const paths = [];
  const assets = { async fetch(req) {
    const path = new URL(req.url).pathname; paths.push(path);
    let value;
    if (path === '/readings/v1/index.json') value = catalog;
    else {
      const match = /^\/readings\/v1\/articles\/([a-z0-9-]+)\.json$/.exec(path);
      if (!match) throw Error('unexpected path');
      value = JSON.parse(readFileSync(new URL(`../public/readings/v1/articles/${match[1]}.json`, import.meta.url), 'utf8'));
    }
    return Response.json(transform ? transform(value, path) : value);
  } };
  return { assets, paths };
}

test('formal reading title, translated title and ID resolve only verified original sentences', async () => {
  for (const query of ['听写文章《The Real Princess》', '听写真正的公主', 'andersen-real-princess']) {
    const f = fixture(), result = await retrieveReadingDictationCandidates(f.assets, request(), { query });
    assert.equal(result.articleRequested, true); assert.deepEqual(result.titles, ['The Real Princess']);
    assert.ok(result.items.length > 0 && result.items.length <= 12);
    assert.deepEqual(f.paths, ['/readings/v1/index.json', '/readings/v1/articles/andersen-real-princess.json']);
    const article = JSON.parse(readFileSync(new URL('../public/readings/v1/articles/andersen-real-princess.json', import.meta.url), 'utf8'));
    assert.equal(validLibraryArticle(article, article.id), true);
    for (const item of result.items) {
      assert.match(item.id, /^reading:andersen-real-princess:p[0-9]+:s[0-9]+$/);
      assert.equal(item.mode, 'sentences');
      assert.ok(article.paragraphs.some(p => p.en.includes(item.text)), 'targets are unchanged source substrings');
      assert.ok(item.source.includes(article.title)); assert.ok(item.source.includes(article.sourceUrl));
    }
  }
});

test('unknown articles ask for clarification and plain vocabulary never loads article bodies', async () => {
  const missing = fixture();
  const result = await retrieveReadingDictationCandidates(missing.assets, request(), { query: '听写文章《This Article Definitely Does Not Exist 938294》', recentRefs: ['andersen-real-princess'] });
  assert.equal(result.articleRequested, true); assert.deepEqual(result.items, []); assert.match(result.clarification, /没有找到/);
  assert.deepEqual(missing.paths, ['/readings/v1/index.json']);
  const words = fixture();
  const plain = await retrieveReadingDictationCandidates(words.assets, request(), { query: 'book', recentRefs: ['andersen-real-princess'] });
  assert.equal(plain.articleRequested, false); assert.deepEqual(plain.items, []); assert.deepEqual(words.paths, ['/readings/v1/index.json']);
  const noInput = fixture();
  await retrieveReadingDictationCandidates(noInput.assets, request(), { query: '', recentRefs: [] });
  assert.deepEqual(noInput.paths, []);
});

test('generic recommendations may use trusted recent article references and read at most two', async () => {
  const f = fixture();
  const result = await retrieveReadingDictationCandidates(f.assets, request(), { query: '按学习记录推荐', recentRefs: ['../../secret', 'article:andersen-real-princess', 'reading:stevenson-walking-tours:p1:s2', 'noaa-estuaries'] });
  assert.equal(result.articleRequested, true);
  assert.deepEqual(result.titles, ['The Real Princess', 'Walking Tours']);
  assert.equal(f.paths.filter(p => p.includes('/articles/')).length, 2);
  assert.ok(result.items.length <= 24);
  const explicit = fixture();
  const correction = await retrieveReadingDictationCandidates(explicit.assets, request(), { query: '听写文章《Estuaries》', recentRefs: ['andersen-real-princess'] });
  assert.deepEqual(correction.titles, ['Estuaries']);
});

test('invalid catalog, changed article provenance, malformed bodies and cancellation fail before recommendation', async () => {
  const badCatalog = fixture((v, path) => path.endsWith('/index.json') ? [{ ...catalog[0], id: '../../secret' }] : v);
  await assert.rejects(retrieveReadingDictationCandidates(badCatalog.assets, request(), { query: 'The Real Princess' }), e => e.code === 'reading_unavailable');
  assert.equal(badCatalog.paths.length, 1);
  const changed = fixture((v, path) => path.includes('/articles/') ? { ...v, sourceUrl: 'https://different.test/source' } : v);
  await assert.rejects(retrieveReadingDictationCandidates(changed.assets, request(), { query: 'The Real Princess' }), e => e.code === 'reading_unavailable');
  const malformed = fixture((v, path) => path.includes('/articles/') ? { ...v, paragraphs: [{ en: 'Invented content.' }] } : v);
  await assert.rejects(retrieveReadingDictationCandidates(malformed.assets, request(), { query: 'The Real Princess' }), e => e.code === 'reading_unavailable');
  const controller = new AbortController(); controller.abort(); const aborted = fixture();
  await assert.rejects(retrieveReadingDictationCandidates(aborted.assets, new Request(request(), { signal: controller.signal }), { query: 'The Real Princess' }), e => e.code === 'request_aborted');
  assert.equal(aborted.paths.length, 0);
});

test('oversized asset responses are bounded and sentence selection keeps stable source positions', async () => {
  const tooLarge = { fetch: async () => new Response(' '.repeat(500001), { headers: { 'content-type': 'application/json' } }) };
  await assert.rejects(retrieveReadingDictationCandidates(tooLarge, request(), { query: 'The Real Princess' }), e => e.code === 'reading_unavailable');
  const article = JSON.parse(readFileSync(new URL('../public/readings/v1/articles/andersen-real-princess.json', import.meta.url), 'utf8'));
  assert.deepEqual(articleDictationSentences(article), articleDictationSentences(article));
});
