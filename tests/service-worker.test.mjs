import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const handlers = {}, stored = new Map(), deleted = [];
let failure = false, status = 200;
const cache = { async match(request) { return stored.get(request.url)?.clone(); }, async put(request, response) { stored.set(request.url, response.clone()); } };
const runtime = {
  URL, Request, Response, console,
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
