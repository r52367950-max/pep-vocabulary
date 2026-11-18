// Use the same PLAYWRIGHT_MODULE and CHROMIUM_PATH settings as refactor-browser.mjs.
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const base = process.argv[2] || "http://127.0.0.1:5173";
const errors = [];
const field = page => page.locator(".word-dialog textarea");
const save = page => page.getByRole("button", { name: "保存笔记", exact: true });

async function openFirstWord(page) {
  await page.goto(base);
  await page.getByRole("button", { name: "开始学习", exact: true }).waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => document.activeElement?.id === "lexicon-search");
  await page.locator(".word-open").first().click();
  await field(page).waitFor();
}

try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    locale: "zh-CN",
    viewport: { width: 1200, height: 860 },
  });
  context.setDefaultTimeout(15000);
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const writer = await context.newPage();
  await writer.route(/(lexicon\.tsx|\/lexicon-[\w-]+\.js)/i, async route => {
    await new Promise(resolve => setTimeout(resolve, 650));
    await route.continue();
  });
  await openFirstWord(writer);

  const editor = await context.newPage();
  await openFirstWord(editor);
  await field(editor).fill("另一个标签的草稿");
  await field(writer).fill("已存笔记");
  await save(writer).click();
  await writer.getByRole("button", { name: "已保存", exact: true }).waitFor();
  await save(editor).click();
  await editor.getByText("笔记未保存，文字仍保留在这里。关闭前请先复制保留。").waitFor();
  assert.equal(await field(editor).inputValue(), "另一个标签的草稿");
  await editor.close();

  const reader = await context.newPage();
  await openFirstWord(reader);
  assert.equal(await field(reader).inputValue(), "已存笔记");
  await field(writer).fill("开始练习时保存");
  await writer.getByRole("button", { name: "练习这个词" }).click();
  await writer.getByRole("button", { name: "保存进度并退出" }).waitFor();
  await reader.waitForFunction(() => document.querySelector(".word-dialog textarea").value === "开始练习时保存");
  await reader.keyboard.press("Escape");
  await reader.locator(".word-open").first().click();
  assert.equal(await field(reader).inputValue(), "开始练习时保存");

  await field(reader).fill("系统返回保存");
  await reader.evaluate(() => history.back());
  await reader.locator("dialog[open]").waitFor({ state: "detached" });
  await reader.locator(".word-open").first().click();
  assert.equal(await field(reader).inputValue(), "系统返回保存");
  assert.deepEqual(errors, []);
  console.log("通过：搜索焦点、跨标签草稿冲突、练习前保存、跨页读取、系统返回保存。");
} finally {
  await browser.close();
}
