import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const out = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] || 'http://127.0.0.1:5173/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const results = [];
let currentPage;
const memory = { accountScope: 'browser-security-fixture', revision: 0, enabled: false, notes: [], recentTopics: [], contextVersion: 'test-v1', journalRevision: 0 };
const reply = '这是一个生成的语法解释：\n\n<script>window.qaExecuted = true</script>\n\n先辨认主语，再检查谓语。';
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', hasTouch: width < 600 });
    const page = await context.newPage();
    currentPage = page;
    page.setDefaultTimeout(20000);
    const errors = [], requests = [], journalPosts = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/learning-memory*', route => route.fulfill({ json: memory }));
    await context.route('**/api/learning-journal*', async route => {
      if (route.request().method() === 'POST') journalPosts.push(route.request().postDataJSON());
      await route.fulfill({ json: { accountScope: memory.accountScope, enabled: true, revision: 0, privacyRevision: 0, timezone: 'Asia/Shanghai', days: [] } });
    });
    await context.route('**/api/assistant/chat', async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      await route.fulfill({ json: { ok: true, result: { text: reply, actions: [], provenance: { origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [], userProvidedMaterial: false } }, model: 'gpt-6.1-sol', effort: 'medium', accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion } });
    });
    const nav = name => page.locator(width < 600 ? '.mobile-nav' : '.app-sidebar').getByRole('button', { name, exact: true }).click();
    await page.goto(base);
    await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
    await nav('词库');
    await page.locator('.scope-switch').getByRole('button', { name: '全部', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索单词或中文释义' }).fill('apple');
    await page.waitForFunction(() => document.querySelector('.word-row .word-en strong')?.textContent === 'apple');
    await page.locator('.word-open').first().click();
    await page.locator('dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('dialog[open]').waitFor({ state: 'detached' });
    results.push({ width, check: 'lexicon search, details, Escape dismiss', status: 'passed' });
    await nav(width < 600 ? '今日' : '今日学习');
    await page.getByRole('button', { name: '开始学习', exact: true }).click();
    await page.getByRole('button', { name: '暂时想不起来', exact: true }).click();
    await page.locator('.wrong-next').getByRole('button', { name: '继续学习', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本轮进度"]')?.getAttribute('aria-valuenow') === '1');
    await page.getByRole('button', { name: '保存进度并退出', exact: true }).click();
    await page.getByRole('button', { name: '继续学习', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '继续学习', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本轮进度"]')?.getAttribute('aria-valuenow') === '1');
    await page.getByRole('button', { name: '保存进度并退出', exact: true }).click();
    results.push({ width, check: 'practice grading, IndexedDB checkpoint and reload resume', status: 'passed' });
    await nav('阅读');
    await page.locator('.reading-card').first().click();
    await page.locator('.reader-prose').waitFor();
    assert.ok((await page.locator('.reader-prose').innerText()).length > 100);
    await page.locator('.reader-back').click();
    await page.locator('.reading-card').first().waitFor();
    results.push({ width, check: 'reading catalog, article load and return', status: 'passed' });
    await page.getByRole('button', { name: '导入文章', exact: true }).click();
    await page.getByPlaceholder('文章标题').fill('PRIVATE-TITLE-20261110');
    await page.getByRole('textbox', { name: '导入文章正文' }).fill('PRIVATE-BODY-20261110 ' + 'A learner walks into the library and reads a story about birds, rivers, mountains and the changing seasons. '.repeat(4));
    await page.getByRole('button', { name: '保存并阅读', exact: true }).click();
    await page.locator('.reader-prose').filter({ hasText: 'PRIVATE-BODY-20261110' }).waitFor();
    await page.locator('.reader-back').click();
    await page.getByRole('button', { name: /PRIVATE-TITLE-20261110/ }).click();
    await page.locator('.reader-prose').filter({ hasText: 'PRIVATE-BODY-20261110' }).waitFor();
    assert.ok(!JSON.stringify(journalPosts).includes('PRIVATE-'));
    assert.ok(!JSON.stringify(journalPosts).includes('personal-'));
    results.push({ width, check: 'personal article imported/reopened, no private title/body/id in journal POSTs', status: 'passed' });
    await nav(width < 600 ? 'AI' : 'AI 对话');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('帮我解释英语句子的主语和谓语。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.ai-text').filter({ hasText: '先辨认主语' }).waitFor();
    assert.equal(requests.length, 1);
    await page.getByText('AI 生成内容 · 教材原文未核验', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.qaExecuted), undefined);
    assert.ok((await page.locator('.ai-text').innerText()).includes('<script>'));
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('vocab-companion-history-v1:') && localStorage.getItem(key).includes('先辨认主语')));
    await page.reload();
    await nav(width < 600 ? 'AI' : 'AI 对话');
    await page.getByRole('button', { name: '展开对话列表', exact: true }).click();
    await page.getByRole('button', { name: /帮我解释英语句子的主语和谓语/ }).click();
    await page.locator('.ai-text').filter({ hasText: '先辨认主语' }).waitFor();
    await page.getByText('AI 生成内容 · 教材原文未核验', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.qaExecuted), undefined);
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, JSON.stringify(dimensions));
    await page.screenshot({ path: join(out, `chat-${width}.png`), fullPage: true });
    results.push({ width, check: 'generated provenance, inert HTML, persisted/reloaded chat, no horizontal overflow', status: 'passed', dimensions, screenshot: `chat-${width}.png` });
    assert.deepEqual(errors, []);
    results.push({ width, check: 'no uncaught browser errors', status: 'passed', journalPosts: journalPosts.length });
    await context.close();
  }
  await writeFile(join(out, 'browser-results.json'), JSON.stringify({ status: 'passed', base, generatedAt: new Date().toISOString(), provider: 'intercepted local chat response; no real provider or production data', results }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: join(out, 'browser-failure.png'), fullPage: true });
    await writeFile(join(out, 'browser-failure.txt'), await currentPage.locator('body').innerText());
  }
  await writeFile(join(out, 'browser-results.json'), JSON.stringify({ status: 'failed', completed: results, error: String(error) }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); }
