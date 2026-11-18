// Time a visible answer while a future word's dictionary chunk is still arriving.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const base = process.argv[2] || "http://127.0.0.1:5173";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const delayMs = 900;
const answerAfterMs = 1400;

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(15000);
  let delayPrefetch = false;
  let delayedRequests = 0;
  await page.route("**/data/v1/chunks/*.json", async route => {
    if (delayPrefetch) {
      delayedRequests++;
      await pause(delayMs);
    }
    await route.continue();
  });
  const button = name => page.getByRole("button", { name, exact: true });
  await page.goto(base);
  await button("开始学习").waitFor();
  await page.keyboard.press("Control+k");
  await button("全部").click();
  await button("词库选项").click();
  await page.getByText("选择词语", { exact: true }).click();

  // Five adjacent dictionary entries share the first chunk. The sixth starts a new request on step two.
  for (let index = 0; index < 5; index++) {
    await page.locator(".word-row").nth(index).locator(".word-open").click();
  }
  await page.locator("#lexicon-search").fill("zipper");
  await page.waitForFunction(() => document.querySelector(".word-row .word-en strong")?.textContent === "zipper");
  await page.locator(".word-open").first().click();
  await button("开始练习").click();
  await button("显示词义").click();
  delayPrefetch = true;
  await page.locator(".recommended").click();
  await button("显示词义").waitFor();
  await pause(answerAfterMs);
  await button("显示词义").click();
  await page.locator(".recommended").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="本轮进度"]')?.getAttribute("aria-valuenow") === "2");

  const responseMs = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pep-vocab-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const events = await new Promise((resolve, reject) => {
        const request = db.transaction("events").objectStore("events").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return events.find(event => event.eventId.endsWith(":1:0"))?.responseMs;
    } finally {
      db.close();
    }
  });
  assert.ok(delayedRequests > 0);
  assert.ok(responseMs >= answerAfterMs - 50, `计时过短：${responseMs} ms`);
  console.log(JSON.stringify({ delayedRequests, delayMs, answerAfterMs, responseMs }));
} finally {
  await browser.close();
}
