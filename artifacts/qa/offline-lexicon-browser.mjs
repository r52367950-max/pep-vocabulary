// Run against a production preview after npm run build with refactor-browser.mjs's browser settings.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2] || "http://127.0.0.1:4173";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: "zh-CN", reducedMotion: "reduce",
  });
  context.setDefaultTimeout(20000);
  const errors = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));

  async function openDownload() {
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "开始学习", exact: true }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 60000 });
    await page.locator('button[aria-label="设置"]:visible').click();
    await page.getByRole("button", { name: "数据与安全" }).click();
    await page.getByRole("button", { name: /备份、恢复与私有同步/ }).click();
    return page;
  }

  // Load the second tab after SW installation, so its real CORS preloads use the release cache.
  const first = await openDownload();
  const second = await openDownload();
  await Promise.all([first, second].map(async page => {
    await page.getByRole("button", { name: "下载离线词库" }).click();
    const feedback = page.locator(".toast span");
    await feedback.waitFor({ state: "attached", timeout: 125000 });
    assert.equal(await feedback.textContent(), "全部词条已准备好，可在离线时继续使用。");
  }));

  const counts = await first.evaluate(async () => {
    const cacheName = (await caches.keys()).find(name => name.startsWith("vocab-shell-"));
    const cache = await caches.open(cacheName);
    const paths = new Set((await cache.keys()).map(request => new URL(request.url).pathname));
    const manifest = await (await cache.match("/data/v1/manifest.json")).json();
    const cached = manifest.chunks.filter(chunk => paths.has("/data/v1/" + chunk.file)).length;
    return { required: manifest.chunks.length, cached };
  });
  assert.ok(counts.required > 0);
  assert.equal(counts.cached, counts.required);
  await context.setOffline(true);
  await first.reload();
  await first.getByRole("button", { name: "开始学习", exact: true }).waitFor();
  await first.locator(".app-sidebar").getByRole("button", { name: "词库", exact: true }).click();
  await first.locator(".scope-switch").getByRole("button", { name: "全部", exact: true }).click();
  await first.getByRole("searchbox", { name: "搜索单词或中文释义" }).fill("apple");
  await first.waitForFunction(() => document.querySelector(".word-row .word-en strong")?.textContent === "apple");
  await first.locator(".word-open").first().click();
  await first.locator(".word-dialog .english-definition").waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ tabs: 2, ...counts, offlineReload: true, offlineWordDetails: true, errors }));
} finally {
  await browser.close();
}
