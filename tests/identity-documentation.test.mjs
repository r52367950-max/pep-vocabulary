import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { env } from './worker-env.mjs';
import { requestHeaders } from './request-headers.mjs';
import { getChatGPTUser } from '../app/chatgpt-auth.ts';
import { authenticatedUserKey } from '../lib/server-user.ts';

test('well-formed email headers on an allowed host are gateway assertions, not independently authenticated credentials', async t => {
  const oldHosts = env.IDENTITY_TRUSTED_HOSTS, oldHeaders = [...requestHeaders];
  t.after(() => {
    if (oldHosts === undefined) delete env.IDENTITY_TRUSTED_HOSTS; else env.IDENTITY_TRUSTED_HOSTS = oldHosts;
    for (const [key] of requestHeaders) requestHeaders.delete(key);
    for (const [key, value] of oldHeaders) requestHeaders.set(key, value);
  });
  requestHeaders.set('host', 'gateway.example.test');
  requestHeaders.set('oai-authenticated-user-email', 'chosen-by-direct-client@example.test');
  delete env.IDENTITY_TRUSTED_HOSTS;
  assert.equal(await getChatGPTUser(), null, 'missing deployment guard rejects even a plausible email');
  env.IDENTITY_TRUSTED_HOSTS = 'other-gateway.example.test';
  assert.equal(await getChatGPTUser(), null, 'unlisted ingress cannot assert identity');
  env.IDENTITY_TRUSTED_HOSTS = 'gateway.example.test';
  const assertion = await getChatGPTUser();
  assert.equal(assertion.email, 'chosen-by-direct-client@example.test', 'Host matching alone cannot distinguish a forged header from gateway injection');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(assertion.email));
  assert.equal(await authenticatedUserKey(), Buffer.from(digest).toString('hex'));
  requestHeaders.delete('oai-authenticated-user-email');
  assert.equal(await getChatGPTUser(), null, 'a trusted Host without a gateway identity still cannot log in');
});

test('current deployment documents require the guard and disclose the untrusted-ingress impersonation boundary', () => {
  for (const name of ['docs/SECURITY_PLAN.md', 'docs/BACKEND_ARCHITECTURE.md', 'AI_ASSISTANT_DEPLOYMENT.md']) {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(text, /IDENTITY_TRUSTED_HOSTS/, name);
    assert.match(text, /必须配置|必须设置|设置 `IDENTITY_TRUSTED_HOSTS`/, name);
    assert.match(text, /oai-authenticated-user-email/, name);
    assert.match(text, /身份完全依赖|身份的唯一认证来源|完全依赖网关/, name);
    assert.match(text, /不剥离.*(?:伪造|冒充)|不剥离同名头[\s\S]*伪造|不剥离这个头[\s\S]*伪造/, name);
    assert.match(text, /Host[\s\S]*(?:不是身份认证|不能证明|不能防止)/, name);
    assert.doesNotMatch(text, /可选开关 `IDENTITY_TRUSTED_HOSTS`|默认不设置，线上行为不变/, name);
  }
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /# Required:[\s\S]*IDENTITY_TRUSTED_HOSTS=/);
  assert.match(example, /stripping external copies of[\s\S]*oai-authenticated-user-email/);
  assert.match(example, /Host is not[\s\S]*authentication/);
});
