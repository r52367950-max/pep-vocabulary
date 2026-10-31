import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { env } from 'cloudflare:workers';
import { decryptApiKey, encryptApiKey, needsReencryption, reencryptApiKey, refreshStoredCredential } from '../lib/ai-config.ts';
import { legacyAiCredential } from './legacy-ai-credential.mjs';

const key = (byte) => Buffer.alloc(32, byte).toString('base64');
const K1 = key(21), K2 = key(22), K3 = key(23);
const secret = 'test-only-credential-0123456789';
const scope = { userKey: 'user-a', provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };

function configure({ legacy, keys, active } = {}) {
  for (const name of ['AI_CONFIG_ENCRYPTION_KEY', 'AI_CONFIG_ENCRYPTION_KEYS', 'AI_CONFIG_ENCRYPTION_KEY_ACTIVE']) delete env[name];
  if (legacy !== undefined) env.AI_CONFIG_ENCRYPTION_KEY = legacy;
  if (keys !== undefined) env.AI_CONFIG_ENCRYPTION_KEYS = typeof keys === 'string' ? keys : JSON.stringify(keys);
  if (active !== undefined) env.AI_CONFIG_ENCRYPTION_KEY_ACTIVE = active;
}
const open = (row, forScope = scope) => decryptApiKey(row.encryptedApiKey, row.keyIv, row.encryptionVersion, forScope ?? undefined);
beforeEach(() => configure());

test('legacy master-key environment writes scoped v2 and rejects unscoped v1', async () => {
  configure({ legacy: K1 });
  const v2 = await encryptApiKey(secret, scope);
  assert.equal(v2.encryptionVersion, 2);
  assert.doesNotMatch(v2.encryptedApiKey, /:/);
  assert.equal(await open(v2), secret);
  const v1 = await legacyAiCredential(secret, K1);
  assert.equal(v1.encryptionVersion, 1);
  await assert.rejects(open(v1, null));
  await assert.rejects(encryptApiKey(secret));
  assert.equal(needsReencryption(v2), false);
  assert.throws(() => needsReencryption(v1));
});

test('v2 remains readable across key-set introduction while unscoped v1 stays blocked', async () => {
  configure({ legacy: K1 });
  const v1 = await legacyAiCredential(secret, K1);
  const v2 = await encryptApiKey(secret, scope);
  for (const keys of [{ k1: K1, k2: K2 }, { k2: K2 }]) {
    configure({ legacy: K1, keys, active: 'k2' });
    await assert.rejects(open(v1, null));
    assert.equal(await open(v2), secret);
    assert.throws(() => needsReencryption(v1));
    assert.equal(needsReencryption(v2), true);
  }
  configure({ keys: { k1: K1, k2: K2 }, active: 'k1' });
  assert.equal(await open(v2), secret);
});

test('v3 credentials are written under the active key and bound to key id, user, provider and destination', async () => {
  configure({ keys: { k1: K1, k2: K2 }, active: 'k2' });
  const row = await encryptApiKey(secret, scope);
  assert.equal(row.encryptionVersion, 3);
  assert.match(row.encryptedApiKey, /^k2:[A-Za-z0-9+/]+=*$/);
  assert.equal(await open(row), secret);
  for (const changed of [{ ...scope, userKey: 'user-b' }, { ...scope, provider: 'deepseek' }, { ...scope, baseUrl: 'https://other.example/v1' }]) {
    await assert.rejects(open(row, changed));
  }
  await assert.rejects(open(row, null));
  await assert.rejects(decryptApiKey(row.encryptedApiKey, row.keyIv, 2, scope));
  // Relabelling the ciphertext as another key fails even if that key is present.
  await assert.rejects(open({ ...row, encryptedApiKey: row.encryptedApiKey.replace(/^k2:/, 'k1:') }));
  assert.equal(needsReencryption(row), false);
});

test('a non-active key id is detected and re-encrypted with the active key', async () => {
  configure({ keys: { k1: K1, k2: K2 }, active: 'k1' });
  const old = await encryptApiKey(secret, scope);
  assert.match(old.encryptedApiKey, /^k1:/);
  configure({ keys: { k1: K1, k2: K2 }, active: 'k2' });
  assert.equal(needsReencryption(old), true);
  const next = await reencryptApiKey(old, scope);
  assert.match(next.encryptedApiKey, /^k2:/);
  assert.equal(next.encryptionVersion, 3);
  assert.notEqual(next.keyIv, old.keyIv);
  assert.equal(needsReencryption(next), false);
  assert.equal(await open(next), secret);
  // The old key can be removed once nothing references it.
  configure({ keys: { k2: K2 }, active: 'k2' });
  assert.equal(await open(next), secret);
  await assert.rejects(open(old));
});

test('removing k1 while v3-k2 rows exist still decrypts them', async () => {
  configure({ legacy: K1, keys: { k1: K1, k2: K2 }, active: 'k2' });
  const row = await encryptApiKey(secret, scope);
  configure({ keys: { k2: K2 }, active: 'k2' });
  assert.equal(await open(row), secret);
  assert.equal(needsReencryption(row), false);
});

test('unknown key ids and malformed stored values fail', async () => {
  configure({ keys: { k1: K1, k2: K2 }, active: 'k2' });
  const row = await encryptApiKey(secret, scope);
  await assert.rejects(open({ ...row, encryptedApiKey: row.encryptedApiKey.replace(/^k2:/, 'k9:') }));
  await assert.rejects(open({ ...row, encryptedApiKey: row.encryptedApiKey.replace(/^k2:/, '') }));
  await assert.rejects(open({ ...row, encryptedApiKey: row.encryptedApiKey.replace(/^k2:/, 'K2:') }));
  configure({ keys: { k1: K1, k3: K3 }, active: 'k3' });
  await assert.rejects(open(row));
});

test('malformed key configuration fails closed with a generic error', async () => {
  const good = { keys: { k1: K1, k2: K2 }, active: 'k2' };
  const bad = [
    { keys: '{not json', active: 'k2' },
    { keys: '[]', active: 'k2' },
    { keys: 'null', active: 'k2' },
    { keys: {}, active: 'k1' },
    { keys: { k1: K1, k2: K2 } },
    { ...good, active: 'k3' },
    { ...good, active: 'K2' },
    { keys: { k1: K1, k2: K2 }, active: '' , legacy: undefined },
    { keys: { k1: K1, 'bad-id': K2 }, active: 'k1' },
    { keys: { k1: K1, [`k${'1'.repeat(16)}`]: K2 }, active: 'k1' },
    { keys: { k1: K1, k2: Buffer.alloc(31, 1).toString('base64') }, active: 'k2' },
    { keys: { k1: K1, k2: Buffer.alloc(33, 1).toString('base64') }, active: 'k2' },
    { keys: { k1: K1, k2: K2.replace(/=$/, '') }, active: 'k2' },
    { keys: { k1: K1, k2: 'not base64!' }, active: 'k2' },
    { keys: { k1: K1, k2: 7 }, active: 'k2' },
    { keys: { k1: K1 }, active: 'k2' },
    { legacy: K1, active: 'k1' },
    {},
  ];
  for (const options of bad) {
    configure(options);
    const label = JSON.stringify(options);
    await assert.rejects(encryptApiKey(secret, scope), (error) => error.message === 'AI configuration encryption is not available in this deployment', label);
    await assert.rejects(decryptApiKey('AAAA', 'AAAA', 2, scope), undefined, label);
    assert.throws(() => needsReencryption({ encryptedApiKey: 'AAAA', encryptionVersion: 2 }), undefined, label);
  }
  configure(good);
  assert.equal(await open(await encryptApiKey(secret, scope)), secret);
});

test('refreshStoredCredential rewrites a stale row with a conditional update and never throws', async () => {
  configure({ legacy: K1 });
  const old = await encryptApiKey(secret, scope);
  configure({ keys: { k1: K1, k2: K2 }, active: 'k2' });
  const calls = [];
  const db = (changes) => ({ prepare(sql) { return { bind(...values) { return { async run() { calls.push({ sql, values }); return { meta: { changes } }; } }; } }; } });
  assert.equal(await refreshStoredCredential(db(1), old, scope, secret), true);
  const [{ sql, values }] = calls;
  assert.equal(sql, 'UPDATE ai_configs SET encrypted_api_key = ?, key_iv = ?, encryption_version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? AND encrypted_api_key = ?');
  assert.equal(values[2], 3);
  assert.deepEqual(values.slice(3), ['user-a', old.encryptedApiKey]);
  assert.equal(await open({ encryptedApiKey: values[0], keyIv: values[1], encryptionVersion: 3 }), secret);
  // A concurrent write means zero changed rows.
  assert.equal(await refreshStoredCredential(db(0), old, scope), false);
  // Rows already on the active key are left alone.
  const current = { encryptedApiKey: values[0], keyIv: values[1], encryptionVersion: 3 };
  calls.length = 0;
  assert.equal(await refreshStoredCredential(db(1), current, scope), false);
  assert.equal(calls.length, 0);
  // Storage or key failures are swallowed.
  assert.equal(await refreshStoredCredential({ prepare() { throw new Error('d1 down'); } }, old, scope), false);
  configure({ keys: { k2: K2, k3: K3 }, active: 'k3' });
  assert.equal(await refreshStoredCredential(db(1), current, { ...scope, userKey: 'user-b' }), false);
});
