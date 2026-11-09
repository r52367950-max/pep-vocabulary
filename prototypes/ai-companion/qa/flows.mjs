// Browser walk-through of the prototype's user paths, at desktop, iPad and phone sizes.
// Usage (after `npx vite build --config prototypes/ai-companion/vite.config.ts` and
// `npx vite preview --config prototypes/ai-companion/vite.config.ts`):
//   node prototypes/ai-companion/qa/flows.mjs [baseUrl] [screenshotDir] [deviceScaleFactor]
// Every check is something a learner can see or do; failures exit non-zero.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";

const { chromium } = createRequire(import.meta.url)("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5179/";
const shots = process.argv[3] ?? new URL("./shots/", import.meta.url).pathname;
const scale = Number(process.argv[4] ?? 1);
mkdirSync(shots, { recursive: true });
const sample = JSON.parse(readFileSync(new URL("../src/data/sample.json", import.meta.url), "utf8"));
const notes = readFileSync(new URL("../src/data/mangrove-notes.ts", import.meta.url), "utf8");
const zhOf = (key) => new RegExp(`"${key}": \\{\\n\\s+zh: "([^"]+)"`).exec(notes)[1];

const results = [];
let current = "";
function check(name, ok, detail = "") {
  results.push({ viewport: current, name, ok: Boolean(ok), detail });
  if (!ok) console.log(`  ✗ [${current}] ${name} ${detail}`);
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "ipad-landscape", width: 1180, height: 760, touch: true },
  { name: "ipad-portrait", width: 820, height: 1100, touch: true },
  { name: "phone", width: 390, height: 844, touch: true, mobile: true },
];

async function fresh(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: scale, hasTouch: Boolean(viewport.touch), isMobile: Boolean(viewport.mobile), locale: "zh-CN" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${base}#chat`);
  await page.waitForSelector(".greeting");
  return { context, page, errors };
}

const composer = (page, scope = "") => page.locator(`${scope} .composer textarea`).last();
const lastReply = (page, scope = "") => page.locator(`${scope} .message-assistant`).last();
async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.ai-turn[aria-busy="true"]'), null, { timeout: 8000 });
}
async function send(page, text, scope = "") {
  const box = composer(page, scope);
  await box.fill(text);
  await box.press("Enter");
  await page.waitForTimeout(60);
  await waitIdle(page);
}
async function openPanel(page) {
  if (!(await page.locator(".conv-panel:not([hidden])").count())) await page.locator(".chat-top [aria-label='展开对话列表']").click();
  await page.waitForSelector(".conv-panel:not([hidden])");
}
async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
async function selectArticle(page, startPara, startOffset, endPara, endOffset) {
  await page.evaluate(([sp, so, ep, eo]) => {
    const node = (index) => document.querySelector(`[data-para="${index}"]`).firstChild;
    document.querySelector(`[data-para="${sp}"]`).scrollIntoView({ block: "center" });
    const range = document.createRange();
    range.setStart(node(sp), so);
    range.setEnd(node(ep), eo);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, [startPara, startOffset, endPara, endOffset]);
  await page.waitForTimeout(220);
  await page.waitForSelector(".select-toolbar", { timeout: 3000 });
}
async function openSettings(page, viewport) {
  if (!viewport.mobile) await page.locator(".side-nav .nav-item[title='设置']").click();
  else if (await page.locator(".mobile-head").count()) await page.locator(".mobile-head [aria-label='设置']").click();
  else { await openPanel(page); await page.locator(".panel-link", { hasText: "设置" }).click(); }
  await page.waitForSelector("dialog.settings[open]");
}
async function settingsSection(page, label) {
  await page.locator(".settings-nav button", { hasText: label }).click();
}
async function closeSettings(page) {
  await page.locator("dialog.settings [aria-label='关闭设置']").click();
  await page.waitForFunction(() => !document.querySelector("dialog.settings[open]"));
}
async function leaveChat(page, viewport) {
  // From the full conversation back to a learning page.
  await page.locator(".chat-top [aria-label='收起为小窗，回到学习页']").click();
  await page.waitForSelector(".mini-panel");
  if (viewport.mobile) await page.locator(".mini-panel [aria-label='收起小窗']").click();
}
const SHORT = { 今日学习: "今日", 学习记录: "记录", "AI 对话": "AI" };
async function goView(page, viewport, label) {
  if (viewport.mobile) await page.locator(".tab-bar button", { hasText: SHORT[label] ?? label }).click();
  else await page.locator(".side-nav .nav-item", { hasText: label }).click();
}

async function pathConversation(page, viewport) {
  // 1. Empty home → first message → continuing → new / temporary → back through history.
  check("空态居中问候", await page.locator(".greeting").innerText() === "今天想学什么？");
  check("全站导航没有新对话或学习助手", viewport.mobile || (await page.locator(".side-nav").innerText()).match(/新对话|学习助手/) === null);
  if (viewport.mobile) {
    const tabs = await page.locator(".tab-bar button").allInnerTexts();
    check("手机底部五个入口，AI 居中", tabs.length === 5 && tabs[2].trim() === "AI", tabs.join("|"));
    check("对话页保留底部入口并标出 AI", (await page.locator(".tab-bar [aria-current=page]").innerText()).trim() === "AI");
  } else {
    const items = await page.locator(".side-nav nav .nav-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
    check("侧栏 AI 对话位于词库与阅读之间", items.join("|") === "今日学习|词库|AI 对话|阅读|学习记录", items.join("|"));
    check("对话页高亮 AI 对话", (await page.locator(".side-nav .nav-item[aria-current=page]").getAttribute("title")) === "AI 对话");
  }
  check("新对话与临时对话在右上角", await page.evaluate(() => {
    const top = document.querySelector(".chat-top").getBoundingClientRect();
    const fresh = document.querySelector(".chat-top [aria-label='新对话']").getBoundingClientRect();
    const temp = document.querySelector(".chat-top .temp-toggle").getBoundingClientRect();
    const list = document.querySelector(".chat-top [aria-label='展开对话列表']").getBoundingClientRect();
    return fresh.left > top.left + top.width / 2 && temp.left > top.left + top.width / 2 && list.right < top.left + top.width / 2;
  }));
  check("空输入框显示语音键", await page.locator(".composer-hero .send-button.is-voice").count() === 1 && await page.locator(".composer-hero [aria-label='发送']").count() === 0);
  await composer(page).fill("x");
  check("有文字时同一位置变为发送", await page.locator(".composer-hero [aria-label='发送']").count() === 1 && await page.locator(".composer-hero .is-voice").count() === 0);
  await composer(page).fill("");
  const heroBox = await page.locator(".composer-hero").boundingBox();
  if (!viewport.mobile) check("输入框位于视觉中部", heroBox && heroBox.y > viewport.height * 0.25 && heroBox.y + heroBox.height < viewport.height * 0.75, JSON.stringify(heroBox));
  else check("手机输入框贴近底部", heroBox && heroBox.y + heroBox.height > viewport.height * 0.8, JSON.stringify(heroBox));
  await page.screenshot({ path: `${shots}/${viewport.name}-01-empty.png` });
  await send(page, "我今天只有 15 分钟");
  check("首条消息进入会话布局", await page.locator(".chat-dock .composer").count() === 1 && await page.locator(".hero").count() === 0);
  check("计划卡出现", await page.locator(".plan-card").count() === 1);
  check("短计划路由 Sol · 中", (await lastReply(page).locator(".meta-model").innerText()) === "Sol · 中");
  await send(page, "看看我这周的学习状态");
  check("连续对话：状态卡来自示例记录", await lastReply(page).locator(".status-card .sample-tag").count() === 1);
  const title = await page.locator(".title-text").innerText();
  await page.screenshot({ path: `${shots}/${viewport.name}-02-thread.png` });

  await page.locator(".chat-top [aria-label='新对话']").click();
  check("新对话回到空态", await page.locator(".greeting").count() === 1);
  check("空白新对话不再显示可用的新对话按钮", await page.locator(".chat-top [aria-label='新对话']").isDisabled());
  await page.locator(".temp-toggle").click();
  check("临时对话标识", (await page.locator(".greeting").innerText()) === "临时对话" && await page.locator(".temp-toggle.is-on").count() === 1);
  await send(page, "临时问一句：怎么记 evacuate？");
  await openPanel(page);
  await page.waitForSelector(".conv-panel:not([hidden])");
  const listText = await page.locator(".conv-groups").innerText();
  check("临时对话不进入历史", !listText.includes("临时问一句"));
  check("历史里有刚才的对话", listText.includes(title.slice(0, 8)));
  await page.screenshot({ path: `${shots}/${viewport.name}-03-history.png` });
  await page.locator(".conv-row", { hasText: title.slice(0, 8) }).click();
  check("离开有内容的临时对话先确认", await page.locator(".confirm-layer").count() === 1);
  await page.locator(".confirm-layer button", { hasText: "清除并离开" }).click();
  check("回到历史对话", (await page.locator(".title-text").innerText()) === title);
  await openPanel(page);
  check("临时对话已清除", !(await page.locator(".conv-panel").innerText()).includes("临时对话"));
  await page.locator(".conv-row", { hasText: "这周的复习安排" }).click();
  check("示例历史可打开", (await page.locator(".title-text").innerText()) === "这周的复习安排");
  check("出现回到刚才的对话", await page.locator(".return-chip").count() === 1);
  await page.locator(".return-chip").click();
  check("返回当前会话", (await page.locator(".title-text").innerText()) === title);
  check("会话页无横向溢出", await overflow(page) <= 0);
}

async function pathReading(page, viewport) {
  // 2. Select text → translate / grammar → follow up → expand → remove quote.
  const before = await page.locator(".title-text").innerText();
  await leaveChat(page, viewport);
  await goView(page, viewport, "AI 对话");
  await page.waitForSelector(".chat-dock");
  check("导航里的 AI 对话回到同一会话", (await page.locator(".title-text").innerText()) === before);
  await leaveChat(page, viewport);
  await goView(page, viewport, "阅读");
  await page.waitForSelector(".reading-body");
  const p1 = sample.article.paragraphs[1].text;
  const phrase = "dense tangle of prop roots";
  const at = p1.indexOf(phrase);
  await selectArticle(page, 1, at, 1, at + phrase.length);
  await page.screenshot({ path: `${shots}/${viewport.name}-04-selection.png` });
  await page.locator(".select-toolbar button", { hasText: "翻译" }).click();
  await page.waitForSelector(".mini-panel");
  await waitIdle(page);
  const reply = lastReply(page, ".mini-panel");
  check("翻译路由 Terra · 低", (await reply.locator(".meta-model").innerText()) === "Terra · 低");
  check("译文对应选区所在句", (await reply.locator(".zh").first().innerText()) === zhOf("1-1"));
  check("标明选区是句子的一部分", (await reply.innerText()).includes("选区是这句的一部分"));
  check("高亮的正是选中的原文", (await reply.locator("mark").first().innerText()) === phrase);
  check("继续追问引用留在输入框", (await page.locator(".mini-panel .quote-chip").innerText()).includes("继续追问"));
  await send(page, "这里为什么用 that？", ".mini-panel");
  const grammar = lastReply(page, ".mini-panel");
  check("追问语法路由 Terra · 中", (await grammar.locator(".meta-model").innerText()) === "Terra · 中");
  check("追问回答聚焦 that", (await grammar.locator(".grammar-points li.is-focus").first().innerText()).includes("that"));
  await page.screenshot({ path: `${shots}/${viewport.name}-05-mini-answer.png` });

  const inMini = await page.locator(".mini-panel .message").count();
  await page.locator(".mini-panel [aria-label='展开为完整对话']").click();
  await page.waitForSelector(".chat-dock");
  check("展开后同一会话", await page.locator(".chat .message").count() === inMini);
  check("展开后引用仍在", await page.locator(".chat-dock .quote-chip").count() === 1);
  await page.locator(".chat-dock [aria-label='移除这段引用']").click();
  check("引用可以移除", await page.locator(".chat-dock .quote-chip").count() === 0);
  await send(page, "这段讲了什么");
  check("移除引用后不再按引用回答", await lastReply(page).locator(".answer-card").count() === 0);

  // Cross-paragraph grammar, outside / too long / keyboard.
  await leaveChat(page, viewport);
  const p3 = sample.article.paragraphs[3].text, p4 = sample.article.paragraphs[4].text;
  await selectArticle(page, 3, p3.indexOf("Three dominant"), 4, p4.indexOf("."));
  await page.locator(".select-toolbar button", { hasText: "分析语法" }).click();
  await page.waitForSelector(".mini-panel");
  await waitIdle(page);
  const cross = lastReply(page, ".mini-panel");
  check("跨段选区覆盖两段", (await cross.locator(".sentence-label").allInnerTexts()).join("|").match(/第 4 段.*第 5 段/) !== null);
  check("跨段语法路由 Terra · 中", (await cross.locator(".meta-model").innerText()) === "Terra · 中");
  if (viewport.mobile) await page.locator(".mini-panel [aria-label='收起小窗']").click();

  await page.evaluate(() => {
    const title = document.querySelector(".reading-title").firstChild;
    const range = document.createRange();
    range.setStart(title, 2);
    range.setEnd(document.querySelector('[data-para="0"]').firstChild, 20);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForSelector(".select-toolbar.is-error");
  check("选区跨出正文给出提示", (await page.locator(".select-toolbar").innerText()).includes("正文以外"));
  const last = sample.article.paragraphs.length - 1;
  await selectArticle(page, 0, 0, last, sample.article.paragraphs[last].text.length);
  check("超长选区给出提示", (await page.locator(".select-toolbar").innerText()).includes("超过 800"));
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForTimeout(200);
  check("空选区不显示工具", await page.locator(".select-toolbar").count() === 0);
  if (!viewport.touch) {
    await page.locator(".para-row").nth(2).focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".select-toolbar");
    check("键盘选中整段后焦点进入工具栏", await page.evaluate(() => document.activeElement?.closest(".select-toolbar") !== null));
    await page.keyboard.press("Escape");
    check("Esc 关闭工具栏并回到段落", await page.locator(".select-toolbar").count() === 0 && await page.evaluate(() => document.activeElement?.classList.contains("para-row")));
    // Word lookup from a real double click.
    await page.locator('[data-para="2"]').dblclick({ position: { x: 30, y: 12 } });
    await page.waitForSelector(".select-toolbar");
    await page.locator(".select-toolbar button", { hasText: "解释词义" }).click();
    await waitIdle(page);
    check("双击取词后释义来自词库", (await lastReply(page, ".mini-panel").innerText()).includes("词迹词库"));
  }

  // Whole-article source switched off: the learner's own quote still goes, the article does not.
  if (!(await page.locator(".mini-panel").count())) await page.locator(".launcher").click();
  await page.locator(".mini-panel [aria-label^='来源']").click();
  const articleSwitch = page.locator(".popover .switch-row", { hasText: "当前文章全文" }).locator("input");
  await articleSwitch.uncheck({ force: true });
  check("整篇文章来源可关闭", !(await articleSwitch.isChecked()));
  await page.keyboard.press("Escape");
  await page.locator(".mini-panel .chip-remove").evaluateAll((buttons) => buttons.forEach((button) => button.click()));
  if (viewport.mobile) await page.locator(".mini-panel [aria-label='收起小窗']").click();
  await selectArticle(page, 0, 0, 0, sample.article.paragraphs[0].sentences[0].length);
  await page.locator(".select-toolbar button", { hasText: "问问 AI" }).click();
  check("问问 AI 预填可编辑问题", (await composer(page, ".mini-panel").inputValue()) === "这段在说什么？");
  check("问问 AI 后光标在输入框", await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"));
  await composer(page, ".mini-panel").press("Enter");
  await waitIdle(page);
  await lastReply(page, ".mini-panel").locator(".meta-route").click();
  const detail = await lastReply(page, ".mini-panel").locator(".request-detail").innerText();
  check("关闭整篇后只发送引用", detail.includes("文章全文：已关闭") && detail.includes("引用 1 段"), detail);
  await page.screenshot({ path: `${shots}/${viewport.name}-06-article-off.png` });
  if (viewport.mobile) await page.locator(".mini-panel [aria-label='收起小窗']").click();
  check("阅读页无横向溢出", await overflow(page) <= 0);
}

async function pathSources(page, viewport) {
  // 3. Files and images: status, preview, removal, draft across views, isolation.
  await goView(page, viewport, "今日学习");
  if (!(await page.locator(".mini-panel").count())) await page.locator(".launcher").click();
  await page.locator(".mini-panel [aria-label='新对话']").click().catch(() => undefined);
  const input = page.locator(".mini-panel input[type=file]");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await input.setInputFiles([
    { name: "my-words.txt", mimeType: "text/plain", buffer: Buffer.from("evacuate\nemergency\nhelicopter\nlandslide\n备注：只在本机读取\n") },
    { name: "notes.png", mimeType: "image/png", buffer: png },
    { name: "unit4.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%fake\n") },
  ]);
  await page.waitForFunction(() => [...document.querySelectorAll(".mini-panel .file-chip")].some((chip) => chip.textContent.includes("已读取")));
  const chips = await page.locator(".mini-panel .file-chip").allInnerTexts();
  check("文本文件显示已读取", chips.some((text) => text.includes("已读取") && text.includes("my-words.txt")));
  check("图片标为仅附件", chips.some((text) => text.includes("未识别图片内容") && text.includes("notes.png")));
  check("PDF 标为未解析", chips.some((text) => text.includes("未解析文档") && text.includes("unit4.pdf")));
  await input.setInputFiles([{ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }]);
  check("不支持的类型给出提示", (await page.locator(".mini-panel .composer-notice").innerText()).includes("暂不支持"));
  await page.locator(".mini-panel .file-chip", { hasText: "my-words.txt" }).locator(".chip-main").click();
  check("预览显示已读取的文字", (await page.locator("dialog.modal[open] .preview-text").innerText()).includes("evacuate"));
  await page.keyboard.press("Escape");
  await page.locator(".mini-panel [aria-label='移除附件 unit4.pdf']").click();
  check("附件可以移除", await page.locator(".mini-panel .file-chip").count() === 2);
  await composer(page, ".mini-panel").fill("用这个文件里的词给我听写");
  await page.screenshot({ path: `${shots}/${viewport.name}-07-attachments.png` });
  await page.locator(".mini-panel [aria-label='展开为完整对话']").click();
  check("展开后草稿保留", (await composer(page, ".chat").inputValue()) === "用这个文件里的词给我听写" && await page.locator(".chat .file-chip").count() === 2);
  await page.locator(".chat-top [aria-label='收起为小窗，回到学习页']").click();
  check("收起后草稿保留", (await composer(page, ".mini-panel").inputValue()) === "用这个文件里的词给我听写");
  if (viewport.mobile) await page.locator(".mini-panel [aria-label='收起小窗']").click();
  await openSettings(page, viewport);
  await closeSettings(page);
  if (!(await page.locator(".mini-panel").count())) await page.locator(".launcher").click();
  check("打开设置不丢草稿", (await composer(page, ".mini-panel").inputValue()) === "用这个文件里的词给我听写");
  await composer(page, ".mini-panel").press("Enter");
  await waitIdle(page);
  check("文件里的词进入计划", (await lastReply(page, ".mini-panel").innerText()).includes("my-words.txt"));
  const stored = await page.evaluate(() => localStorage.getItem("ciji-ai-prototype:v1") ?? "");
  check("存储里没有文件原文", !stored.includes("备注：只在本机读取") && !stored.includes("blob:") && !stored.includes("data:image"));
  check("存储里有附件名与状态", stored.includes("my-words.txt"));

  // Temporary conversation: its own empty draft; its attachment does not leak back.
  await page.locator(".mini-panel [aria-label='展开为完整对话']").click();
  await page.locator(".temp-toggle").click();
  check("临时对话草稿独立", (await composer(page, ".chat").inputValue()) === "" && await page.locator(".chat .file-chip").count() === 0);
  await page.locator(".chat input[type=file]").setInputFiles([{ name: "temp-only.txt", mimeType: "text/plain", buffer: Buffer.from("temporary words only") }]);
  await page.waitForSelector(".chat .file-chip");
  await page.locator(".temp-toggle").click();
  check("离开临时对话后附件不带入普通对话", await page.locator(".chat .file-chip").count() === 0);
  const after = await page.evaluate(() => localStorage.getItem("ciji-ai-prototype:v1") ?? "");
  check("临时附件没有写入存储", !after.includes("temp-only.txt"));
}

async function pathPractice(page, viewport) {
  // 4. Plan → practice → grade → retry only the wrong items → back to the same conversation.
  await send(page, "我今天只有 15 分钟，帮我安排听写和复习");
  const card = page.locator(".plan-card").last();
  await card.locator("[role=radio]", { hasText: "10" }).click();
  check("可用时间可调整", (await card.locator(".plan-head h3").innerText()).startsWith("10 分钟"));
  const words = (await card.locator(".step-words").first().innerText()).split(" · ");
  check("10 分钟对应 5 个词", words.length === 5, words.join(","));
  const conversationTitle = await page.locator(".title-text").innerText();
  await card.locator("button", { hasText: "开始听写" }).click();
  await page.waitForSelector(".dictation-card");
  const typed = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const answer = index === 0 ? word.slice(0, -1) : index === 1 ? "" : word;
    typed.push(answer);
    await page.locator("#dictation-answer").fill(answer);
    await page.locator("#dictation-answer").press("Enter");
    await page.waitForSelector(".feedback");
    if (index === 0) {
      check("判分：差一点", (await page.locator(".feedback-title").innerText()).includes("拼写差一点"));
      check("解释具体错在哪里", (await page.locator(".feedback").innerText()).includes("漏写了"));
      await page.screenshot({ path: `${shots}/${viewport.name}-08-dictation.png` });
    }
    await page.locator(".feedback button").click();
  }
  await page.waitForSelector(".review-list");
  check("第一轮成绩", (await page.locator(".page-head h1").innerText()).includes("3 / 5"));
  await page.locator("button", { hasText: "只重练 2 个错项" }).click();
  check("只重练错项", (await page.locator(".page-sub").innerText()).includes("1 / 2"));
  for (const word of words.slice(0, 2)) {
    await page.locator("#dictation-answer").fill(word);
    await page.locator("#dictation-answer").press("Enter");
    await page.waitForSelector(".feedback");
    await page.locator(".feedback button").click();
  }
  check("重练全部写对", (await page.locator(".page-head h1").innerText()).includes("2 / 2"));
  await page.screenshot({ path: `${shots}/${viewport.name}-09-result.png` });
  await page.locator("button", { hasText: "把结果带回" }).click();
  await page.waitForSelector(".chat .result-card");
  await waitIdle(page);
  check("回到同一会话", (await page.locator(".title-text").innerText()) === conversationTitle);
  const feedback = await lastReply(page).innerText();
  check("反馈依据真实作答", feedback.includes("对 3 个") && feedback.includes("错项都已写对"), feedback.slice(0, 120));
  check("反馈路由 Sol · 中", (await lastReply(page).locator(".meta-model").innerText()) === "Sol · 中");
  await page.screenshot({ path: `${shots}/${viewport.name}-10-feedback.png` });
}

async function pathRouting(page, viewport) {
  // 5. Automatic → one-message model → refusal keeps it → default model → back to automatic.
  const box = composer(page, ".chat-dock");
  const chip = page.locator(".chat-dock .route-button");
  const chipText = async () => (await chip.innerText()).replace(/\s+/g, "");
  await box.fill("帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词");
  check("自动模式只显示「自动」", await chipText() === "自动");
  await chip.click();
  check("菜单里解释自动的判断", (await page.locator(".route-menu .route-reason").innerText()).includes("Sol · 高"));
  check("模型菜单不提供思考强度选项", (await page.locator(".route-menu .route-option").allInnerTexts()).every((text) => !/[低中高]$|· [低中高]/.test(text.split("\n")[0])));
  await page.locator(".route-menu .route-option", { hasText: "Terra" }).click();
  check("仅下一条显示所选模型", await chipText() === "Terra仅下一条");
  const draft = await box.inputValue();
  await box.fill("");
  await box.press("Enter");
  check("空消息不消耗单次选择", (await chip.innerText()).includes("仅下一条"));
  await chip.click();
  await page.locator(".route-menu .route-option", { hasText: "Sol" }).click();
  await openSettings(page, viewport);
  await settingsSection(page, "模型");
  await page.locator("#service-state").selectOption("sol-unavailable");
  await closeSettings(page);
  await box.fill(draft);
  await box.press("Enter");
  check("模型不可用时拒绝发送并说明", (await page.locator(".chat-dock .composer-notice").innerText()).includes("不会自动换模型"));
  check("被拒绝的发送不消耗单次选择", (await chip.innerText()).includes("仅下一条") && (await box.inputValue()) === draft);
  await page.locator(".chat-dock .composer-notice button", { hasText: "只把这条改用 Terra 发送" }).click();
  await waitIdle(page);
  check("选择的备选只用于这一条", (await lastReply(page).locator(".meta-model").innerText()) === "Terra · 高");
  check("说明自动原本的选择", (await lastReply(page).locator(".meta-reason").innerText()).includes("自动会用 Sol · 高"));
  check("单次选择用后恢复自动", await chipText() === "自动");
  await openSettings(page, viewport);
  await settingsSection(page, "模型");
  await page.locator("#service-state").selectOption("normal");
  await closeSettings(page);
  await box.fill(draft);
  await box.press("Enter");
  await waitIdle(page);
  check("自动模式按任务给出模型与思考强度", (await lastReply(page).locator(".meta-model").innerText()) === "Sol · 高");
  check("长期计划分清整段与今天第一步", await lastReply(page).locator(".long-plan").count() === 1 && await lastReply(page).locator(".plan-card.is-first-step").count() === 1);
  await lastReply(page).locator(".meta-route").click();
  check("请求里的 model 与 effort 与标签一致", (await lastReply(page).locator(".request-detail").innerText()).match(/model: gpt-6\.1-sol[\s\S]*reasoning\.effort: high/) !== null);
  await page.screenshot({ path: `${shots}/${viewport.name}-11-long-plan.png` });
  await lastReply(page).locator("button", { hasText: "加入学习安排" }).click();
  check("加入安排前需要确认", (await lastReply(page).locator(".schedule-row").innerText()).includes("确认加入"));
  await lastReply(page).locator("button", { hasText: "确认加入" }).click();

  await chip.click();
  await page.locator(".route-menu [role=radio]", { hasText: "后续默认" }).click();
  await page.locator(".route-menu .route-option", { hasText: "Terra" }).click();
  check("后续默认只显示模型名", await chipText() === "Terra");
  await send(page, "看看我这周的学习状态");
  check("默认模型用于下一条，思考强度按任务", (await lastReply(page).locator(".meta-model").innerText()) === "Terra · 中");
  check("后续默认不会被一次发送清除", await chipText() === "Terra");
  await openSettings(page, viewport);
  await settingsSection(page, "模型");
  check("设置里显示同一默认模型", await page.locator(".settings-routes [aria-checked=true]").innerText().then((text) => text.startsWith("Terra")));
  await page.locator(".settings-routes .route-option", { hasText: "自动（推荐）" }).click();
  await closeSettings(page);
  check("在设置中恢复自动", await chipText() === "自动");
}

async function pathSettings(page, viewport) {
  // 6. Site-wide settings change real behaviour.
  await openSettings(page, viewport);
  if (viewport.mobile) check("手机设置先显示分区列表", await page.locator(".settings-nav").isVisible() && !(await page.locator(".settings-content").isVisible()));
  await settingsSection(page, "对话");
  await page.locator(".segmented[aria-label='发送方式'] [role=radio]", { hasText: "⌘/Ctrl+Enter" }).click();
  await settingsSection(page, "学习安排").catch(async () => { await page.locator(".settings-back").click(); await settingsSection(page, "学习安排"); });
  await page.locator("#daily-minutes").fill("25");
  await page.locator("#confirm-schedule").uncheck({ force: true });
  if (viewport.mobile) await page.locator(".settings-back").click();
  await settingsSection(page, "常规");
  await page.locator(".segmented[aria-label='外观'] [role=radio]", { hasText: "深色" }).click();
  await page.locator(".segmented[aria-label='动态效果'] [role=radio]", { hasText: "减少" }).click();
  check("深色外观生效", await page.evaluate(() => document.documentElement.dataset.theme === "dark"));
  check("减少动效生效", await page.evaluate(() => document.documentElement.dataset.motion === "reduce"));
  await page.screenshot({ path: `${shots}/${viewport.name}-12-settings-dark.png` });
  await closeSettings(page);
  await page.locator(".chat-top [aria-label='新对话']").click();
  const box = composer(page, ".chat");
  await box.fill("帮我安排今天");
  await box.press("Enter");
  check("Enter 在 ⌘/Ctrl+Enter 模式下换行", (await box.inputValue()).includes("\n"));
  await box.fill("帮我安排今天");
  await box.press("Control+Enter");
  await waitIdle(page);
  check("⌘/Ctrl+Enter 发送", await page.locator(".chat .message-user").count() === 1);
  check("每天可用时间用于计划", (await page.locator(".plan-card .plan-head h3").innerText()).startsWith("25 分钟"));
  await send(page, "帮我安排两周复习，每天 20 分钟，周三没空，先复习错词再学新词").catch(() => undefined);
  await box.fill("帮我安排两周复习，每天 20 分钟，周三没空，先复习错词再学新词");
  await box.press("Control+Enter");
  await waitIdle(page);
  await lastReply(page).locator("button", { hasText: "加入学习安排" }).click();
  check("关闭确认后直接加入", (await lastReply(page).locator(".schedule-row").innerText()).includes("已加入"));
  check("深色下无横向溢出", await overflow(page) <= 0);
}

async function pathVoice(page, viewport) {
  await page.locator(".chat-dock [aria-label^='语音会话']").click();
  await page.waitForSelector("dialog.voice-modal[open]");
  check("语音入口说明未接通麦克风", (await page.locator(".voice-banner").innerText()).includes("不会使用麦克风"));
  await page.locator(".voice .suggestions button", { hasText: "我今天只有 15 分钟" }).click();
  await page.waitForSelector(".caption-ai");
  check("字幕显示双方", await page.locator(".voice .caption").count() === 2);
  await page.locator(".voice-controls button", { hasText: "结束" }).click();
  await page.waitForFunction(() => !document.querySelector("dialog.voice-modal[open]"));
  await page.waitForSelector(".chat .voice-card");
  check("语音回到同一对话", await page.locator(".chat .voice-card").count() === 1 && await lastReply(page).locator(".plan-card").count() === 1);
  await page.screenshot({ path: `${shots}/${viewport.name}-13-voice-back.png` });
}

async function pathTargets(page, viewport) {
  if (!viewport.touch) return;
  const small = await page.evaluate(() => [...document.querySelectorAll(".chat-top button, .composer-bar button, .launcher")]
    .filter((element) => element.offsetParent).map((element) => element.getBoundingClientRect()).filter((rect) => rect.width < 40 || rect.height < 40).length);
  check("触控主要按钮不小于 40px", small === 0, `${small} small`);
}

const browser = await chromium.launch();
for (const viewport of VIEWPORTS) {
  current = viewport.name;
  console.log(`— ${viewport.name}`);
  const { context, page, errors } = await fresh(browser, viewport);
  for (const path of [pathConversation, pathReading, pathSources, pathPractice, pathRouting, pathVoice, pathTargets, pathSettings]) {
    try { await path(page, viewport); }
    catch (error) { check(`${path.name} 运行完成`, false, String(error).split("\n")[0]); await page.screenshot({ path: `${shots}/${viewport.name}-error-${path.name}.png` }); }
  }
  check("没有页面错误", errors.length === 0, errors.join(" | "));
  await context.close();
}
await browser.close();
const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
