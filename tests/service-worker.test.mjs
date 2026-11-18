import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const handlers = {}, stored = new Map(), deleted = [];
let failure = false, status = 200;
const cache = { async match(request) { return stored.get(request.url)?.clone(); }, async put(request, response) { stored.set(request.url, response.clone()); } };
const runtime = {
  URL, Request, Response, Headers, console,
  self: { location: { origin: 'https://app.test' }, clients: { async claim() {} }, addEventListener(type, fn) { handlers[type] = fn; } },
  caches: { async open() { return cache; }, async keys() { return ['vocab-shell-old', 'unrelated-app-cache']; }, async delete(key) { deleted.push(key); } },
  async fetch() { if (failure) throw new Error('offline'); return new Response('asset', { status }); },
};
vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), runtime);
function event(path, mode = 'cors', headers = {}) {
  const request = new Request(`https://app.test${path}`, { headers });
  Object.defineProperty(request, 'mode', { value: mode });
  const pending = [];
  const result = { request, waitUntil(promise) { pending.push(promise); }, respondWith(promise) { result.response = promise; }, async finish() { await Promise.all(pending); return result.response; } };
  handlers.fetch(result);
  return result;
}
test('private APIs, sign-in routes, and RSC requests bypass service-worker caches', () => {
  for (const path of ['/api/sync', '/api/ai/config', '/signin-with-chatgpt', '/signout-with-chatgpt', '/callback', '/?_rsc=x']) assert.equal(event(path, 'navigate').response, undefined, path);
  assert.equal(event('/', 'cors', { rsc: '1' }).response, undefined);
});
test('Vite /assets JavaScript is cached for offline revisits', async () => {
  const online = await event('/assets/app-hash.js').finish();
  assert.equal(await online.text(), 'asset');
  failure = true;
  try { assert.equal(await (await event('/assets/app-hash.js').finish()).text(), 'asset'); }
  finally { failure = false; }
});
test('cache open and lookup failures cannot break online navigation or assets', async () => {
  const originalOpen = runtime.caches.open;
  const originalMatch = cache.match;
  for (const operation of ['open', 'match']) {
    try {
      if (operation === 'open') runtime.caches.open = async () => { throw new Error('Storage unavailable'); };
      else cache.match = async () => { throw new Error('Cache read failed'); };
      for (const [path, mode] of [['/', 'navigate'], ['/assets/uncached.js', 'cors']]) {
        const response = await event(path, mode).finish();
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'asset');
      }
      status = 503;
      assert.equal((await event('/', 'navigate').finish()).status, 503);
    } finally {
      runtime.caches.open = originalOpen;
      cache.match = originalMatch;
      status = 200;
    }
  }
});
test('navigation errors cannot overwrite a valid offline shell', async () => {
  await event('/', 'navigate').finish();
  status = 503;
  const response = await event('/', 'navigate').finish();
  assert.equal(response.status, 200);
  status = 200;
  failure = true;
  try { assert.equal(await (await event('/', 'navigate').finish()).text(), 'asset'); }
  finally { failure = false; }
});
test('activation only removes this application cache namespace', async () => {
  let completion;
  handlers.activate({ waitUntil(promise) { completion = promise; } });
  await completion;
  assert.deepEqual(deleted, ['vocab-shell-old']);
});

async function prepareLexicon(source) {
  stored.set('https://app.test/data/v1/manifest.json', new Response(JSON.stringify({ chunks: [{ file: 'chunks/a.json' }] })));
  stored.set('https://app.test/data/v1/chunks/a.json', new Response('{}'));
  const replies = [];
  const pending = [];
  handlers.message({ data: { type: 'PREPARE_LEXICON' }, ports: [{ postMessage: (value) => replies.push(value) }], source, waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return { replies, scheduled: pending.length };
}
test('PREPARE_LEXICON is accepted from same-origin clients only', async () => {
  const own = await prepareLexicon({ url: 'https://app.test/', id: 'client-1' });
  assert.equal(JSON.stringify(own.replies), JSON.stringify([{ ok: true, files: 1 }]));
  for (const source of [undefined, null, {}, { url: 'https://evil.test/' }, { url: 'https://app.test.evil.test/' }, { url: 'not a url' }, { url: 42 }]) {
    const result = await prepareLexicon(source);
    assert.deepEqual(result, { replies: [], scheduled: 0 }, JSON.stringify(source));
  }
});
test('static host headers keep the immutable asset cache rule and add baseline security headers', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable$/m);
  for (const line of ['X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy: same-origin', 'Cross-Origin-Resource-Policy: same-origin']) assert.ok(headers.includes(`  ${line}\n`), line);
  assert.doesNotMatch(headers.replace(/^#.*$/gm, ''), /Strict-Transport-Security/i);
});

test('simultaneous offline preparations share each chunk and a failed batch can be retried', async () => {
  const chunks = JSON.parse(readFileSync(new URL('../public/data/v1/manifest.json', import.meta.url))).chunks;
  const originalFetch = runtime.fetch;
  const requests = [];
  let unavailable = true;
  runtime.AbortSignal = AbortSignal;
  runtime.fetch = async request => {
    requests.push(request.url);
    return new Response('{}', { status: unavailable ? 503 : 200 });
  };
  stored.set('https://app.test/data/v1/manifest.json', Response.json({ chunks }));
  function prepare() {
    let pending, reply;
    handlers.message({
      source: { url: 'https://app.test/' }, data: { type: 'PREPARE_LEXICON' },
      ports: [{ postMessage(value) { reply = value; } }],
      waitUntil(promise) { pending = promise; },
    });
    return pending.then(() => reply);
  }
  try {
    assert.ok((await Promise.all([prepare(), prepare()])).every(reply => !reply.ok));
    unavailable = false;
    requests.length = 0;
    const replies = await Promise.all([prepare(), prepare()]);
    assert.ok(replies.every(reply => reply.ok && reply.files === chunks.length));
    assert.equal(new Set(requests).size, chunks.length);
    assert.equal(requests.length, chunks.length);
    assert.equal((await prepare()).files, chunks.length);
    assert.equal(requests.length, chunks.length);
  } finally {
    runtime.fetch = originalFetch;
  }
});

test('same-origin CORS preloads and headerless downloads share a public asset cache key', async () => {
  const originalMatch = cache.match, originalPut = cache.put;
  const variants = new Map();
  const key = request => JSON.stringify([request.url, request.headers.get('origin'), request.headers.get('accept-language')]);
  cache.match = async request => variants.get(key(request))?.clone();
  cache.put = async (request, response) => variants.set(key(request), response.clone());
  try {
    const path = '/data/v1/manifest.json';
    await event(path, 'cors', { origin: 'https://app.test', 'accept-language': 'zh' }).finish();
    failure = true;
    assert.equal(await (await event(path, 'cors', { 'accept-language': 'zh' }).finish()).text(), 'asset');
    await assert.rejects(event(path, 'cors', { 'accept-language': 'en' }).finish(), /offline/);
  } finally {
    failure = false;
    cache.match = originalMatch;
    cache.put = originalPut;
  }
});
