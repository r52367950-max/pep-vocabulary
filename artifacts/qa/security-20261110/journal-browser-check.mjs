import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const out = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const memory = { accountScope: 'journal-ui-fixture', revision: 1, enabled: false, notes: [], recentTopics: [], contextVersion: 'fixture-v1' };
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let revision = 4, privacyRevision = 2;
    let days = [{ date: '2026-11-10', summary: '复习 3 词。', summarySource: 'facts', events: [] }];
    const deletes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/learning-memory*', route => route.fulfill({ json: memory }));
    await context.route('**/api/learning-journal*', async route => {
      if (route.request().method() === 'DELETE') {
        const body = route.request().postDataJSON(); deletes.push(body);
        assert.deepEqual(body, { all: true, accountScope: memory.accountScope, revision: 5 });
        revision++; privacyRevision++; days = [];
      }
      await route.fulfill({ json: { accountScope: memory.accountScope, enabled: true, revision, privacyRevision, timezone: 'UTC', days } });
    });
    await page.goto(process.argv[2] || 'http://127.0.0.1:5173/');
    await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
    await page.locator(width > 600 ? '.app-sidebar' : '.mobile-header-actions').getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: '学习', exact: true }).click();
    await dialog.locator('summary').filter({ hasText: '学习记忆' }).click();
    const clear = page.getByRole('button', { name: '清空全部学习日志', exact: true });
    await clear.waitFor();
    page.once('dialog', event => event.dismiss());
    await clear.click();
    assert.equal(deletes.length, 0);
    revision = 5;
    page.once('dialog', event => event.accept());
    await clear.click();
    await page.getByRole('alert').filter({ hasText: '日志已更新' }).waitFor();
    assert.equal(deletes.length, 0);
    page.once('dialog', event => event.accept());
    const deleted = page.waitForResponse(response => response.url().includes('/api/learning-journal') && response.request().method() === 'DELETE');
    await clear.click();
    await deleted;
    await page.locator('summary').filter({ hasText: '每日日志 · 0 天' }).waitFor();
    assert.equal(deletes.length, 1);
    assert.deepEqual(errors, []);
    results.push({ width, status: 'passed', checks: ['cancel sends no DELETE', 'stale displayed revision blocks DELETE', 'confirmed fresh revision sends all/accountScope/revision', 'empty journal rendered after deletion', 'no uncaught browser errors'], request: deletes[0] });
    await context.close();
  }
  await writeFile(join(out, 'journal-browser-results.json'), JSON.stringify({ status: 'passed', backend: 'intercepted account/journal fixtures; validates UI and client CAS, not production D1', results }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally { await browser.close(); }
