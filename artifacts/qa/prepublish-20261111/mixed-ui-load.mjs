import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// Run only against an explicitly supplied managed preview build. The app, its
// released lexicon, React DOM, browser events and local persistence are real;
// account/journal responses and the SSE answer are synthetic fixtures.
// Action timings are automation wall time, not INP or provider/network latency.
const base = process.env.CIJI_QA_URL;
assert.ok(base, 'Set CIJI_QA_URL to the managed preview URL before running.');
assert.match(base, /^https?:\/\//);
const out = dirname(fileURLToPath(import.meta.url));
const root = resolve(out, '../../..');
const lexicon = JSON.parse(await readFile(resolve(root, 'public/data/v1/index.json'), 'utf8'));
const evidenceId = 'pep-1e3e7e41accdc5f7';
assert.ok(lexicon.rows.some(row => row[0] === evidenceId));
const memory = { accountScope: 'mixed-load-fixture', revision: 0, enabled: false, notes: [], recentTopics: [], contextVersion: 'mixed-load-v1', journalRevision: 0 };
const historyKey = 'vocab-companion-history-v1:' + memory.accountScope;
const now = Date.now();
const conversations = Array.from({ length: 50 }, (_, i) => ({
  id: `mixed-${i}`, title: `负载会话 ${String(i).padStart(2, '0')}`, temporary: false,
  createdAt: now - i * 3600000, updatedAt: now - i * 3600000,
  messages: Array.from({ length: i === 0 ? 120 : i <= 9 ? 40 : 38 }, (_, j) => j % 2 === 0
    ? { id: `u-${i}-${j}`, role: 'user', at: now - (120 - j) * 1000, text: `QA question ${i}/${j}: Explain this sentence and suggest a short vocabulary exercise.`, quotes: [], attachments: [], via: 'text' }
    : { id: `a-${i}-${j}`, role: 'assistant', at: now - (120 - j) * 1000, status: 'done',
      blocks: [{ type: 'text', text: `QA answer ${i}/${j}: Review one word, write a short sentence, and recall it tomorrow.\n\nUse context to check the meaning.` }],
      revealed: Number.MAX_SAFE_INTEGER, request: { model: 'gpt-6.1-sol', reasoning: { effort: 'medium' }, metadata: { task: 'chat', routeSource: 'auto' }, context: { records: false, article: 'none', quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [] } },
      routeReason: '', toolSteps: [], provenance: { origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [evidenceId], userProvidedMaterial: false },
    }),
}));
const initialHistory = JSON.stringify({ version: 1, conversations });
assert.equal(conversations.flatMap(c => c.messages).length, 2000);
assert.ok(initialHistory.length < 970000, 'Fixture must leave room below the 1,000,000-character history cap.');
// One paragraph preserves the exact model text in textContent, so the observer
// can validate every grapheme prefix without conflating RichText list formatting.
const reply = 'QA_STREAM_MARKER：先辨认主语和谓语。👩🏽‍🏫 café e\u0301 ' +
  Array.from({ length: 48 }, (_, i) => `第 ${i + 1} 步：结合上下文解释词义，再用短句练习；先回忆，再核对。Keep one clear example and revisit it tomorrow.`).join(' ');
const summary = '这是测试用的公开摘要：检查句子结构，并提供词条收录位置。';
const devices = [
  { name: 'desktop', width: 1440, height: 900, cpu: 1, touch: false },
  { name: 'phone-cpu4', width: 390, height: 844, cpu: 4, touch: true },
];
const report = {
  status: 'running', preview: { url: base, buildLabel: process.env.CIJI_QA_BUILD_LABEL || 'managed preview (label not supplied)', revision: process.env.CIJI_QA_REVISION || null },
  generatedAt: new Date().toISOString(),
  method: 'Managed preview build, fresh Chromium context each round, actual app/lexicon/DOM/localStorage. 50 conversations / 2,000 mixed messages, open a 120-message thread, then one synthetic phased SSE answer and grapheme reveal. Desktop and 390px CPU4, 3 rounds each. All /api requests are fixtures or blocked; no production account, microphone or paid provider. Wall times include browser automation and are not INP; CPU4 is emulation, not measured mobile hardware.',
  fixture: { conversations: 50, messages: 2000, activeMessages: 120, userMessages: 1000, assistantMessages: 1000, lexiconEntries: lexicon.rows.length, historyChars: initialHistory.length, replyChars: reply.length },
  runs: [],
};
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const stage = (page, value) => page.evaluate(value => { window.__mixedQa.stage = value; }, value);
const timeAction = async action => { const start = performance.now(); await action(); return performance.now() - start; };
const rows = page => page.locator('.conv-row[data-conv]');
const input = page => page.getByRole('textbox', { name: '消息', exact: true });
async function showList(page) {
  await page.getByRole('button', { name: '展开对话列表', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索对话', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.conv-row[data-conv]').length === 50);
}
async function closeList(page) {
  const close = page.locator('.conv-panel').getByRole('button', { name: '收起对话列表', exact: true });
  if (await close.isVisible()) await close.click();
}
async function searchList(page) {
  const search = page.getByRole('searchbox', { name: '搜索对话', exact: true });
  await search.fill('负载会话 00');
  await page.waitForFunction(() => document.querySelectorAll('.conv-row[data-conv]').length === 1);
  assert.equal(await rows(page).first().getAttribute('data-conv'), 'mixed-0');
}

try {
  for (const device of devices) for (let round = 1; round <= 3; round++) {
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, hasTouch: device.touch, isMobile: device.touch, reducedMotion: 'no-preference', locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const unexpectedApi = [], pageErrors = [];
    await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/learning-memory') return route.fulfill({ json: memory });
      if (path === '/api/learning-journal') return route.fulfill({ json: { accountScope: memory.accountScope, enabled: false, revision: 0, privacyRevision: 0, days: [] } });
      unexpectedApi.push({ path, method: route.request().method() });
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'qa_blocked', message: 'Only fixture API requests are allowed in this check.' } } });
    });
    await context.addInitScript(({ memory, historyKey, initialHistory, reply, summary, evidenceId }) => {
      localStorage.setItem(historyKey, initialHistory);
      localStorage.setItem('vocab-companion-preferences-v1', JSON.stringify({ animateReplies: true, sendMode: 'enter', routePreference: 'auto', includeRecords: false, includeArticle: false }));
      const qa = window.__mixedQa = { stage: 'startup', longTasks: [], lcp: 0, storageWrites: [], requests: [], phasesEmitted: [], phasesVisible: [], terminalAt: null, firstProseAt: null, lastProseAt: null, samples: [], invalidPrefixes: 0, cancellations: 0 };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) qa.longTasks.push({ startTime: entry.startTime, duration: entry.duration, stage: qa.stage }); }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => { for (const entry of list.getEntries()) qa.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        const start = performance.now();
        const result = setItem.call(this, key, value);
        if (key === historyKey) qa.storageWrites.push({ at: start, duration: performance.now() - start, chars: value.length, stage: qa.stage });
        return result;
      };
      const boundaries = new Set([0]);
      for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(reply)) boundaries.add(part.index + part.segment.length);
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.pathname !== '/api/assistant/chat') return realFetch(input, init);
        const body = JSON.parse(init.body);
        qa.requests.push({ at: performance.now(), accountScope: body.accountScope, contextRevision: body.contextRevision, contextVersion: body.contextVersion, temporary: body.temporary, historyTurns: body.messages.length, historyChars: body.messages.reduce((sum, row) => sum + row.text.length, 0), accept: new Headers(init.headers).get('accept') });
        const encoder = new TextEncoder();
        let ended = false, timers = [];
        const clear = () => { timers.forEach(clearTimeout); timers = []; };
        return new Response(new ReadableStream({
          start(controller) {
            const send = (event, value) => {
              if (ended) return;
              controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n'));
              if (event === 'status') qa.phasesEmitted.push({ phase: value.phase, at: performance.now() });
            };
            send('status', { phase: 'thinking' });
            timers.push(setTimeout(() => send('status', { phase: 'tool' }), 250));
            timers.push(setTimeout(() => send('status', { phase: 'verifying' }), 500));
            timers.push(setTimeout(() => {
              if (ended) return;
              qa.terminalAt = performance.now();
              send('result', { ok: true, result: { text: reply, actions: [], provenance: { origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [evidenceId], userProvidedMaterial: false } }, model: 'gpt-6.1-sol', effort: 'medium', accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion, reasoningSummary: summary, harness: { tools: [] } });
              ended = true; clear(); controller.close();
            }, 800));
            init.signal?.addEventListener('abort', () => { if (!ended) { ended = true; clear(); qa.cancellations++; controller.error(new DOMException('Aborted', 'AbortError')); } }, { once: true });
          },
          cancel() { if (!ended) qa.cancellations++; ended = true; clear(); },
        }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      };
      const observe = () => new MutationObserver(() => {
        if (!qa.requests.length) return;
        const label = document.querySelector('.message-assistant:last-child .thinking-label')?.textContent;
        if (label && qa.phasesVisible.at(-1) !== label) qa.phasesVisible.push(label);
        const text = document.querySelector('.message-assistant:last-child .ai-text')?.textContent || '';
        if (!text.startsWith('QA_STREAM_MARKER') || qa.samples.at(-1)?.chars === text.length) return;
        const at = performance.now();
        qa.firstProseAt ??= at; qa.lastProseAt = at;
        if (!reply.startsWith(text) || !boundaries.has(text.length)) qa.invalidPrefixes++;
        qa.samples.push({ at, chars: text.length });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
      if (document.body) observe(); else addEventListener('DOMContentLoaded', observe, { once: true });
    }, { memory, historyKey, initialHistory, reply, summary, evidenceId });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.setDefaultTimeout(30000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpu });
    await cdp.send('Performance.enable');
    try {
      const timings = {};
      timings.startupMs = await timeAction(async () => { await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.locator('.daily-feature').waitFor(); });
      await stage(page, 'chat-open');
      timings.chatMs = await timeAction(async () => {
        await page.locator(device.touch ? '.mobile-nav' : '.app-sidebar').getByRole('button', { name: device.touch ? 'AI' : 'AI 对话', exact: true }).click();
        await page.locator('.ciji-companion .greeting').waitFor();
      });
      await stage(page, 'list'); timings.listMs = await timeAction(() => showList(page));
      await stage(page, 'search'); timings.searchMs = await timeAction(() => searchList(page));
      await stage(page, 'history-open');
      timings.historyOpenMs = await timeAction(async () => {
        await page.locator('.conv-row[data-conv="mixed-0"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.thread .message').length === 120 && document.querySelectorAll('.thread .message-assistant').length === 60);
        await closeList(page);
      });
      const before = await page.evaluate(key => { const saved = JSON.parse(localStorage.getItem(key)); return { conversations: saved.conversations.length, messages: saved.conversations.reduce((sum, c) => sum + c.messages.length, 0) }; }, historyKey);
      assert.deepEqual(before, { conversations: 50, messages: 2000 });
      assert.equal(await page.locator('.message-assistant .ai-provenance').count(), 60, 'Real released vocabulary must supply historical sources.');
      await stage(page, 'typing');
      const question = 'Please explain this sentence and suggest one short vocabulary exercise.';
      timings.typingMs = await timeAction(() => input(page).pressSequentially(question));
      assert.equal(await input(page).inputValue(), question);
      await stage(page, 'stream');
      const sentAt = performance.now();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => window.__mixedQa.samples.length >= 3 && document.querySelector('.ai-text.is-revealing'));
      await stage(page, 'stream-typing');
      const draft = 'Keep this next question as an unsent draft.';
      timings.streamTypingMs = await timeAction(() => input(page).pressSequentially(draft));
      assert.equal(await input(page).inputValue(), draft);
      await stage(page, 'stream-list'); timings.streamListMs = await timeAction(() => showList(page));
      await stage(page, 'stream-search'); timings.streamSearchMs = await timeAction(() => searchList(page));
      await closeList(page);
      await stage(page, 'stream-finish');
      await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'detached' });
      timings.completionMs = performance.now() - sentAt;
      assert.equal(await page.locator('.message-assistant .ai-text').last().innerText(), reply);
      assert.equal(await page.locator('.message-assistant .ai-turn').last().getAttribute('aria-busy'), 'false');
      await page.locator('.message-assistant').last().getByText(/教材原文未核验/).waitFor();
      assert.equal(await page.locator('details.reasoning-summary').last().getAttribute('open'), null);
      assert.equal(await input(page).inputValue(), draft);
      await stage(page, 'persistence');
      timings.persistMs = await timeAction(() => page.waitForFunction(({ key, text }) => {
        const saved = JSON.parse(localStorage.getItem(key) || '{}');
        const last = saved.conversations?.find(c => c.id === 'mixed-0')?.messages.at(-1);
        return last?.status === 'done' && last.blocks?.find(b => b.type === 'text')?.text === text;
      }, { key: historyKey, text: reply }, { polling: 100 }));
      const measured = await page.evaluate(key => {
        const qa = window.__mixedQa, raw = localStorage.getItem(key), saved = JSON.parse(raw);
        return { qa, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), storage: { conversations: saved.conversations.length, messages: saved.conversations.reduce((sum, c) => sum + c.messages.length, 0), historyChars: raw.length, writes: qa.storageWrites }, finalChars: document.querySelector('.message-assistant:last-child .ai-text').textContent.length };
      }, historyKey);
      assert.equal(measured.overflow, 0);
      assert.equal(measured.storage.conversations, 50); assert.equal(measured.storage.messages, 2000);
      assert.ok(measured.storage.historyChars <= 1000000);
      assert.deepEqual(pageErrors, []); assert.deepEqual(unexpectedApi, []);
      const qa = measured.qa;
      assert.equal(qa.requests.length, 1); assert.equal(qa.requests[0].accept, 'text/event-stream');
      assert.equal(qa.requests[0].accountScope, memory.accountScope); assert.equal(qa.requests[0].temporary, false);
      assert.ok(qa.requests[0].historyTurns <= 24); assert.ok(qa.requests[0].historyChars <= 20000);
      assert.deepEqual(qa.phasesEmitted.map(item => item.phase), ['thinking', 'tool', 'verifying']);
      assert.ok(qa.firstProseAt >= qa.terminalAt, 'Unvalidated text must not appear before the terminal payload.');
      assert.ok(qa.samples.length > 3); assert.equal(qa.invalidPrefixes, 0); assert.equal(measured.finalChars, reply.length);
      assert.equal(qa.cancellations, 0);
      timings.firstProseMs = qa.firstProseAt - qa.requests[0].at;
      timings.revealSpanMs = qa.lastProseAt - qa.firstProseAt;
      const metrics = await cdp.send('Performance.getMetrics');
      const metric = name => metrics.metrics.find(item => item.name === name)?.value ?? null;
      const result = { device: device.name, round, cpuThrottle: device.cpu, viewport: { width: device.width, height: device.height }, status: 'passed', timings, lcpMs: qa.lcp,
        longTasks: qa.longTasks, sse: { requests: qa.requests.length, requestHistoryTurns: qa.requests[0].historyTurns, requestHistoryChars: qa.requests[0].historyChars, phasesEmitted: qa.phasesEmitted, phasesVisible: qa.phasesVisible, terminalAt: qa.terminalAt },
        reveal: { samples: qa.samples, firstProseAt: qa.firstProseAt, lastProseAt: qa.lastProseAt, invalidPrefixes: qa.invalidPrefixes, finalChars: measured.finalChars },
        storage: measured.storage, pageErrors, unexpectedApi, overflow: measured.overflow, heapBytes: metric('JSHeapUsedSize'),
        browserMetrics: { taskDurationSeconds: metric('TaskDuration'), scriptDurationSeconds: metric('ScriptDuration'), layoutDurationSeconds: metric('LayoutDuration'), recalcStyleDurationSeconds: metric('RecalcStyleDuration') },
      };
      report.runs.push(result);
      if (round === 3) await page.screenshot({ path: resolve(out, `mixed-ui-${device.name}.png`), fullPage: false });
      console.log(JSON.stringify({ device: device.name, round, status: 'passed', timings, longTasks: qa.longTasks.length, historyChars: measured.storage.historyChars, heapBytes: result.heapBytes }));
    } finally { await context.close(); }
  }
  assert.equal(report.runs.length, 6);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await browser.close();
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(out, 'mixed-ui-load.json'), JSON.stringify(report, null, 2) + '\n');
}
