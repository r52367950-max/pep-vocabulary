// Screenshots of the main views on two builds, desktop 1280x800 and phone 390x844 (touch),
// and a pixel comparison between them.
// Usage: node artifacts/perf/screens.mjs <outDir> before=<url> after=<url>
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const [outDir, ...pairs] = process.argv.slice(2);
const targets = pairs.map((p) => p.split("="));
mkdirSync(outDir, { recursive: true });
const devices = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const artReady = (page) => page.waitForFunction(() => [...document.querySelectorAll("canvas.artwork")].filter((c) => c.offsetParent).every((c) => c.dataset.ready === "true"), null, { timeout: 15000 }).catch(() => {});
const shots = [];
for (const [device, options] of Object.entries(devices)) {
  for (const [label, url] of targets) {
    const context = await browser.newContext({ ...options, locale: "zh-CN", reducedMotion: "reduce" });
    const page = await context.newPage();
    const go = async (name) => {
      if (device === "desktop") await page.click(`.app-sidebar button[aria-label="${name}"]`);
      else await page.click(`.mobile-nav button:has-text("${{ 今日学习: "今日", 词库: "词库", 阅读: "阅读", 学习记录: "记录" }[name]}")`);
    };
    const shot = async (name) => {
      await page.waitForTimeout(400);
      await artReady(page);
      await page.evaluate(() => document.activeElement?.blur());
      const file = `${outDir}/${device}-${name}-${label}.png`;
      await page.screenshot({ path: file, fullPage: false });
      shots.push({ device, name, label, file });
    };
    await page.goto(url);
    await page.waitForSelector(".today-view");
    await shot("today");
    await page.click(".today-footnotes button:first-child");
    await page.waitForSelector(".toast-region .toast");
    await shot("toast");
    await page.click('.toast button[aria-label="关闭提示"]');
    await go("词库");
    await page.waitForSelector(".word-row");
    await shot("lexicon");
    await go("阅读");
    await page.waitForSelector(".reading-card");
    await shot("reading");
    await page.click(".reading-card >> nth=0");
    await page.waitForSelector(".reader-prose");
    const lookup = page.locator(".reader-translation-toggle", { hasText: "查词" });
    if (await lookup.count()) await lookup.click();
    await page.evaluate(() => window.scrollTo(0, 500));
    await shot("article");
    await page.click(".reader-back");
    await go("学习记录");
    await page.waitForSelector(".activity-view");
    await shot("activity");
    await go("词库");
    await page.waitForSelector(".word-row");
    await page.click(".word-list-meta .primary.small");
    await page.waitForSelector(".study-question");
    await shot("practice");
    await page.click(".study-controls .primary");
    await page.waitForSelector(".study-question.is-revealed");
    await shot("practice-revealed");
    await context.close();
  }
}
// Pixel comparison in the browser: count differing pixels per screen.
const page = await browser.newPage();
const report = [];
const groups = Object.groupBy(shots, (s) => `${s.device}-${s.name}`);
for (const [key, list] of Object.entries(groups)) {
  if (list.length !== 2) continue;
  const [a, b] = list.map((s) => `data:image/png;base64,${readFileSync(s.file).toString("base64")}`);
  const diff = await page.evaluate(async ([x, y]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true };
    const read = (img) => { const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const da = read(ia), db = read(ib);
    let n = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
    return { differing: n, total: da.length / 4 };
  }, [a, b]);
  report.push({ screen: key, ...diff, pct: diff.total ? +(100 * diff.differing / diff.total).toFixed(3) : null });
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
