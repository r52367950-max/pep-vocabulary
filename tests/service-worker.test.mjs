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
