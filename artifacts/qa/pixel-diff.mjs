// Pixel-compare two screenshot folders. usage: node diff.mjs <before> <after> <diffOut>
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const [a, b, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const rows = [];
for (const file of readdirSync(a).filter(f => f.endsWith('.png')).sort()) {
  if (!existsSync(`${b}/${file}`)) { rows.push({ file, status: 'missing-after' }); continue; }
  const res = await page.evaluate(async ([x, y]) => {
    const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [i1, i2] = await Promise.all([load(x), load(y)]);
    const w = Math.max(i1.width, i2.width), h = Math.max(i1.height, i2.height);
    const get = img => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = '#ff00ff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const d1 = get(i1), d2 = get(i2);
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(i1, 0, 0); g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(0, 0, w, h);
    const out = g.getImageData(0, 0, w, h);
    let diff = 0;
    for (let p = 0; p < d1.length; p += 4) {
      const delta = Math.abs(d1[p] - d2[p]) + Math.abs(d1[p + 1] - d2[p + 1]) + Math.abs(d1[p + 2] - d2[p + 2]);
      if (delta > 24) { diff++; out.data[p] = 255; out.data[p + 1] = 0; out.data[p + 2] = 0; out.data[p + 3] = 255; }
    }
    g.putImageData(out, 0, 0);
    const blob = await c.convertToBlob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (const v of buf) bin += String.fromCharCode(v);
    return { size1: `${i1.width}x${i1.height}`, size2: `${i2.width}x${i2.height}`, diff, ratio: diff / (w * h), png: diff ? btoa(bin) : null };
  }, [`data:image/png;base64,${readFileSync(`${a}/${file}`).toString('base64')}`, `data:image/png;base64,${readFileSync(`${b}/${file}`).toString('base64')}`]);
  if (res.png) writeFileSync(`${out}/${file}`, Buffer.from(res.png, 'base64'));
  rows.push({ file, size: res.size1 === res.size2 ? res.size1 : `${res.size1} -> ${res.size2}`, diffPixels: res.diff, ratio: +res.ratio.toFixed(5) });
}
await browser.close();
for (const r of rows) if (r.diffPixels || r.status || r.size?.includes('->')) console.log(JSON.stringify(r));
if (rows.some(r => r.diffPixels || r.status || r.size?.includes('->'))) process.exitCode = 1;
console.log(`compared ${rows.length}, identical ${rows.filter(r => r.diffPixels === 0 && !r.size?.includes('->')).length}`);
