// Behaviour smoke test for the shell, practice, reading, lexicon and record views.
// Usage: node artifacts/perf/smoke.mjs <url>
import assert from "node:assert/strict";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const url = process.argv[2] || "http://127.0.0.1:5200/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`ok   ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${String(e.message).split("\n")[0]}`); }
};
const nav = (label) => page.click(`.app-sidebar button[aria-label="${label}"]`);
const position = async () => Number((await page.textContent(".study-header strong")).split("/")[0].trim());

await page.goto(url);
await page.waitForSelector(".today-view");

await step("toast appears, stays in the live region and dismisses itself after about 5 s", async () => {
  assert.equal(await page.locator(".toast-region[aria-live=polite]").count(), 1);
  await page.click(".today-footnotes button:first-child");
  await page.waitForSelector(".toast-region .toast");
  assert.match(await page.textContent(".toast-region .toast span"), /待巩固词/);
  const t0 = Date.now();
  await page.waitForSelector(".toast-region .toast", { state: "detached", timeout: 8000 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed > 4000 && elapsed < 7000, `dismissed after ${elapsed} ms`);
  assert.equal(await page.locator(".toast-region").count(), 1);
});
await step("toast close button dismisses at once", async () => {
  await page.click(".today-footnotes button:first-child");
  await page.click('.toast button[aria-label="关闭提示"]');
  await page.waitForSelector(".toast-region .toast", { state: "detached", timeout: 1000 });
});

await step("lexicon keeps search and page across tab switches", async () => {
  await nav("词库");
  await page.waitForSelector(".lexicon-view");
  await page.click(".scope-switch button:has-text('全部')");
  await page.click(".pagination button >> nth=-1");
  await page.click(".pagination button >> nth=-1");
  assert.match(await page.textContent(".pagination span"), /第 3 \//);
  await nav("阅读");
  await page.waitForSelector(".reading-shelf");
  await nav("词库");
  assert.match(await page.textContent(".pagination span"), /第 3 \//);
  await page.fill("#lexicon-search", "apple");
  await page.waitForFunction(() => document.querySelectorAll(".word-row").length < 40);
  await nav("今日学习");
  await nav("词库");
  assert.equal(await page.inputValue("#lexicon-search"), "apple");
  await page.click('button[aria-label="清空搜索"]');
});

await step("only the visible view is displayed", async () => {
  const shown = await page.$$eval(".view-surface", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
  assert.equal(shown, 1);
});

await step("reading keeps the open article and lookup opens word detail", async () => {
  await nav("阅读");
  await page.waitForSelector(".reading-card");
  await page.click(".reading-card >> nth=0");
  await page.waitForSelector(".reader-prose");
  const title = await page.textContent(".reader-title h1");
  const lookup = page.locator(".reader-translation-toggle", { hasText: "查词" });
  if (await lookup.count()) {
    await lookup.click();
    await page.waitForSelector(".reader-inline-word");
    const words = await page.$$eval(".reader-inline-word", (els) => els.map((e) => e.textContent.toLowerCase()));
    assert.equal(new Set(words).size, words.length, "each word is linked once");
    await page.click(".reader-type-size button[aria-label=放大字号]");
    assert.equal(await page.locator(".reader-inline-word").count(), words.length);
    await page.click(".reader-inline-word >> nth=0");
    await page.waitForSelector(".word-dialog[open]");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".word-dialog[open]", { state: "detached" });
  }
  await nav("学习记录");
  await page.waitForSelector(".activity-view");
  await nav("阅读");
  assert.equal(await page.textContent(".reader-title h1"), title);
  await page.click(".reader-back");
  await page.waitForSelector(".reading-card");
});

await step("slash and Ctrl+K open lexicon search", async () => {
  await nav("今日学习");
  await page.keyboard.press("/");
  await page.waitForSelector(".lexicon-view");
  await page.waitForFunction(() => document.activeElement?.id === "lexicon-search");
  await nav("阅读");
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.id === "lexicon-search");
  await page.locator("#lexicon-search").blur();
});

let practised = 0;
await step("practice: Space reveals and rates, z undoes, 1-4 rate, r is harmless", async () => {
  await nav("词库");
  await page.click(".word-list-meta .primary.small");
  await page.waitForSelector(".study-question");
  assert.equal(await position(), 1);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Space");
    await page.waitForSelector(".study-question.is-revealed");
    await page.keyboard.press("Space");
    await page.waitForFunction((n) => Number(document.querySelector(".study-header strong").textContent.split("/")[0]) === n, i + 2);
  }
  practised = 3;
  await page.locator("body").focus().catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("z");
  await page.waitForFunction(() => Number(document.querySelector(".study-header strong").textContent.split("/")[0]) === 3);
  practised = 2;
  await page.keyboard.press("Space");
  await page.waitForSelector(".study-question.is-revealed");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("4");
  await page.waitForFunction(() => Number(document.querySelector(".study-header strong").textContent.split("/")[0]) === 4);
  practised = 3;
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("r");
  await page.keyboard.press("Control+k");
  assert.ok(await page.$(".study-screen"), "Ctrl+K does not leave practice");
});

await step("exit keeps a resumable position; resume continues there", async () => {
  await page.click(".study-footer .text-button");
  await page.waitForSelector(".today-view");
  assert.match(await page.textContent("#daily-title"), /接着上次学/);
  assert.match(await page.textContent(".daily-feature-copy p"), /第 4 \/ 20 词/);
  await page.click(".feature-action .primary");
  await page.waitForSelector(".study-question");
  assert.equal(await position(), 4);
  await page.click(".study-footer .text-button");
  await page.waitForSelector(".today-view");
});

await step("keys outside practice do not answer anything", async () => {
  await nav("学习记录");
  await page.waitForSelector(".activity-view");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Space");
  await page.keyboard.press("3");
  assert.equal(await page.locator(".log-row").count(), practised);
});

await step("records persist across reload and the resume survives", async () => {
  await page.reload();
  await page.waitForSelector(".today-view");
  assert.match(await page.textContent("#daily-title"), /接着上次学/);
  await nav("学习记录");
  await page.waitForSelector(".activity-view");
  assert.equal(await page.locator(".log-row").count(), practised);
});

await step("no console errors", async () => assert.deepEqual(errors, []));
await browser.close();
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
