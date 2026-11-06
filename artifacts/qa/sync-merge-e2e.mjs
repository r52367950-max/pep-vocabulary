// Two browser profiles (devices) share one gateway identity against the built
// Worker in local workerd with a fresh D1. Device A uploads, device B studies
// the same words and merges, then device A studies again and merges.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Usage after npm run build: node artifacts/qa/sync-merge-e2e.mjs [screenshot-dir]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs');

const root = process.cwd();
const shots = process.argv[2] || resolve(root, 'artifacts/qa/2.17.0');
const { Miniflare, convertV4MiniflareOptions } = await import(resolve(root, 'node_modules/miniflare/dist/src/index.js'));
const paths = readdirSync('dist/server', { recursive: true }).filter(p => p.endsWith('.js')).sort((a, b) => a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'merge-e2e', port: 8788, host: '127.0.0.1',
  modules: paths.map(p => ({ type: 'ESModule', path: resolve('dist/server', p) })), modulesRoot: 'dist/server',
  compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  durableObjects: { VOICE_DEADLINES: { className: 'VoiceDeadline', useSQLite: true } },
  outboundService: async () => new Response(null, { status: 404 }),
  bindings: { IDENTITY_TRUSTED_HOSTS: 'localhost', AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
  assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true } },
}));
await mf.ready;
const db = await mf.getD1Database('DB');
for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
  for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) if (statement.trim()) await db.exec(statement.replace(/\n/g, ' '));
}

const base = 'http://localhost:8788/';
const browser = await chromium.launch();
const errors = [];
const device = async (name) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block',
    extraHTTPHeaders: { 'oai-authenticated-user-email': 'owner@example.test' } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|404/.test(m.text())) errors.push(`${name}: ${m.text().slice(0, 200)}`); });
  await page.goto(base, { waitUntil: 'networkidle' });
  return { name, context, page, dialogs: [] };
};
const answer = async ({ page }, count) => {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click();
  for (let i = 0; i < count; i++) {
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.press('3');
  }
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /关闭|退出|稍后继续/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
};
const upload = async (d, label) => {
  d.page.once('dialog', async (dialog) => { d.dialogs.push(dialog.message()); await dialog.accept(); });
  await d.page.goto(base, { waitUntil: 'networkidle' });
  await d.page.getByRole('button', { name: /^设置$/ }).first().click();
  await d.page.getByRole('button', { name: /数据与安全/ }).click();
  await d.page.getByRole('button', { name: /备份、恢复与私有同步/ }).click();
  await d.page.getByRole('button', { name: /上传本机备份/ }).click();
  const toast = d.page.locator('.toast span', { hasText: /已合并|学习记录已备份|未完成|失败|无法/ });
  await toast.waitFor({ timeout: 20_000 });
  await d.page.waitForTimeout(1500);
  const text = await toast.textContent();
  await d.page.screenshot({ path: `${shots}/${label}.png` });
  return text;
};
const localEvents = ({ page }) => page.evaluate(() => new Promise((resolveCount, reject) => {
  const open = indexedDB.open('pep-vocab-studio');
  open.onsuccess = () => { const tx = open.result.transaction(['events', 'cards'], 'readonly'); const out = {};
    tx.objectStore('events').getAll().onsuccess = function () { out.events = this.result.length; out.reviews = this.result.filter(e => e.eventType !== 'undo').length; };
    tx.objectStore('cards').getAll().onsuccess = function () { out.cards = this.result.length; };
    tx.oncomplete = () => resolveCount(out); };
  open.onerror = () => reject(open.error);
}));
const cloud = async () => {
  const row = await db.prepare('SELECT revision, payload FROM sync_states').first();
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return { revision: row.revision, events: payload.events.length, cards: payload.cards.length, words: [...new Set(payload.events.map(e => e.cardId))].length };
};

const report = {};
try {
  const a = await device('A');
  await answer(a, 3);
  report.aLocal = await localEvents(a);
  report.aUpload = await upload(a, 'a-first-upload');
  report.cloudAfterA = await cloud();

  const b = await device('B');
  await answer(b, 3);
  report.bLocal = await localEvents(b);
  report.bUpload = await upload(b, 'b-merge-upload');
  report.bDialog = b.dialogs.at(-1);
  report.cloudAfterB = await cloud();
  report.bLocalAfter = await localEvents(b);

  await answer(a, 1);
  report.aUploadAgain = await upload(a, 'a-merge-again');
  report.aDialog = a.dialogs.at(-1);
  report.cloudFinal = await cloud();
  report.aLocalFinal = await localEvents(a);
  await a.page.goto(base, { waitUntil: 'networkidle' });
  await a.page.getByRole('button', { name: /学习记录/ }).first().click();
  await a.page.waitForTimeout(800);
  await a.page.screenshot({ path: `${shots}/a-activity-after-merge.png` });
} finally {
  report.errors = errors;
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
  await mf.dispose();
}
