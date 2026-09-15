import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const paths = readdirSync('dist/server', { recursive: true }).filter(p => p.endsWith('.js')).sort((a,b) => a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b));
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'pep-smoke', modules: paths.map(p => ({ type: 'ESModule', path: resolve('dist/server', p) })), modulesRoot: 'dist/server', compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB', 'LEGACY'], bindings: { AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }, assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true } } }));
const results = [];
try {
  const request = async (path, init) => mf.dispatchFetch(`http://localhost${path}`, init);
  for (const [path, expected] of [['/', 200], ['/sw.js', 200], ['/offline-assets.json', 200], ['/data/v1/index.json', 200], ['/readings/v1/index.json', 200], ['/readings/v1/articles/andersen-real-princess.json', 200], ['/api/sync', 401], ['/api/ai/config', 401]]) {
    const response = await request(path);
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text.slice(0, 120)}`);
    results.push({ path, status: response.status, bytes: Buffer.byteLength(text) });
    if (path === '/') {
      assert.match(text, /词迹/);
      assert.doesNotMatch(response.headers.get('cache-control') || '', /\bno-store\b/i, 'The public app shell must be cacheable for offline installation');
    }
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
  const response = await request('/api/ai/config', { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json', 'x-vocab-action': 'settings' }, body: '{}' });
  assert.equal(response.status, 403);
  results.push({ path: '/api/ai/config cross-origin', status: response.status });
  const db = await mf.getD1Database('DB');
  const bootstrap = async (target) => {
    for (const file of readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) {
        if (statement.trim()) await target.exec(statement.replace(/\n/g, ' '));
      }
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
  const config = await request('/api/ai/config', { method: 'POST', headers, body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key-for-local-smoke-only-012345', dailyLimit: 30, timeoutSeconds: 25 }) });
  assert.equal(config.status, 200, await config.clone().text());
  const publicConfig = await config.text();
  assert.equal(JSON.parse(publicConfig).hasApiKey, true);
  assert.doesNotMatch(publicConfig, /test-key|encryptedApiKey|keyIv/);
  results.push({ path: '/api/ai/config authenticated save', status: 200 });
  const body = JSON.stringify({ schemaVersion: '1.1.0', baseRevision: 0, clientUpdatedAt: new Date().toISOString(), payload: { schemaVersion: '1.1.0', cards: [], events: [], lists: [], settings: [] } });
  const writes = await Promise.all([request('/api/sync', { method: 'POST', headers, body }), request('/api/sync', { method: 'POST', headers, body })]);
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
  results.push({ path: '/api/sync concurrent first upload', statuses: [200, 409] });
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
