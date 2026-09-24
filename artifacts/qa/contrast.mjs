// WCAG text-contrast audit across the main screens. usage: node contrast.mjs <baseUrl>
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');

const base = process.argv[2] || 'http://127.0.0.1:5210';
const audit = () => {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = el => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient')) return null;
      if (n.tagName === 'CANVAS') return null;
      const c = parse(cs.backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length || layers[layers.length - 1].a < 1) result = matchMedia('(prefers-color-scheme: dark)').matches ? { r: 0, g: 0, b: 0, a: 1 } : result;
    for (const layer of layers.reverse()) result = blend(layer, result);
    return result;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0 || el.closest('[aria-hidden="true"],[inert],.sr-only,.learn-sr')) continue;
    if (el.closest('button:disabled,[aria-disabled="true"]')) continue;
    const fg = parse(cs.color), bg = background(el); if (!fg || !bg) continue;
    const color = blend(fg, bg);
    const [l1, l2] = [lum(color), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) out.push({ text: t.textContent.trim().slice(0, 24), cls: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`.slice(0, 60), parent: (el.parentElement?.className || '').toString().slice(0, 40), ratio: +ratio.toFixed(2), need, fg: cs.color, });
  }
  return out;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const report = [];
for (const scheme of ['light', 'dark']) for (const contrast of ['no-preference', 'more']) for (const hour of ['07:00', '12:00', '18:00']) {
  if ((contrast === 'more' || scheme === 'dark') && hour !== '12:00') continue;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, contrast, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.clock.setFixedTime(new Date(`2026-09-24T${hour}:00+08:00`));
  const check = async (screen) => { await page.waitForTimeout(700); for (const r of await page.evaluate(audit)) report.push({ scheme, contrast, hour, screen, ...r }); };
  const go = async () => { await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForSelector('.today-view', { timeout: 60000 }); };
  const nav = label => page.locator(`nav:visible button:has-text("${label}")`).first().click();
  try {
    await go(); await check('today');
    if (hour !== '12:00') { await ctx.close(); continue; }
    await nav('词库'); await page.waitForSelector('.word-row'); await check('lexicon');
    await page.locator('.filter-toggle').click().catch(() => {}); await check('lexicon-filters');
    await nav('阅读'); await page.waitForSelector('.reading-card'); await check('reading');
    await page.locator('.reading-card').first().click(); await page.waitForSelector('.reader-prose'); await page.locator('button.reader-translation-toggle').first().click(); await check('reader');
    await page.locator('.reader-choices > button').first().click().catch(() => {}); await check('reader-answered');
    await nav('记录'); await check('activity');
    await go(); await page.locator('.practice-option:has-text("配对消除")').click(); await page.waitForTimeout(600);
    await page.locator('button:has-text("开始")').first().click().catch(() => {}); await page.waitForTimeout(600);
    await page.locator('.learn-stage button:visible').first().click().catch(() => {}); await check('match');
    await go(); await page.locator('.practice-option:has-text("单元自测")').click(); await check('quiz-setup');
    await page.locator('button:has-text("开始")').first().click().catch(() => {}); await page.waitForTimeout(600);
    await page.locator('.learn-stage button:visible').nth(1).click().catch(() => {}); await check('quiz-answered');
    await go(); await page.locator('.daily-feature button.primary').click(); await page.waitForSelector('.study-screen'); await check('practice');
  } catch (e) { report.push({ scheme, contrast, hour, error: e.message.split('\n')[0] }); }
  await ctx.close();
}
await browser.close();
const unique = new Map();
for (const r of report) { const k = `${r.scheme}|${r.contrast}|${r.cls}|${r.ratio}`; if (!unique.has(k)) unique.set(k, r); }
for (const r of unique.values()) console.log(JSON.stringify(r));
console.log(`issues: ${unique.size}`);
if (unique.size || report.some(r => r.error)) process.exitCode = 1;
