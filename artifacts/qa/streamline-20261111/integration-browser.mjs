import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

// The real application, local vocabulary, IndexedDB and browser events run unchanged.
// Only account context, AI answers and voice readiness use deterministic HTTP fixtures.
// No model provider, microphone capture or production account is contacted.
const base = process.env.CIJI_QA_URL || "http://127.0.0.1:5174";
const out = fileURLToPath(new URL("./screenshots/", import.meta.url));
await mkdir(out, { recursive: true });
const results = [], screenshots = [], errors = [];
const only = process.argv[2] || "all";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "ipad-landscape", width: 1180, height: 760, touch: true },
  { name: "ipad-portrait", width: 820, height: 1100, touch: true },
  { name: "phone", width: 390, height: 844, touch: true, mobile: true },
];
const note = (name, details = {}) => { results.push({ name, status: "passed", ...details }); console.log(`PASS ${name}`); };

async function fixture(viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: !!viewport.touch, isMobile: !!viewport.mobile, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const state = { scope: "qa-account-a", revision: 1, requests: [], voiceSessions: 0 };
  await context.route("**/api/learning-memory**", async (route) => route.fulfill({ json: { accountScope: state.scope, revision: state.revision, enabled: true, notes: [], recentTopics: [], model: "gpt-6.1-sol", contextVersion: "qa-v1", journalRevision: 0 } }));
  await context.route("**/api/voice/status", async (route) => route.fulfill({ json: { configured: false, ready: false, models: { voice: "live-fixture", text: "gpt-6.1-sol" }, activeSession: null } }));
  await context.route("**/api/voice/session", async (route) => { state.voiceSessions++; await route.fulfill({ status: 503, json: { error: { message: "No paid calls in browser QA" } } }); });
  await context.route("**/api/assistant/chat", async (route) => {
    const body = route.request().postDataJSON(); state.requests.push(body);
    const last = body.messages?.at(-1)?.text || "";
    if (last.includes("延迟测试")) await new Promise((resolve) => setTimeout(resolve, 1600));
    if (last.includes("连接错误测试")) return route.fulfill({ status: 503, json: { ok: false, error: { code: "qa_unavailable", message: "连接暂不可用，请重试。" } } });
    const quote = body.quotes?.[0]?.text;
    const text = last.includes("延迟测试") ? "迟到的回答不应显示" : quote ? `针对选文：${quote}\n\n这段文字的解释已返回。` : `已收到：${last}\n\n先复习容易写错的词，再做一轮听写。`;
    const model = body.model === "terra" || body.action === "translate" || body.action === "grammar" ? "gpt-6.1-terra" : "gpt-6.1-sol";
    const effort = body.action === "translate" ? "low" : "medium";
    const actions = last.includes("安排一轮实际复习") ? [{ type: "start-review", title: "打开实际复习", wordIds: body.wordIds.slice(0, 1), minutes: 5 }] : [];
    try { await route.fulfill({ json: { ok: true, result: { text, actions }, model, effort, accountScope: body.accountScope, contextRevision: body.contextRevision, contextVersion: body.contextVersion } }); } catch { /* Browser cancellation closes the intercepted request. */ }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push({ viewport: viewport.name, message: error.message }));
  page.setDefaultTimeout(12_000);
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".daily-feature").waitFor({ timeout: 60_000 });
  return { context, page, state };
}

async function nav(page, names) {
  for (const name of names) {
    const buttons = page.getByRole("button", { name, exact: true });
    for (const button of await buttons.all()) if (await button.isVisible()) { await button.click(); return; }
  }
  throw new Error(`Visible navigation missing: ${names.join(" / ")}`);
}
const composer = (page) => page.locator(".ciji-companion .composer textarea:visible").last();
async function send(page, text) { const before = await page.locator(".ciji-companion .ai-turn").count(); await composer(page).fill(text); await composer(page).press("Enter"); await page.waitForFunction((count) => { const turns = [...document.querySelectorAll(".ciji-companion .ai-turn")]; return turns.length > count && turns.at(-1).getAttribute("aria-busy") === "false"; }, before); }
async function noOverflow(page) { const excess = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(excess <= 1, `Horizontal overflow ${excess}px`); return excess; }
async function shot(page, name) { const path = `${out}/${name}.png`; await page.screenshot({ path, animations: "disabled", fullPage: false }); screenshots.push(name); }

async function viewportSmoke(viewport) {
  const { context, page, state } = await fixture(viewport);
  try {
    assert.equal(await page.locator(".daily-feature .today-artwork").count(), 1);
    assert.equal(await page.getByRole("button", { name: /^开始学习/ }).count(), 1);
    await noOverflow(page);
    if (viewport.name === "desktop") await shot(page, "today-original-desktop");
    note(`${viewport.name}: original Today artwork and learning entry retained`);
    await nav(page, ["AI 对话", "AI"]);
    await page.locator(".ciji-companion .greeting").waitFor();
    assert.equal(await page.locator(".ciji-companion .send-button:visible").count(), 1);
    assert.equal(await page.getByRole("button", { name: "语音会话", exact: true }).count(), 1);
    await noOverflow(page);
    await shot(page, `chat-empty-${viewport.name}`);
    await page.getByRole("button", { name: "模型：自动", exact: true }).click();
    assert.equal(await page.getByRole("radio").count(), 3);
    await page.getByRole("radio", { name: /Terra/ }).click();
    await composer(page).fill("今天只有十五分钟");
    assert.equal(await page.locator(".ciji-companion .send-button:visible").count(), 1);
    await composer(page).press("Enter");
    await page.locator('.ciji-companion .ai-turn[aria-busy="false"]').waitFor();
    assert.equal(state.requests.at(-1).model, "terra");
    assert.equal(await page.locator(".ai-turn").getAttribute("data-model"), "gpt-6.1-terra");
    await noOverflow(page);
    await shot(page, `chat-answer-${viewport.name}`);
    await page.getByRole("button", { name: "展开对话列表", exact: true }).click();
    assert.equal(await page.getByRole("searchbox", { name: "搜索对话" }).count(), 0, "Search appears at six saved conversations");
    assert.equal(await page.locator(".conv-row[data-conv]").count(), 1);
    await noOverflow(page);
    await shot(page, `chat-history-${viewport.name}`);
    await page.locator(".conv-panel").getByRole("button", { name: "收起对话列表", exact: true }).click();
    await composer(page).fill("保留这份草稿");
    await page.getByRole("button", { name: "收起为小窗，回到学习页", exact: true }).click();
    await page.getByRole("region", { name: "AI 小窗", exact: true }).waitFor();
    assert.equal(await composer(page).inputValue(), "保留这份草稿");
    await noOverflow(page);
    await shot(page, `mini-${viewport.name}`);
    await page.getByRole("button", { name: "展开为完整对话", exact: true }).click();
    assert.equal(await composer(page).inputValue(), "保留这份草稿");
    note(`${viewport.name}: Claude chat/model/history/mini layout and shared draft`, { horizontalOverflow: 0 });
  } finally { await context.close(); }
}

async function functionalPaths() {
  const { context, page, state } = await fixture(viewports[0]);
  try {
    await nav(page, ["AI 对话"]);
    await page.locator(".ciji-companion .greeting").waitFor();
    await composer(page).fill("输入法候选测试");
    await composer(page).evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true })));
    assert.equal(state.requests.length, 0);
    await composer(page).press("Shift+Enter");
    assert.ok((await composer(page).inputValue()).includes("\n"));
    await send(page, "第一段普通对话");
    await composer(page).fill("延迟测试");
    await composer(page).press("Enter");
    await page.getByRole("button", { name: "停止回答", exact: true }).click();
    await page.getByText("已停止", { exact: true }).waitFor();
    await page.waitForTimeout(1800);
    assert.equal(await page.getByText("迟到的回答不应显示", { exact: true }).count(), 0);
    note("IME and Shift+Enter do not send; stopping suppresses delayed answer");
    await send(page, "连接错误测试");
    await page.getByText("连接暂不可用，请重试。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "停止回答" }).count(), 0);
    note("Actual client transport displays actionable HTTP error and clears busy state");
    await page.getByRole("button", { name: "开始临时对话", exact: true }).click();
    await send(page, "临时内容 QA_SECRET_817");
    assert.equal(state.requests.at(-1).temporary, true);
    await page.waitForTimeout(600);
    const saved = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("vocab-companion-history")).map((key) => [key, localStorage.getItem(key)]))));
    assert.ok(!saved.includes("QA_SECRET_817"));
    assert.ok(saved.includes("第一段普通对话"));
    await page.getByRole("button", { name: "临时对话已开启，点按退出", exact: true }).click();
    await page.getByRole("button", { name: "清除并离开", exact: true }).click();
    note("Temporary conversation uses temporary request scope and never persists");
    await page.getByRole("button", { name: "语音会话", exact: true }).click();
    await page.locator(".live-voice-stage").waitFor();
    assert.equal(await page.locator("dialog:visible .live-voice-stage").count(), 0);
    assert.equal(await page.getByRole("button", { name: "开始语音", exact: true }).isDisabled(), true);
    assert.equal(state.voiceSessions, 0);
    await shot(page, "voice-unconfigured-desktop");
    await page.getByRole("button", { name: "结束语音会话", exact: true }).click();
    await page.locator(".ciji-companion .greeting").waitFor();
    note("Voice uses full chat region and unconfigured service never opens microphone/session");
    await page.locator('.composer input[type="file"]').setInputFiles({ name: "learning-notes.txt", mimeType: "text/plain", buffer: Buffer.from("attachment text QA_FILE_229: practice, regular efforts") });
    await page.getByRole("button", { name: /查看附件 learning-notes.txt：已读取/ }).waitFor();
    assert.equal(await page.locator(".ciji-companion .send-button:visible").count(), 1);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ciji-companion .ai-turn')?.getAttribute("aria-busy") === "false");
    assert.ok(state.requests.at(-1).files[0].text.includes("QA_FILE_229"));
    await page.waitForTimeout(600);
    assert.ok(!(await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith("vocab-companion-history")).map((key) => [key, localStorage.getItem(key)]))))).includes("QA_FILE_229"));
    note("Actual TXT file read sends content once and leaves raw attachment out of persisted history");
    await nav(page, ["阅读"]);
    await page.locator(".reading-card").first().click();
    const para = page.locator("[data-reading-ai-paragraph]").first();
    await para.waitFor();
    const selected = await para.evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); const first = walker.nextNode();
      range.setStart(first, 0); range.setEnd(first, Math.min(first.textContent.length, 100));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return range.toString().trim();
    });
    await page.getByRole("toolbar", { name: "选文工具" }).waitFor();
    await page.getByRole("toolbar", { name: "选文工具" }).getByRole("button", { name: "翻译", exact: true }).click();
    await page.getByRole("region", { name: "AI 小窗", exact: true }).waitFor();
    await page.locator('.mini-panel .ai-turn[aria-busy="false"]').last().waitFor();
    assert.equal(state.requests.at(-1).quotes[0].text, selected);
    assert.equal(state.requests.at(-1).action, "translate");
    await noOverflow(page);
    await shot(page, "reading-selection-mini-desktop");
    await page.getByRole("button", { name: "展开为完整对话", exact: true }).click();
    assert.equal(await page.locator(".sent-quote").last().innerText().then((text) => text.includes(selected)), true);
    note("Actual article Range selection reaches shared mini/full request with exact quote");
  } finally { await context.close(); }
}

async function accountBoundary() {
  const { context, page, state } = await fixture(viewports[0]);
  try {
    await nav(page, ["AI 对话"]); await page.locator(".ciji-companion .greeting").waitFor();
    await send(page, "账户 A 已保存内容");
    await composer(page).fill("账户 A 未发送草稿");
    await page.locator('.composer input[type="file"]').setInputFiles({ name: "account-a.txt", mimeType: "text/plain", buffer: Buffer.from("ACCOUNT_A_FILE_440") });
    await page.getByRole("button", { name: /查看附件 account-a.txt：已读取/ }).waitFor();
    const sameAccountRefresh = page.waitForResponse((response) => response.url().includes("/api/learning-memory"));
    await page.evaluate(() => window.dispatchEvent(new Event("vocab-ai-config-changed")));
    await sameAccountRefresh;
    await page.waitForFunction(() => document.querySelector('.ciji-companion .composer textarea')?.value === "账户 A 未发送草稿");
    await page.getByRole("button", { name: /查看附件 account-a.txt：已读取/ }).waitFor();
    assert.equal(await page.locator(".user-turn").getByText("账户 A 已保存内容", { exact: true }).count(), 1);
    note("Same-account context refresh restores the quarantined draft and attachment after verification");
    state.scope = "qa-account-b";
    const refreshed = page.waitForResponse((response) => response.url().includes("/api/learning-memory"));
    await page.evaluate(() => window.dispatchEvent(new Event("vocab-ai-config-changed")));
    await refreshed;
    await page.waitForFunction(() => document.querySelector('.ciji-companion .composer textarea')?.value !== "账户 A 未发送草稿");
    assert.equal(await page.getByText("账户 A 已保存内容", { exact: true }).count(), 0);
    await send(page, "账户 B 的问题");
    assert.equal(state.requests.at(-1).accountScope, "qa-account-b");
    assert.ok(!JSON.stringify(state.requests.at(-1)).includes("账户 A"));
    assert.ok(!JSON.stringify(state.requests.at(-1)).includes("ACCOUNT_A_FILE_440"));
    assert.equal(await page.getByRole("button", { name: /查看附件 account-a.txt/ }).count(), 0);
    note("Account invalidation refreshes context, clears prior data and sends only under the new scope");
    await page.getByRole("button", { name: "展开对话列表", exact: true }).click();
    const row = page.locator(".conv-row[data-conv]").filter({ hasText: "账户 B 的问题" });
    await row.focus(); await row.press("Delete");
    await page.locator(".conv-confirm").getByRole("button", { name: "删除", exact: true }).click();
    assert.equal(await page.locator(".conv-row[data-conv]").filter({ hasText: "账户 B 的问题" }).count(), 0);
    note("Keyboard delete removes the selected saved conversation");
  } finally { await context.close(); }
}

async function actualPractice() {
  const { context, page, state } = await fixture(viewports[0]);
  try {
    await nav(page, ["AI 对话"]); await page.locator(".ciji-companion .greeting").waitFor();
    await send(page, "安排一轮实际复习");
    await page.getByRole("button", { name: /打开实际复习/ }).click();
    await page.getByRole("button", { name: "暂时想不起来", exact: true }).click();
    await page.getByRole("button", { name: "继续学习", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="本轮进度"]')?.getAttribute("aria-valuenow") === "1" || Boolean(document.querySelector(".study-complete")));
    const finish = page.getByRole("button", { name: "带回对话", exact: true });
    if (await finish.isVisible()) await finish.click();
    else await page.getByRole("button", { name: "保存进度并退出", exact: true }).click();
    await page.getByRole("region", { name: "练习结果", exact: true }).waitFor();
    assert.equal(await page.locator(".companion-result-mistakes li").count(), 1);
    assert.match(await page.locator(".companion-result-mistakes li strong").innerText(), /^[A-Za-z]/, "Review result must name the actual English headword, not only its Chinese expected meaning");
    assert.ok((await page.locator(".companion-result-score").innerText()).includes("0"));
    await shot(page, "actual-practice-result-desktop");
    await page.getByRole("button", { name: "分析这次练习", exact: true }).click();
    await page.locator('.ciji-companion .ai-turn[aria-busy="true"]').waitFor({ state: "hidden" });
    assert.ok(state.requests.at(-1).messages.some((message) => message.text.includes("练习结果：") && message.text.includes("未作答") && message.text.includes("待复习")));
    note("Action card opens actual study session, saves one answer and returns its real result to follow-up context");
  } finally { await context.close(); }
}

async function crossTabDeletion() {
  const { context, page } = await fixture(viewports[0]);
  const key = "vocab-companion-history-v1:qa-account-a";
  try {
    await nav(page, ["AI 对话"]); await page.locator(".ciji-companion .greeting").waitFor();
    await send(page, "跨标签待删除会话 QA_DELETE_613");
    await page.waitForFunction((key) => localStorage.getItem(key)?.includes("QA_DELETE_613"), key);
    const conversationId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).conversations.find((row) => row.title.includes("QA_DELETE_613")).id, key);
    const other = await context.newPage();
    other.on("pageerror", (error) => errors.push({ viewport: "desktop-tab-b", message: error.message }));
    other.setDefaultTimeout(12_000);
    await other.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await other.locator(".daily-feature").waitFor({ timeout: 60_000 });
    await nav(other, ["AI 对话"]);
    await other.getByRole("button", { name: "展开对话列表", exact: true }).click();
    const row = other.locator(".conv-row[data-conv]").filter({ hasText: "QA_DELETE_613" });
    await row.waitFor();
    // Control only this tab's 250 ms timers, keeping the actual Provider, storage,
    // storage events and Web Locks unchanged. Captured callbacks are also released
    // after cancellation to exercise the commit guard, not merely clearTimeout.
    await page.evaluate(() => {
      const originalSet = window.setTimeout.bind(window), originalClear = window.clearTimeout.bind(window);
      const callbacks = []; let next = -70000;
      window.__qaHistoryTimers = { callbacks, originalSet, originalClear };
      window.setTimeout = (handler, delay, ...args) => {
        if (delay === 250 && typeof handler === "function") {
          const task = { id: next--, run: () => handler(...args), cancelled: false };
          callbacks.push(task); return task.id;
        }
        return originalSet(handler, delay, ...args);
      };
      window.clearTimeout = (id) => {
        const task = callbacks.find((entry) => entry.id === id);
        if (task) task.cancelled = true;
        else originalClear(id);
      };
    });
    await send(page, "待保存的新内容 QA_PENDING_614");
    const waitingCallbacks = await page.evaluate(() => window.__qaHistoryTimers.callbacks.filter((task) => !task.cancelled).map((task) => task.id));
    assert.ok(waitingCallbacks.length > 0, "A must have a scheduled 250 ms write before B deletes");
    assert.ok(!(await page.evaluate((key) => localStorage.getItem(key), key)).includes("QA_PENDING_614"), "A's newer state has not been saved yet");
    await row.focus(); await row.press("Delete");
    await other.locator(".conv-confirm").getByRole("button", { name: "删除", exact: true }).click();
    await page.waitForFunction(({ key, id }) => !localStorage.getItem(key)?.includes(id), { key, id: conversationId });
    await page.locator(".ciji-companion .greeting").waitFor();
    const released = await page.evaluate((ids) => {
      const harness = window.__qaHistoryTimers;
      const tasks = harness.callbacks.filter((task) => ids.includes(task.id));
      window.setTimeout = harness.originalSet; window.clearTimeout = harness.originalClear;
      for (const task of tasks) task.run();
      delete window.__qaHistoryTimers;
      return tasks.length;
    }, waitingCallbacks);
    assert.ok(released > 0);
    await page.waitForTimeout(600);
    const stored = await page.evaluate((key) => localStorage.getItem(key) || "", key);
    assert.ok(!stored.includes(conversationId) && !stored.includes("QA_DELETE_613") && !stored.includes("QA_PENDING_614"));
    await other.reload({ waitUntil: "domcontentloaded" }); await other.locator(".daily-feature").waitFor();
    await nav(other, ["AI 对话"]); await other.locator(".ciji-companion .greeting").waitFor();
    await other.getByRole("button", { name: "展开对话列表", exact: true }).click();
    assert.equal(await other.locator(".conv-row[data-conv]").filter({ hasText: /QA_DELETE_613|QA_PENDING_614/ }).count(), 0);
    note("Cross-tab deletion survives the released stale 250 ms save callback and a fresh page reload", { tabs: 2, releasedStaleCallbacks: released, actualProviderAndLocalStorage: true, timerControl: "Only A's 250 ms timers are captured; its pre-deletion callback is released after B's real UI deletion, even if cancelled, to exercise the commit guard." });
  } finally { await context.close(); }
}

let failure;
try {
  if (only === "account") await accountBoundary();
  else if (only === "cross-tab") await crossTabDeletion();
  else if (only === "practice") await actualPractice();
  else if (only === "phone") await viewportSmoke(viewports.find((viewport) => viewport.name === "phone"));
  else { for (const viewport of viewports) await viewportSmoke(viewport); await functionalPaths(); await accountBoundary(); await actualPractice(); await crossTabDeletion(); }
  assert.deepEqual(errors, []);
} catch (error) { failure = error; console.error(error); }
finally {
  const report = { status: failure ? "failed" : "passed", browser: await browser.version(), base, viewportSizes: viewports, checks: results, screenshots, pageErrors: errors, failure: failure ? String(failure.stack || failure) : null, limits: ["HTTP fixture responses cover client transport and UI behavior; upstream model quality/latency is not measured.", "Voice readiness fixture is unconfigured; no microphone or paid voice session is started.", "Screenshots capture the real local app with controlled QA answers."] };
  await writeFile(new URL(only === "all" ? "./integration-browser.json" : `./integration-browser-${only}.json`, import.meta.url), JSON.stringify(report, null, 2));
  await browser.close();
}
if (failure) process.exitCode = 1;
