const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const url of process.argv.slice(2)) {
  const ctx = await b.newContext({ colorScheme: 'dark', contrast: 'more' }); const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForSelector('.today-view');
  const tokens = await p.evaluate(() => { const s = getComputedStyle(document.documentElement); return { muted: s.getPropertyValue('--muted').trim(), line: s.getPropertyValue('--line').trim() }; });
  console.log(url, tokens);
  if (tokens.muted !== '#d1d1d6') process.exitCode = 1;
  await ctx.close();
}
await b.close();
