import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:5173/');
  const xml = await page.evaluate(async () => {
    const { docxText } = await import('/lib/reading-import.ts');
    const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const wrap = body => `<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`;
    const ordinary = wrap('<w:p><w:r><w:t>Hello &amp; welcome.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t><![CDATA[Table <text>.]]></w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    const normal = docxText(ordinary);
    const strict = docxText(ordinary.replace(ns, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replaceAll('w:', 's:').replace('xmlns:w', 'xmlns:s'));
    const nested = wrap('<w:p><w:r><w:t>Outside.</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>Inside.</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>');
    const textbox = docxText(nested);
    const textNodes = docxText(wrap('<w:p><w:t>First <w:t>inner</w:t> last.</w:t></w:p>'));
    const body = 'word '.repeat(2000);
    const hostile = wrap('<w:p>'.repeat(80) + `<w:r><w:t>${body}</w:t></w:r>` + '</w:p>'.repeat(80));
    const oldDoc = new DOMParser().parseFromString(hostile, 'application/xml');
    const oldText = [...oldDoc.getElementsByTagNameNS('*', 'p')].map(p => [...p.getElementsByTagNameNS('*', 't')].map(t => t.textContent ?? '').join('')).filter(Boolean).join('\n\n');
    const started = performance.now(), bounded = docxText(hostile), durationMs = performance.now() - started;
    const rejected = [];
    for (const [label, value] of [
      ['depth', wrap('<w:p>'.repeat(150) + '<w:t>text</w:t>' + '</w:p>'.repeat(150))],
      ['output', wrap('<w:p><w:t>' + 'x'.repeat(120001) + '</w:t></w:p>')],
      ['paragraphs', wrap('<w:p/>'.repeat(2001))],
      ['markup', wrap('<w:r/>'.repeat(80001))],
      ['malformed', wrap('<w:p>')],
    ]) {
      try { docxText(value); throw new Error(`accepted ${label}`); }
      catch (error) { if (error.message.startsWith('accepted ')) throw error; rejected.push(label); }
    }
    return { normal, strict, textbox, textNodes, originalCharacters: body.length, oldCharacters: oldText.length, fixedCharacters: bounded.length, durationMs, rejected };
  });
  assert.equal(xml.normal, 'Hello & welcome.\n\nTable <text>.');
  assert.equal(xml.strict, xml.normal);
  assert.equal(xml.textbox, 'Outside.\n\nInside.');
  assert.equal(xml.textNodes, 'First inner last.');
  assert.ok(xml.oldCharacters >= xml.originalCharacters * 80);
  assert.equal(xml.fixedCharacters, xml.originalCharacters);
  assert.deepEqual(xml.rejected, ['depth', 'output', 'paragraphs', 'markup', 'malformed']);
  results.push({ test: 'DOCX ordinary/strict/table/textbox/CDATA/entities plus hostile paragraphs/text/quotas', ...xml });

  await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
  const seed = async target => target.evaluate(async () => {
    const personal = await import('/lib/personal-readings.ts');
    const original = await fetch('/readings/v1/articles/a-place-to-begin.json').then(response => response.json());
    const article = { ...original, id: 'personal-security-browser', title: 'Private clear regression', form: 'imported', sourceUrl: '', rights: { label: '个人导入', basis: '本人导入的阅读材料。', url: '' } };
    await personal.savePersonalArticle(article);
  });
  await seed(page);
  const second = await context.newPage();
  second.on('pageerror', error => errors.push(error.message));
  await second.goto('http://127.0.0.1:5173/');
  await second.getByRole('button', { name: '开始学习', exact: true }).waitFor();
  const nav = (target, name) => target.locator('.app-sidebar').getByRole('button', { name, exact: true }).click();
  const openPrivate = async target => {
    await nav(target, '阅读');
    await target.getByRole('button', { name: /^我的文章/ }).click();
    await target.getByRole('button', { name: /Private clear regression/ }).click();
    await target.locator('.reader-prose').waitFor();
    assert.equal(await target.getByRole('heading', { name: 'Private clear regression', exact: true }).isVisible(), true);
  };
  await openPrivate(page);
  await openPrivate(second);
  await nav(second, '今日学习');
  await page.evaluate(async () => { await (await import('/lib/personal-readings.ts')).clearPersonalReadings(); });
  await page.locator('.reader-view').waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('heading', { name: 'Private clear regression', exact: true }).count(), 0);
  await page.getByRole('button', { name: /^我的文章/ }).click();
  await page.getByRole('heading', { name: '保存你想读的文章' }).waitFor();
  await nav(second, '阅读');
  await second.getByRole('button', { name: /^我的文章/ }).click();
  await second.getByRole('heading', { name: '保存你想读的文章' }).waitFor();
  assert.equal(await second.getByRole('heading', { name: 'Private clear regression', exact: true }).count(), 0);
  results.push({ test: 'Personal article clear removes open body/export/list locally and in retained hidden second tab', status: 'passed' });

  await seed(page);
  await page.reload();
  await page.getByRole('button', { name: '开始学习', exact: true }).waitFor();
  await openPrivate(page);
  await nav(page, '今日学习');
  const settings = page.getByRole('button', { name: '打开设置', exact: true });
  if (await settings.count()) await settings.click();
  else await page.getByRole('button', { name: '设置', exact: true }).first().click();
  await page.getByRole('button', { name: '数据与安全', exact: true }).click();
  const clear = page.getByRole('button', { name: /清空本机/ });
  page.once('dialog', dialog => dialog.accept());
  await clear.click();
  await page.getByText('本机学习数据已清空。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await nav(page, '阅读');
  await page.getByRole('button', { name: /^我的文章/ }).click();
  await page.getByRole('heading', { name: '保存你想读的文章' }).waitFor();
  results.push({ test: 'Real confirmed clear-local-data flow removes a previously mounted private reader', status: 'passed' });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: new URL('./reading-clear-browser.png', import.meta.url), fullPage: true });
  const report = { status: 'passed', browser: await browser.version(), results, errors };
  await fs.writeFile(new URL('./reading-security-browser.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
