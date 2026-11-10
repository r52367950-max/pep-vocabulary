import pw from "playwright";
import { writeFileSync } from "node:fs";
const { chromium } = pw;
const label = process.argv[2] || "before";
const browser = await chromium.launch();
const now = Date.now();
const conversations = Array.from({ length: 50 }, (_, c) => ({ id: `conv-${c}`, title: `第 ${c + 1} 次复习安排和错词分析`, temporary: false, createdAt: now - c * 3_600_000, updatedAt: now - c * 3_600_000,
  messages: Array.from({ length: 30 }, (_, m) => m % 2 === 0
    ? { id: `u-${c}-${m}`, at: now - c * 3_600_000 + m, role: "user", text: `第 ${m} 条：帮我看看 abandon 和 necessary 这两个词为什么总是拼错，再安排十五分钟。` }
    : { id: `a-${c}-${m}`, at: now - c * 3_600_000 + m, role: "assistant", status: "done", blocks: [{ type: "text", text: "先把上周错过两次以上的词过一遍，大约 8 分钟。\n\n- abandon：拼写里的 -don 写成了 -den\n- necessary：一个 c，两个 s\n\n剩下 7 分钟做一轮听写。" }], request: { model: "gpt-6.1-sol", reasoning: { effort: "medium" } } }) }));
const history = JSON.stringify({ version: 1, conversations });
async function run(panelOpen) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  await context.addInitScript((value) => { localStorage.setItem("vocab-companion-history-v1:qa-account-a", value); }, history);
  await context.route("**/api/learning-memory**", (route) => route.fulfill({ json: { accountScope: "qa-account-a", revision: 1, enabled: true, notes: [], recentTopics: [], model: "gpt-6.1-sol", contextVersion: "qa-v1", journalRevision: 0 } }));
  await context.route("**/api/voice/status", (route) => route.fulfill({ json: { configured: false, ready: false, models: {}, activeSession: null } }));
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5174", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.locator(".daily-feature").waitFor({ timeout: 90000 });
  for (const button of await page.getByRole("button", { name: "AI 对话", exact: true }).all()) if (await button.isVisible()) { await button.click(); break; }
  await page.locator(".ciji-companion .greeting").waitFor();
  await page.waitForTimeout(800);
  if (panelOpen) { await page.getByRole("button", { name: "展开对话列表" }).click(); await page.locator(".conv-row").first().waitFor(); }
  const rows = await page.locator(".conv-row").count();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const ta = page.locator(".ciji-companion .composer textarea:visible").last();
  await ta.click();
  const before = await metrics();
  await page.keyboard.type("I have been abandoning the necessary review for two weeks and now the exam is coming so please help me plan fifteen minutes a day until Friday", { delay: 0 });
  await page.waitForTimeout(300);
  const after = await metrics();
  await context.close();
  return { rows, script: (after.ScriptDuration - before.ScriptDuration) * 1000, layout: (after.LayoutDuration - before.LayoutDuration) * 1000, style: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, task: (after.TaskDuration - before.TaskDuration) * 1000 };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = {};
for (const [name, open] of [["closed", false], ["open", true]]) {
  const runs = []; for (let i = 0; i < 5; i++) runs.push(await run(open));
  result[name] = { rows: runs[0].rows, keystrokes: 142, scriptMs: +median(runs.map((r) => r.script)).toFixed(1), layoutMs: +median(runs.map((r) => r.layout)).toFixed(1), styleMs: +median(runs.map((r) => r.style)).toFixed(1), taskMs: +median(runs.map((r) => r.task)).toFixed(1), runs: runs.map((r) => +r.script.toFixed(1)) };
}
console.log(JSON.stringify(result, null, 1));
writeFileSync(`perf-${label}.json`, JSON.stringify(result, null, 1));
await browser.close();
