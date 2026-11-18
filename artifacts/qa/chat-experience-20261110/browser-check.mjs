import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const out = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] || 'http://127.0.0.1:5173/';
const memory = { accountScope: 'chat-experience-fixture', revision: 0, enabled: false, notes: [], recentTopics: [], contextVersion: 'chat-v1', journalRevision: 0 };
const normal = '先观察主语，再辨认谓语。👩🏽‍🏫 学习时保留重音 café e\u0301，把每个句子分成清楚的部分。'.repeat(6);
const summary = '我会先确定句子结构，再用一个简短例子说明。<script>window.summaryExecuted=true</script>';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
const results = [];
let currentPage;

async function fixture(context) {
  await context.route('**/api/learning-memory*', route => route.fulfill({ json: memory }));
  await context.route('**/api/learning-journal*', route => route.fulfill({ json: { accountScope: memory.accountScope, enabled: true, revision: 0, privacyRevision: 0, days: [] } }));
  await context.addInitScript(({ memory, normal, summary }) => {
    const realFetch = window.fetch.bind(window);
    window.__chatRequests = [];
    window.__revealSamples = [];
    window.__nextChat = { text: normal, summary, delay: 1500 };
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('/api/assistant/chat')) return realFetch(input, init);
      const config = { ...window.__nextChat };
      const body = JSON.parse(init.body);
      window.__chatRequests.push(body);
      window.__revealSamples = [];
      const result = { ok: true, result: { text: config.text, actions: [], provenance: { origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [], userProvidedMaterial: false } }, model: 'gpt-6.1-sol', effort: 'medium', accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion, harness: { tools: [] }, ...(config.summary ? { reasoningSummary: config.summary } : {}) };
      const encoder = new TextEncoder();
      let timers = [], ended = false;
      const clear = () => { timers.forEach(clearTimeout); timers = []; };
      const stream = new ReadableStream({
        start(controller) {
          const send = (event, value) => { if (!ended) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)); };
          send('status', { phase: 'thinking' });
          timers.push(setTimeout(() => send('status', { phase: 'tool' }), config.delay * .4));
          timers.push(setTimeout(() => send('status', { phase: 'verifying' }), config.delay * .75));
          timers.push(setTimeout(() => { if (ended) return; send('result', result); ended = true; clear(); controller.close(); }, config.delay));
          init.signal?.addEventListener('abort', () => { if (ended) return; ended = true; clear(); controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
        },
        cancel() { ended = true; clear(); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    };
    const attach = () => {
      new MutationObserver(() => {
        const text = [...document.querySelectorAll('.message-assistant')].at(-1)?.querySelector('.ai-text')?.textContent || '';
        if (text && window.__revealSamples.at(-1) !== text) window.__revealSamples.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    };
    if (document.body) attach(); else addEventListener('DOMContentLoaded', attach, { once: true });
  }, { memory, normal, summary });
}
const send = async (page, text, reply, delay = 100) => {
  await page.evaluate(({ reply, delay, summary }) => { window.__nextChat = { text: reply, summary, delay }; window.__revealSamples = []; }, { reply, delay, summary });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
};
const textOfLastReply = page => page.locator('.message-assistant .ai-text').last().innerText();
async function finished(page) { await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'detached' }); }
function unicodePrefixes(samples, full) {
  const boundaries = new Set([0]);
  let length = 0;
  for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(full)) { length += segment.length; boundaries.add(length); }
  assert.ok(samples.length > 3, 'answer should be shown over multiple updates');
  for (const sample of samples) { assert.ok(full.startsWith(sample)); assert.ok(boundaries.has(sample.length), 'no partial emoji/combining-character output'); }
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference', hasTouch: width < 600 });
    await fixture(context);
    const page = await context.newPage(); currentPage = page;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    const nav = name => page.locator(width < 600 ? '.mobile-nav' : '.app-sidebar').getByRole('button', { name, exact: true }).click();
    await page.goto(base);
    await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
    await nav(width < 600 ? 'AI' : 'AI 对话');
    await send(page, '帮我解释这个英语句子。', normal, 2200);
    await page.getByText('思考中', { exact: true }).waitFor();
    const animation = await page.locator('.thinking-label').evaluate(el => getComputedStyle(el).animationName);
    assert.notEqual(animation, 'none');
    await page.waitForTimeout(350); // Let the composer-to-thread view transition finish for the screenshot.
    await page.screenshot({ path: join(out, `thinking-${width}.png`), fullPage: true });
    await page.getByText('正在使用学习工具', { exact: true }).waitFor();
    await page.getByText('正在整理回答', { exact: true }).waitFor();
    await page.waitForFunction(() => { const text = [...document.querySelectorAll('.ai-text')].at(-1)?.textContent; return text?.length > 10 && document.querySelector('.ai-text.is-revealing'); });
    const prefix = await textOfLastReply(page);
    assert.ok(prefix.length < normal.length);
    await finished(page);
    assert.equal(await textOfLastReply(page), normal);
    unicodePrefixes(await page.evaluate(() => window.__revealSamples), normal);
    results.push({ width, check: 'phased SSE thinking/tool/verifying, visible animated status, successive grapheme-safe answer prefixes', status: 'passed', samples: await page.evaluate(() => window.__revealSamples.length), animation });
    const details = page.locator('details.reasoning-summary').last();
    assert.equal(await details.getAttribute('open'), null);
    await details.locator('summary').click();
    await details.getByText(summary, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.summaryExecuted), undefined);
    await details.locator('summary').click();
    await page.screenshot({ path: join(out, `answer-${width}.png`), fullPage: true });
    results.push({ width, check: 'summary starts collapsed, expands safely as text, closes', status: 'passed' });
    await page.waitForFunction(scope => localStorage.getItem('vocab-companion-history-v1:' + scope)?.includes('model-generated'), memory.accountScope);
    await page.reload();
    await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
    await nav(width < 600 ? 'AI' : 'AI 对话');
    await page.getByRole('button', { name: '展开对话列表', exact: true }).click();
    await page.getByRole('button', { name: /帮我解释这个英语句子/ }).click();
    assert.equal(await textOfLastReply(page), normal);
    assert.equal(await page.locator('.ai-text.is-revealing').count(), 0);
    assert.equal(await page.locator('.reply-pending').count(), 0);
    if (width > 600) await page.locator('.conv-panel').getByRole('button', { name: '收起对话列表', exact: true }).click();
    results.push({ width, check: 'saved history restored whole without replaying animation', status: 'passed' });
    const long = Array.from({ length: 75 }, (_, i) => `${i + 1}. 先看主语和谓语，再结合上下文理解英文句子。`).join('\n\n');
    await send(page, '请详细解释，并给出完整学习步骤。', long);
    await page.waitForFunction(() => document.querySelector('.chat-scroll')?.scrollHeight > 1400 && document.querySelector('.ai-text.is-revealing'));
    await page.locator('.chat-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
    const before = await page.locator('.chat-scroll').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
    await page.waitForTimeout(200);
    const after = await page.locator('.chat-scroll').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight }));
    assert.ok(after.top < 80, `user scroll should stay near top: ${JSON.stringify({ before, after })}`);
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    await page.waitForTimeout(100);
    assert.ok(await page.locator('.chat-scroll').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 80));
    await page.getByRole('button', { name: '停止回答', exact: true }).click();
    const stopped = await textOfLastReply(page);
    assert.ok(stopped.length > 0 && stopped.length < long.length);
    await page.waitForTimeout(350);
    assert.equal(await textOfLastReply(page), stopped);
    await page.getByText('已停止', { exact: true }).last().waitFor();
    results.push({ width, check: 'scroll up pauses follow; jump resumes; Stop freezes visible answer prefix', status: 'passed', stoppedChars: stopped.length });
    await page.getByRole('button', { name: '收起为小窗，回到学习页', exact: true }).click();
    await page.locator('.mini-scroll').waitFor();
    await send(page, '在阅读小窗中继续解释。', long);
    await page.waitForFunction(() => document.querySelector('.mini-scroll')?.scrollHeight > 1000 && document.querySelector('.ai-text.is-revealing'));
    await page.locator('.mini-scroll').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
    await page.waitForTimeout(200);
    assert.ok(await page.locator('.mini-scroll').evaluate(el => el.scrollTop < 80));
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    await page.waitForTimeout(100);
    assert.ok(await page.locator('.mini-scroll').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 80));
    await page.getByRole('button', { name: '停止回答', exact: true }).click();
    await page.getByRole('button', { name: '展开为完整对话', exact: true }).click();
    results.push({ width, check: 'mini-window streaming preserves upward scroll; jump restores follow', status: 'passed' });
    const checkpointReply = normal.repeat(8);
    await send(page, '刷新时保留已经显示的回答。', checkpointReply);
    await page.waitForFunction(() => [...document.querySelectorAll('.message-assistant')].at(-1)?.querySelector('.ai-text.is-revealing')?.textContent.length > 80);
    await page.waitForFunction(scope => {
      const saved = JSON.parse(localStorage.getItem('vocab-companion-history-v1:' + scope) || '{}');
      const conversation = saved.conversations?.find(c => c.messages.some(m => m.role === 'user' && m.text === '刷新时保留已经显示的回答。'));
      return conversation?.messages.filter(m => m.role === 'assistant').at(-1)?.blocks.find(b => b.type === 'text')?.text.length > 0;
    }, memory.accountScope);
    await page.reload();
    await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
    await nav(width < 600 ? 'AI' : 'AI 对话');
    await page.getByRole('button', { name: '展开对话列表', exact: true }).click();
    await page.getByRole('button', { name: /帮我解释这个英语句子/ }).click();
    const restoredPrefix = await textOfLastReply(page);
    assert.ok(restoredPrefix.length > 0 && restoredPrefix.length < checkpointReply.length);
    assert.ok(checkpointReply.startsWith(restoredPrefix));
    assert.equal(await page.locator('.ai-text.is-revealing').count(), 0);
    await page.getByText('已停止', { exact: true }).last().waitFor();
    if (width > 600) await page.locator('.conv-panel').getByRole('button', { name: '收起对话列表', exact: true }).click();
    results.push({ width, check: 'reload during reveal restores nonempty visible-prefix checkpoint as stopped, without hidden suffix or replay', status: 'passed', restoredChars: restoredPrefix.length });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await send(page, '减少动态效果下再回答。', normal);
    await finished(page);
    assert.equal(await textOfLastReply(page), normal);
    assert.deepEqual(await page.evaluate(() => window.__revealSamples), [normal]);
    results.push({ width, check: 'reduced motion displays full answer without animated stepping', status: 'passed' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (width > 600) {
      await page.locator('.app-sidebar').getByRole('button', { name: '设置', exact: true }).click();
      await page.locator('.settings-nav').getByRole('button', { name: '对话', exact: true }).click();
      await page.getByRole('switch', { name: '逐字显示回答', exact: true }).uncheck();
      await page.getByLabel('发送方式', { exact: true }).selectOption('mod-enter');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('vocab-companion-preferences-v1')).animateReplies), false);
      await page.keyboard.press('Escape');
      await page.locator('.settings-dialog').waitFor({ state: 'detached' });
      const area = page.getByRole('textbox', { name: '消息', exact: true });
      await page.evaluate(({ text, summary }) => { window.__nextChat = { text, summary, delay: 100 }; window.__revealSamples = []; }, { text: normal, summary });
      await area.fill('输入法组合时不发送');
      const requestCount = await page.evaluate(() => window.__chatRequests.length);
      await area.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      assert.equal(await page.evaluate(() => window.__chatRequests.length), requestCount);
      await area.press('Enter');
      assert.equal(await page.evaluate(() => window.__chatRequests.length), requestCount);
      assert.match(await area.inputValue(), /\n/);
      await area.press('Control+Enter');
      await finished(page);
      assert.equal(await textOfLastReply(page), normal);
      assert.deepEqual(await page.evaluate(() => window.__revealSamples), [normal]);
      results.push({ width, check: 'visible animation preference persists; disabled reveal instant; IME Enter safe; Ctrl+Enter sends and Enter inserts newline', status: 'passed' });
    }
    // Deleting an in-flight conversation must prevent its eventual result from returning.
    await send(page, '删除中的对话', 'LATE_REPLY_SHOULD_NOT_RETURN', 1800);
    await page.getByText('思考中', { exact: true }).waitFor();
    await page.getByRole('button', { name: '展开对话列表', exact: true }).click();
    const row = page.locator('.conv-row').filter({ hasText: '帮我解释这个英语句子' });
    await row.click({ button: 'right' });
    await page.locator('.conv-confirm').getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('.conv-panel').getByRole('button', { name: '收起对话列表', exact: true }).click();
    await page.waitForTimeout(2000);
    assert.equal(await page.getByText('LATE_REPLY_SHOULD_NOT_RETURN', { exact: true }).count(), 0);
    results.push({ width, check: 'deleted in-flight conversation cannot receive late result', status: 'passed' });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, JSON.stringify(dimensions));
    assert.deepEqual(errors, []);
    results.push({ width, check: 'no horizontal overflow or uncaught browser errors', status: 'passed' });
    await context.close();
  }
  await writeFile(join(out, 'browser-results.json'), JSON.stringify({ status: 'passed', base, generatedAt: new Date().toISOString(), scope: 'Real Chromium/client parser/React/storage; phased Web ReadableStream API fixtures; no paid provider or production calls', results }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} catch (error) {
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally { await browser.close(); }
