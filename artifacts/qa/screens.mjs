// Screen-by-screen screenshots for before/after visual comparison.
// usage: node shots.mjs <baseUrl> <outDir>
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');
import { mkdirSync } from 'node:fs';

const [base = 'http://127.0.0.1:5210', out = './shots'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const profiles = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'ipad', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
];
const schemes = ['light', 'dark'];

const seedScript = () => {
  let s = 0x9e3779b9;
  Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
};

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise(r => (window.requestIdleCallback || setTimeout)(() => r(), { timeout: 1500 })));
  await page.waitForTimeout(250);
}

async function nav(page, label) {
  const buttons = page.locator(`nav:visible button:has-text("${label}")`);
  if (await buttons.count()) { await buttons.first().click(); return; }
  await page.locator(`button[aria-label="${label}"]:visible`).first().click();
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
for (const profile of profiles) {
  for (const scheme of schemes) {
    const context = await browser.newContext({ ...profile, colorScheme: scheme, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    await context.addInitScript(seedScript);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date('2026-09-24T10:00:00+08:00'));
    page.on('pageerror', e => errors.push(`${profile.name}/${scheme}: ${e.message}`));
    const shot = async (name) => {
      await settle(page);
      await page.screenshot({ path: `${out}/${profile.name}-${scheme}-${name}.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
    };
    const step = async (name, fn) => {
      try { await fn(); await shot(name); } catch (e) { errors.push(`${profile.name}/${scheme}/${name}: ${e.message.split('\n')[0]}`); }
    };
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.today-view', { timeout: 60000 });
    await step('01-today', async () => {});
    await step('02-lexicon', async () => { await nav(page, '词库'); await page.waitForSelector('.word-row'); });
    await step('03-lexicon-search', async () => { await page.fill('input[aria-label="搜索单词或中文释义"]', 'exchange'); await page.waitForTimeout(400); });
    await step('04-word-detail', async () => { await page.locator('.word-open').first().click(); await page.waitForSelector('dialog[open]'); await page.waitForTimeout(600); });
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(600);
    await step('05-reading', async () => { await nav(page, '阅读'); await page.waitForSelector('.reading-shelf'); await page.waitForTimeout(800); });
    await step('06-reading-article', async () => { await page.locator('.reading-card').first().click(); await page.waitForSelector('.reader-prose', { timeout: 15000 }); });
    await step('07-reading-lookup', async () => { await page.locator('button.reader-translation-toggle:has-text("查词")').click(); });
    await step('08-activity', async () => { await nav(page, '记录'); await page.waitForTimeout(500); });
    await step('09-settings', async () => { await nav(page, '设置'); await page.waitForSelector('dialog[open]'); await page.waitForTimeout(600); });
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(600);
    await step('10-today-again', async () => { await nav(page, '今日'); await page.waitForSelector('.today-view'); });
    await step('11-practice', async () => { await page.locator('.daily-feature button.primary').click(); await page.waitForSelector('.study-screen', { timeout: 15000 }); await page.waitForTimeout(800); });
    await step('12-practice-answered', async () => {
      const choice = page.locator('.study-stage button:visible').first();
      await choice.click();
    });
    await page.locator('.study-header .icon-button').first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.today-view', { timeout: 60000 });
    for (const [i, title] of [['13', '词卡速记'], ['14', '配对消除'], ['15', '单元自测']]) {
      await step(`${i}-learn-${title}`, async () => {
        await page.locator(`.practice-option:has-text("${title}")`).click();
        await page.waitForTimeout(900);
      });
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      await page.waitForSelector('.today-view', { timeout: 60000 });
    }
    await step('16-dictation', async () => { await page.locator('.practice-option:has-text("单词听写")').click(); await page.waitForSelector('.study-screen', { timeout: 15000 }); });
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify({ errors }, null, 2));
