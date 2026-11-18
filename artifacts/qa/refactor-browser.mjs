// Run against a local development or preview server. Supply PLAYWRIGHT_MODULE and
// CHROMIUM_PATH when Playwright / its matching Chromium are installed separately.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const [url = "http://127.0.0.1:5173", out = "outputs/browser"] = process.argv.slice(2);
const profiles = [
  { name: "desktop", width: 1280, height: 900, colorScheme: "light" },
  { name: "mobile", width: 390, height: 844, colorScheme: "light" },
  { name: "tablet", width: 820, height: 1180, colorScheme: "dark" },
  { name: "small", width: 320, height: 640, colorScheme: "dark" },
];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = { browser: browser.version(), profiles: [] };
try {
  for (const profile of profiles) {
    const { name, width, height, colorScheme } = profile;
    const ctx = await browser.newContext({
      viewport: { width, height }, colorScheme, hasTouch: name !== "desktop",
      isMobile: name !== "desktop", reducedMotion: "reduce", locale: "zh-CN",
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const result = { ...profile, checks: [], errors: [], unauthenticated: [] };
    results.profiles.push(result);
    page.on("pageerror", e => result.errors.push(e.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const source = message.location().url;
      // Browsers log the expected anonymous response when opening account settings.
      if (source.startsWith(new URL("/api/", url).href) && /401/.test(message.text())) {
        result.unauthenticated.push(new URL(source).pathname);
      } else result.errors.push(message.text());
    });

    const button = name => page.getByRole("button", { name, exact: true });
    const navigate = async (desktopLabel, mobileLabel = desktopLabel) => {
      const desktop = page.locator(".app-sidebar:visible").getByRole("button", { name: desktopLabel, exact: true });
      const compact = page.locator(".mobile-nav:visible").getByRole("button", { name: mobileLabel, exact: true });
      await desktop.or(compact).click();
    };
    const check = async (label, shot) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, label + " overflows viewport by " + overflow + "px");
      if (shot && ["desktop", "mobile"].includes(name)) {
        await page.screenshot({ path: join(out, name + "-" + shot + ".png"), animations: "disabled" });
      }
      result.checks.push(label);
    };
    const inspector = page.locator(".word-inspector");
    const note = inspector.locator("textarea");
    const openWord = async () => {
      await navigate("词库");
      await page.locator(".scope-switch").getByRole("button", { name: "全部", exact: true }).click();
      await page.getByRole("searchbox", { name: "搜索单词或中文释义" }).fill("apple");
      await page.waitForFunction(() => document.querySelector(".word-row .word-en strong")?.textContent === "apple");
      await page.locator(".word-open").first().click();
      await note.waitFor();
      const panel = await inspector.boundingBox();
      const list = await page.locator(".word-list").boundingBox();
      assert.ok(panel && list);
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width, "inspector fits viewport");
      if (width > 760) {
        assert.ok(list.x + list.width <= panel.x + 1, "wide inspector leaves word list accessible");
      } else {
        const navigation = await page.locator(".mobile-nav").boundingBox();
        assert.ok(navigation && panel.y + panel.height <= navigation.y + 1, "phone inspector leaves navigation accessible");
      }
    };
    try {
      await page.goto(url);
      await button("开始学习").waitFor();
      await check("今日学习", "today");
      await openWord();
      await button("收藏单词").click();
      await button("取消收藏").waitFor();
      await note.fill("apple 笔记");
      await page.keyboard.press("Escape");
      await inspector.waitFor({ state: "detached" });
      await page.reload();
      await openWord();
      assert.equal(await note.inputValue(), "apple 笔记");
      assert.equal(await button("取消收藏").getAttribute("aria-pressed"), "true");
      await check("搜索 / 收藏与笔记跨重载");
      await page.keyboard.press("Escape");
      await navigate("今日学习", "今日");
      await button("开始学习").click();
      await button("暂时想不起来").click();
      await page.locator(".wrong-next").getByRole("button", { name: "继续学习" }).click();
      const reviewed = () => page.locator('[aria-label="本轮进度"][aria-valuenow="1"]').waitFor();
      await reviewed();
      await button("保存进度并退出").click();
      await button("继续学习").waitFor();
      await page.reload();
      await button("继续学习").click();
      await reviewed();
      await check("答题 / 保存与续学", "study");
      await button("保存进度并退出").click();
      await navigate("学习记录", "记录");
      await page.locator(".activity-metrics").waitFor();
      assert.match(await page.locator(".activity-metrics").innerText(), /累计学习词数/);
      await check("学习记录");
      await navigate("阅读");
      await page.locator(".reading-card").first().click();
      const prose = page.locator(".reader-prose");
      await prose.waitFor();
      assert.ok((await prose.innerText()).length > 100);
      await button("查词").click();
      await prose.locator(".reader-inline-word").first().click();
      await inspector.locator(".detail-meaning").waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".reader-back").click();
      await page.locator(".reading-card").first().waitFor();
      await check("阅读 / 文内查词 / 返回");
      await navigate("今日学习", "今日");
      await page.locator(".practice-option").filter({ hasText: "词汇练习" }).click();
      await page.locator(".practice-option").filter({ hasText: "词卡速记" }).click();
      await button("开始翻看").click();
      await button("显示释义").click();
      assert.equal(await button("显示单词").getAttribute("aria-pressed"), "true");
      const first = await page.locator(".learn-card-word").last().innerText();
      await button("认识").click();
      await page.waitForFunction(() => !document.querySelector(".learn-undo")?.disabled);
      await button("撤销上一张").click();
      await page.waitForFunction(() => document.querySelector(".learn-undo")?.disabled);
      assert.equal(await page.locator(".learn-card-word").last().innerText(), first);
      await check("词卡翻面 / 标记 / 撤销");
      await button("退出练习").click();
      await page.locator('button[aria-label="设置"]:visible').click();
      await page.getByRole("dialog", { name: "设置" }).waitFor();
      await check("设置弹窗");
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "detached" });
      assert.deepEqual(result.errors, [], "unexpected browser errors");
    } catch (error) {
      result.failure = error.message.split("\n").slice(0, 5).join(" ");
      await page.screenshot({ path: join(out, name + "-failure.png") });
      process.exitCode = 1;
    } finally {
      console.log(JSON.stringify(result));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(join(out, "browser.json"), JSON.stringify(results, null, 2) + "\n");
}
