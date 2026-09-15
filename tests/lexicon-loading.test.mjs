import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLexicon, loadDetails } from '../lib/lexicon.ts';

const calls = new Map();
let failChunk = true;
const index = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const manifest = { chunks: [{ file: 'chunks/one.json', count: 1 }, { file: 'chunks/two.json', count: 2 }] };
globalThis.fetch = async url => {
  calls.set(url, (calls.get(url) || 0) + 1);
  await new Promise(resolve => setImmediate(resolve));
  if (url.endsWith('index.json')) return Response.json(index);
  if (url.endsWith('manifest.json')) return Response.json(manifest);
  if (url.endsWith('one.json')) return Response.json([index[0]]);
  if (url.endsWith('two.json') && failChunk) { failChunk = false; return new Response('', { status: 503 }); }
  return Response.json(index.slice(1));
};
test('concurrent index loads share one pair of requests', async () => {
  await Promise.all(Array.from({ length: 20 }, () => loadLexicon()));
  assert.equal(calls.get('/data/v1/index.json'), 1);
  assert.equal(calls.get('/data/v1/manifest.json'), 1);
});
test('chunk mapping follows manifest counts and retries failures without duplicate requests', async () => {
  const failed = await Promise.allSettled([loadDetails(['b']), loadDetails(['c'])]);
  assert.ok(failed.every(r => r.status === 'rejected'));
  assert.equal(calls.get('/data/v1/chunks/two.json'), 1);
  const [b, c, a] = await Promise.all([loadDetails(['b']), loadDetails(['c']), loadDetails(['a'])]);
  assert.equal(b[0].id, 'b'); assert.equal(c[0].id, 'c'); assert.equal(a[0].id, 'a');
  assert.equal(calls.get('/data/v1/chunks/two.json'), 2);
  await loadDetails(['a', 'b', 'c']);
  assert.equal(calls.get('/data/v1/chunks/one.json'), 1);
  assert.equal(calls.get('/data/v1/chunks/two.json'), 2);
});
