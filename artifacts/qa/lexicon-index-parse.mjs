// Compares start-up parsing of the lexicon index in Chromium: the earlier
// object array against the row encoding plus decoding, at normal and 4x CPU.
// Usage: node artifacts/qa/lexicon-index-parse.mjs [baseline-ref]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');
const baseline = process.argv[2] || 'b224f1c';
const legacy = execFileSync('git', ['show', `${baseline}:public/data/v1/index.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const encoded = readFileSync(new URL('../../public/data/v1/index.json', import.meta.url), 'utf8');
const codec = readFileSync(new URL('../../lib/lexicon-index-codec.mjs', import.meta.url), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addScriptTag({ type: 'module', content: `${codec}\nwindow.decodeLexiconIndex = decodeLexiconIndex;` });
  await page.waitForFunction(() => typeof window.decodeLexiconIndex === 'function');
  const cdp = await page.context().newCDPSession(page);
  const result = { baseline, bytes: { before: Buffer.byteLength(legacy), after: Buffer.byteLength(encoded) }, medianMs: {} };
  for (const rate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    result.medianMs[`cpu${rate}x`] = await page.evaluate(([before, after]) => {
      const median = (run) => {
        for (let i = 0; i < 3; i++) run();
        const samples = Array.from({ length: 9 }, () => { const start = performance.now(); run(); return performance.now() - start; }).sort((a, b) => a - b);
        return Number(samples[4].toFixed(1));
      };
      const same = JSON.stringify(JSON.parse(before)) === JSON.stringify(window.decodeLexiconIndex(JSON.parse(after)));
      if (!same) throw new Error('Decoded index differs from the baseline');
      return { before: median(() => JSON.parse(before)), after: median(() => window.decodeLexiconIndex(JSON.parse(after))) };
    }, [legacy, encoded]);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
