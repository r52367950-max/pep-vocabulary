import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { sqliteD1 } from './sqlite-d1.mjs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { legacyAiCredential } from './legacy-ai-credential.mjs';
import { getChatGPTUser, identityHostTrusted } from '../app/chatgpt-auth.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';
import { encryptApiKey, decryptApiKey, reencryptApiKey, refreshStoredCredential } from '../lib/ai-config.ts';
import { GET as configGet, POST as configPost } from '../app/api/ai/config/route.ts';
import { GET as syncGet } from '../app/api/sync/route.ts';
import { POST as explain } from '../app/api/assistant/explain/route.ts';
import { POST as classify } from '../app/api/reading/classify/route.ts';
import { POST as testConnection } from '../app/api/ai/test/route.ts';

const db = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
}
const key = Buffer.alloc(32, 27).toString('base64');
const secret = 'test-only-legacy-credential-0123456789';
const settings = { provider: 'openai-compatible', baseUrl: 'https://api.example.test/v1', model: 'test-model', dailyLimit: 30, timeoutSeconds: 25 };
const word = { id: 'pep-1e3e7e41accdc5f7', headword: 'abandon', chineseCore: '放弃', partsOfSpeech: ['vt'], scopes: [], sources: [], flags: { formalReleaseEligible: true } };
const request = (path, body, action = 'settings') => new Request(`https://app.test${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-vocab-action': action }, body: JSON.stringify(body) });
beforeEach(() => {
  db.exec('DELETE FROM ai_configs; DELETE FROM ai_preferences; DELETE FROM ai_rate_limits; DELETE FROM sync_states;');
  env.DB = sqliteD1(db);
  env.AI_CONFIG_ENCRYPTION_KEY = key;
  delete env.AI_CONFIG_ENCRYPTION_KEYS;
  delete env.AI_CONFIG_ENCRYPTION_KEY_ACTIVE;
  env.IDENTITY_TRUSTED_HOSTS = 'app.test';
  requestHeaders.set('host', 'app.test');
  requestHeaders.set('oai-authenticated-user-email', 'owner@example.test');
  env.ASSETS = { fetch: async () => Response.json([word]) };
});
async function seedLegacy(scopeOverrides = {}) {
  const userKey = await authenticatedUserKey();
  const row = await legacyAiCredential(secret, key);
  const scope = { userKey, provider: settings.provider, baseUrl: settings.baseUrl, ...scopeOverrides };
  db.prepare('INSERT INTO ai_configs (user_key, provider, base_url, model, encrypted_api_key, key_iv, encryption_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(scope.userKey, scope.provider, scope.baseUrl, settings.model, row.encryptedApiKey, row.keyIv, row.encryptionVersion);
  return { row, scope };
}

test('missing or invalid trusted-host configuration never authenticates a forged gateway email', async () => {
  const stableKey = await authenticatedUserKey();
  assert.match(stableKey, /^[a-f0-9]{64}$/);
  for (const setting of [undefined, null, '', ' ', 42, 'app.test,', ',app.test', 'app.test,https://other.test', 'app.test,*.test']) {
    if (setting === undefined) delete env.IDENTITY_TRUSTED_HOSTS; else env.IDENTITY_TRUSTED_HOSTS = setting;
    assert.equal(identityHostTrusted('app.test', setting), false, String(setting));
    assert.equal(await getChatGPTUser(), null);
    assert.equal(await authenticatedUserKey(), null);
    assert.equal((await configGet()).status, 401);
    assert.equal((await syncGet()).status, 401);
  }
  env.IDENTITY_TRUSTED_HOSTS = 'app.test';
  assert.equal(await authenticatedUserKey(), stableKey);
  requestHeaders.set('host', 'preview.workers.dev');
  assert.equal(await getChatGPTUser(), null);
});

test('host allowlists accept exact DNS names and reject ambiguous host syntax', () => {
  for (const host of ['App.Test:443', 'app.test.', 'app.test.:443']) assert.equal(identityHostTrusted(host, 'APP.TEST,other.test'), true, host);
  for (const host of [null, '', 'app.test,evil.test', 'app.test@evil.test', 'app.test/anything', 'app.test:0', 'app.test:65536', 'app.test:abc', 'app.test:443:443', '[::1]', 'app..test', '-app.test', 'app.test.evil.test']) {
    assert.equal(identityHostTrusted(host, 'app.test'), false, String(host));
  }
  for (const setting of ['https://app.test', 'app.test:443', 'app.test/path', 'app..test', '-app.test', 'app.test,other..test', '*.test']) {
    assert.equal(identityHostTrusted('app.test', setting), false, setting);
  }
});

test('v1 ciphertext cannot be created, decrypted or migrated, even with a supplied plaintext', async () => {
  const { row, scope } = await seedLegacy();
  for (const invalid of [undefined, null, {}, { ...scope, userKey: '' }, { ...scope, provider: '' }, { ...scope, baseUrl: '' }]) {
    await assert.rejects(encryptApiKey(secret, invalid));
  }
  for (const changed of [scope, { ...scope, userKey: 'other-user' }, { ...scope, provider: 'deepseek' }, { ...scope, baseUrl: 'https://other.example.test/v1' }]) {
    await assert.rejects(decryptApiKey(row.encryptedApiKey, row.keyIv, 1, changed));
    await assert.rejects(reencryptApiKey(row, changed));
    await assert.rejects(reencryptApiKey(row, changed, secret));
  }
  let writes = 0;
  assert.equal(await refreshStoredCredential({ prepare() { writes++; throw new Error('unexpected migration'); } }, row, scope, secret), false);
  assert.equal(writes, 0);
});

test('legacy or rebound v1 configurations cannot trigger any outbound AI request or lazy migration', async () => {
  await seedLegacy({ baseUrl: 'https://observed.example.test/v1' });
  const before = db.prepare('SELECT * FROM ai_configs').all();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected outbound call'); };
  try {
    for (const [handler, path, body, action] of [
      [explain, '/api/assistant/explain', { wordId: word.id }, 'assistant'],
      [classify, '/api/reading/classify', { title: 'Sample article', text: 'This is an English article for our local test. '.repeat(5) }, 'reading-classify'],
      [testConnection, '/api/ai/test', {}, 'settings'],
    ]) {
      const response = await handler(request(path, body, action));
      assert.equal(response.status, 503, await response.clone().text());
      assert.equal((await response.json()).error.code, 'credential_reentry_required');
    }
    assert.equal(calls, 0);
    assert.deepEqual(db.prepare('SELECT * FROM ai_configs').all(), before);
  } finally { globalThis.fetch = originalFetch; }
});

test('public legacy config requests reentry without exposing or discarding stored settings', async () => {
  await seedLegacy();
  const response = await configGet();
  assert.equal(response.status, 200);
  const text = await response.text();
  const config = JSON.parse(text);
  assert.equal(config.hasApiKey, false);
  assert.equal(config.requiresKeyReentry, true);
  assert.equal(config.baseUrl, settings.baseUrl);
  assert.equal(config.model, settings.model);
  assert.doesNotMatch(text, /encryptedApiKey|keyIv|encryptionVersion|test-only-legacy/);
});

test('saving a legacy configuration requires key reentry and leaves the original row unchanged on refusal', async () => {
  await seedLegacy();
  const before = db.prepare('SELECT * FROM ai_configs').all();
  const response = await configPost(request('/api/ai/config', settings));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'credential_reentry_required');
  assert.deepEqual(db.prepare('SELECT * FROM ai_configs').all(), before);
});

for (const version of [2, 3]) test(`owner key reentry replaces the legacy secret with scoped v${version} and keeps settings usable`, async () => {
  if (version === 3) {
    env.AI_CONFIG_ENCRYPTION_KEYS = JSON.stringify({ k1: key, k2: Buffer.alloc(32, 28).toString('base64') });
    env.AI_CONFIG_ENCRYPTION_KEY_ACTIVE = 'k2';
  }
  const { scope } = await seedLegacy();
  const response = await configPost(request('/api/ai/config', { ...settings, apiKey: secret, dailyTokenBudget: 50_000, maxOutputTokens: 2000 }));
  assert.equal(response.status, 200, await response.clone().text());
  const publicConfig = await response.json();
  assert.equal(publicConfig.hasApiKey, true);
  assert.equal(publicConfig.requiresKeyReentry, false);
  assert.equal(publicConfig.dailyTokenBudget, 50_000);
  const row = db.prepare('SELECT * FROM ai_configs').get();
  assert.equal(row.encryption_version, version);
  assert.equal(await decryptApiKey(row.encrypted_api_key, row.key_iv, version, scope), secret);
});
