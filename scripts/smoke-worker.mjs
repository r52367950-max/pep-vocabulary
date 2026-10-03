import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { legacyAiCredential } from '../tests/legacy-ai-credential.mjs';
const paths = readdirSync('dist/server', { recursive: true }).filter(p => p.endsWith('.js')).sort((a,b) => a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b));
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'pep-smoke', modules: paths.map(p => ({ type: 'ESModule', path: resolve('dist/server', p) })), modulesRoot: 'dist/server', compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB', 'LEGACY'], bindings: { IDENTITY_TRUSTED_HOSTS: 'localhost', AI_ALLOWED_PROVIDER_ORIGINS: 'https://api.example.com', AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }, assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true } } }));
const results = [];
try {
  const ready = await mf.ready;
  // dispatchFetch's Undici transport replaces Host with its internal listener
  // address, even when a Host was supplied. Exercise actual HTTP authority via
  // Node's HTTP client while connecting only to the local workerd listener.
  const dispatchHttp = (url, init = {}) => new Promise((resolveResponse, reject) => {
    const authority = new URL(url);
    const headers = new Headers(init.headers);
    headers.set('host', authority.host);
    const target = new URL(authority.pathname + authority.search, ready);
    // Negative checks can reject before consuming a body; use an isolated
    // socket so their closed keep-alive connection cannot affect the next case.
    const outgoing = httpRequest(target, { agent: false, method: init.method || 'GET', headers: Object.fromEntries(headers) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolveResponse(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Local Worker HTTP request timed out')));
    outgoing.end(init.body);
  });
  const request = async (path, init) => dispatchHttp(`http://localhost${path}`, init);
  for (const [path, expected] of [['/', 200], ['/sw.js', 200], ['/offline-assets.json', 200], ['/data/v1/index.json', 200], ['/readings/v1/index.json', 200], ['/readings/v1/articles/andersen-real-princess.json', 200], ['/api/sync', 401], ['/api/ai/config', 401]]) {
    const response = await request(path);
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text.slice(0, 120)}`);
    results.push({ path, status: response.status, bytes: Buffer.byteLength(text) });
    if (path === '/') {
      assert.match(text, /词迹/);
      assert.doesNotMatch(response.headers.get('cache-control') || '', /\bno-store\b/i, 'The public app shell must be cacheable for offline installation');
      const csp = response.headers.get('content-security-policy') || '';
      const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
      assert.ok(nonce, 'document CSP must carry a nonce');
      const inline = [...text.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)];
      assert.ok(inline.length > 0 && inline.every(m => m[1].includes(`nonce="${nonce}"`)), 'every inline script carries the nonce');
      for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(directive), directive);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('referrer-policy'));
      assert.ok(response.headers.get('permissions-policy'));
    }
    if (path.startsWith('/api/')) assert.match(response.headers.get('cache-control') || '', /no-store/);
    if (path === '/sw.js') assert.match(text, /vocab-shell-v2-[a-f0-9]{16}/);
    if (path === '/offline-assets.json') {
      const assets = JSON.parse(text);
      assert.ok(assets.length > 0);
      for (const asset of assets) assert.equal((await request(asset)).status, 200, asset);
    }
  }
  for (const [name, headers, body, status] of [
    ['unauthenticated', {'x-vocab-action':'reading-classify'}, {title:'A test article',text:'This is an English reading sample. '.repeat(5)}, 401],
    ['cross-origin', {origin:'https://evil.test','x-vocab-action':'reading-classify'}, {title:'A test article',text:'This is an English reading sample. '.repeat(5)}, 403],
    ['oversized input', {'x-vocab-action':'reading-classify'}, {title:'A test article',text:'x'.repeat(8001)}, 400],
  ]) {
    const result = await request('/api/reading/classify', {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal(result.status,status,await result.clone().text());
    assert.match(result.headers.get('cache-control') || '',/no-store/);
    results.push({path:`/api/reading/classify ${name}`,status:result.status});
  }
  const put = await request('/api/sync', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(put.status, 405);
  assert.match(put.headers.get('allow') || '', /GET/);
  assert.equal((await put.json()).code, 'method_not_allowed');
  results.push({ path: 'PUT /api/sync', status: put.status });
  const response = await request('/api/ai/config', { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: '{}' });
  assert.equal(response.status, 403);
  results.push({ path: '/api/ai/config cross-origin', status: response.status });
  const db = await mf.getD1Database('DB');
  const bootstrap = async (target) => {
    await target.exec('CREATE TABLE IF NOT EXISTS smoke_migrations (name TEXT PRIMARY KEY)');
    for (const file of readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) {
      if (await target.prepare('SELECT name FROM smoke_migrations WHERE name=?').bind(file).first()) continue;
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) {
        if (statement.trim()) await target.exec(statement.replace(/\n/g, ' '));
      }
      await target.prepare('INSERT INTO smoke_migrations (name) VALUES (?)').bind(file).run();
    }
  };
  await bootstrap(db);
  // A previous hosting release can have this table without the migration ledger.
  // Seed the observed legacy shape independently, including data that must survive.
  const legacy = await mf.getD1Database('LEGACY');
  await legacy.exec('CREATE TABLE ai_rate_limits (bucket_key TEXT PRIMARY KEY NOT NULL, request_count INTEGER DEFAULT 1 NOT NULL, expires_at INTEGER NOT NULL)');
  await legacy.prepare('INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)').bind('legacy-bucket', 7, 1999999999).run();
  await bootstrap(legacy);
  assert.equal((await legacy.prepare('SELECT request_count FROM ai_rate_limits WHERE bucket_key = ?').bind('legacy-bucket').first()).request_count, 7);
  results.push({ path: 'database bootstrap with existing legacy rate limit table', status: 'passed', preservedRequests: 7 });
  // Test-only identity and credential. No requests are sent to any AI provider.
  const headers = { 'oai-authenticated-user-email': 'smoke@example.test', 'content-type': 'application/json', 'x-vocab-action': 'settings' };
  const synthetic = await mf.dispatchFetch('http://localhost/api/ai/config', { headers });
  assert.equal(synthetic.status, 401, await synthetic.clone().text());
  results.push({ path: '/api/ai/config identity on synthetic internal transport hostname', status: synthetic.status });
  for (const path of ['/api/sync', '/api/ai/config']) {
    const denied = await dispatchHttp(`http://preview.workers.dev${path}`, { headers: { ...headers, host: 'preview.workers.dev' } });
    assert.equal(denied.status, 401, await denied.clone().text());
    results.push({ path: `${path} forged identity on untrusted hostname`, status: denied.status });
  }
  const testConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key-for-local-smoke-only-012345', dailyLimit: 30, timeoutSeconds: 25, dailyTokenBudget: 50000, maxOutputTokens: 2000 };
  const config = await request('/api/ai/config', { method: 'POST', headers, body: JSON.stringify(testConfig) });
  assert.equal(config.status, 200, await config.clone().text());
  const publicConfig = await config.text();
  assert.equal(JSON.parse(publicConfig).hasApiKey, true);
  assert.equal(JSON.parse(publicConfig).dailyTokenBudget, 50000);
  assert.equal(JSON.parse(publicConfig).maxOutputTokens, 2000);
  assert.doesNotMatch(publicConfig, /test-key|encryptedApiKey|keyIv/);
  results.push({ path: '/api/ai/config authenticated save', status: 200 });
  const savedRow = await db.prepare('SELECT * FROM ai_configs').first();
  const legacyKey = await legacyAiCredential(testConfig.apiKey, Buffer.alloc(32, 7).toString('base64'));
  await db.prepare('UPDATE ai_configs SET encrypted_api_key=?, key_iv=?, encryption_version=1 WHERE user_key=?')
    .bind(legacyKey.encryptedApiKey, legacyKey.keyIv, savedRow.user_key).run();
  const legacyBefore = await db.prepare('SELECT * FROM ai_configs').first();
  const legacyPublic = await (await request('/api/ai/config', { headers })).json();
  assert.equal(legacyPublic.hasApiKey, false);
  assert.equal(legacyPublic.requiresKeyReentry, true);
  const refused = await request('/api/ai/config', { method: 'POST', headers, body: JSON.stringify({ ...testConfig, apiKey: '' }) });
  assert.equal(refused.status, 400, await refused.clone().text());
  assert.equal((await refused.json()).code, 'credential_reentry_required');
  assert.deepEqual(await db.prepare('SELECT * FROM ai_configs').first(), legacyBefore);
  results.push({ path: '/api/ai/config legacy key refuses blank save and preserves original row', status: 'passed' });
  const reentered = await request('/api/ai/config', { method: 'POST', headers, body: JSON.stringify(testConfig) });
  assert.equal(reentered.status, 200, await reentered.clone().text());
  assert.equal((await reentered.json()).requiresKeyReentry, false);
  assert.equal((await db.prepare('SELECT * FROM ai_configs').first()).encryption_version, 2);
  results.push({ path: '/api/ai/config owner key reentry restores scoped credential', status: 'passed' });
  const body = JSON.stringify({ schemaVersion: '1.2.0', baseRevision: 0, clientUpdatedAt: new Date().toISOString(), payload: { schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] } });
  const writes = await Promise.all([request('/api/sync', { method: 'POST', headers, body }), request('/api/sync', { method: 'POST', headers, body })]);
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
  results.push({ path: '/api/sync concurrent first upload', statuses: [200, 409] });
  const metadata = await request('/api/sync?metadata=1', { headers });
  const metadataBody = await metadata.json();
  assert.equal(metadataBody.state.revision, 1);
  assert.equal('payload' in metadataBody.state, false);
  results.push({ path: '/api/sync metadata-only read', status: metadata.status });
  // Replaying bootstrap SQL must not reset cloud snapshots or encrypted settings.
  const snapshotsBefore = (await db.prepare('SELECT * FROM sync_states').all()).results;
  assert.equal(snapshotsBefore.length, 1);
  await bootstrap(db);
  assert.deepEqual((await db.prepare('SELECT * FROM sync_states').all()).results, snapshotsBefore);
  const persistedConfig = await request('/api/ai/config', { headers });
  assert.equal(persistedConfig.status, 200);
  assert.equal((await persistedConfig.json()).hasApiKey, true);
  results.push({ path: 'database bootstrap replay preserves snapshots and encrypted configuration', status: 'passed' });
  assert.equal((await request('/api/ai/config', { method: 'DELETE', headers })).status, 200);
  console.log(JSON.stringify({ runtime: 'workerd via Miniflare, local ephemeral D1', results }, null, 2));
} finally { await mf.dispose(); }
