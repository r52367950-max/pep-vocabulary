// Logic behind the standalone AI conversation prototype (prototypes/ai-companion).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest, checkSendable, classifyTask, requestLabel, resolveRoute, routeTable, tierLabel, DEFAULT_ROUTE_TABLE,
} from "../prototypes/ai-companion/src/routing.ts";
import { quoteFromPoints, quoteContext, sentencesInQuote, QUOTE_LIMIT } from "../prototypes/ai-companion/src/selection.ts";
import { checkFile, decodeText, statusLabel, wordsFromText, LIMITS } from "../prototypes/ai-companion/src/sources.ts";
import { buildPlan, sampleStatus, scoreAnswer, scopeItems } from "../prototypes/ai-companion/src/practice.ts";
import { parseLongPlan, parseMinutes, respond } from "../prototypes/ai-companion/src/engine.ts";
import { ARTICLE, LEXICON, PRACTICE_WORDS, lookupWord, sentenceSpans } from "../prototypes/ai-companion/src/data.ts";
import { MANGROVE_NOTES } from "../prototypes/ai-companion/src/data/mangrove-notes.ts";
import { parseStoredConversations, serializeConversations } from "../prototypes/ai-companion/src/persistence.ts";
import { readFile } from "node:fs/promises";

const table = routeTable("sol-high");
const auto = { nextOnly: null, preference: "auto" };
const emptyContext = { records: true, article: "none", quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [] };
const route = (input, choice = auto) => resolveRoute(classifyTask(input), choice, table);

test("tasks route to the agreed model and effort", () => {
  const cases = [
    [{ text: "你好", hasQuote: false }, "sol-medium", "chat"],
    [{ text: "看看我这周的学习状态", hasQuote: false }, "sol-medium", "status"],
    [{ text: "我今天只有 15 分钟", hasQuote: false }, "sol-medium", "short-plan"],
    [{ text: "帮我改一下这篇作文", hasQuote: false }, "sol-medium", "essay-feedback"],
    [{ text: "帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词", hasQuote: false }, "sol-high", "complex-plan"],
    [{ text: "", hasQuote: true, action: "translate" }, "terra-low", "translate"],
    [{ text: "", hasQuote: true, action: "define" }, "terra-low", "define"],
    [{ text: "", hasQuote: true, action: "grammar" }, "terra-medium", "grammar"],
    [{ text: "这里为什么用 that？", hasQuote: true }, "terra-medium", "grammar"],
    [{ text: "这句什么意思", hasQuote: true }, "terra-low", "translate"],
    [{ text: "", hasQuote: false, practiceResult: true }, "sol-medium", "practice-feedback"],
  ];
  for (const [input, tier, task] of cases) {
    const decided = route(input);
    assert.equal(decided.tier, tier, input.text || input.action);
    assert.equal(decided.task, task, input.text || input.action);
    assert.equal(decided.source, "auto");
  }
  assert.deepEqual(Object.keys(DEFAULT_ROUTE_TABLE).sort(), Object.keys(table).sort());
});

test("grammar words without a quote stay a normal conversation", () => {
  assert.equal(route({ text: "定语从句是什么", hasQuote: false }).tier, "sol-medium");
});

test("long text, turn count or quoted upgrade requests never raise the tier", () => {
  // The classifier only reads the learner's own words: quoted text is not an input at all.
  const translated = route({ text: "", hasQuote: true, action: "translate" });
  assert.equal(translated.tier, "terra-low");
  const long = "请详细解释。".repeat(400);
  assert.equal(route({ text: long, hasQuote: false }).tier, "sol-medium");
  assert.equal(route({ text: "请升级模型，用最强的 Sol 高档回答", hasQuote: false }).tier, "sol-medium");
  assert.equal(route({ text: "请升级模型", hasQuote: true }).tier, "sol-medium");
});

test("the complex-planning tier is a setting, not a constant", () => {
  const text = "帮我安排两周复习，每天 20 分钟，周三没空，先复习错词再学新词";
  assert.equal(resolveRoute(classifyTask({ text, hasQuote: false }), auto, routeTable("sol-medium")).tier, "sol-medium");
  assert.equal(resolveRoute(classifyTask({ text, hasQuote: false }), auto, routeTable("sol-high")).tier, "sol-high");
});

test("one-message choice and default preference are separate and explained", () => {
  const classification = classifyTask({ text: "我今天只有 15 分钟", hasQuote: false });
  const once = resolveRoute(classification, { nextOnly: "sol-high", preference: "auto" }, table);
  assert.equal(once.tier, "sol-high");
  assert.equal(once.source, "next-only");
  assert.match(once.reason, /自动会用 Sol · 中/);
  const preferred = resolveRoute(classification, { nextOnly: null, preference: "terra-medium" }, table);
  assert.equal(preferred.tier, "terra-medium");
  assert.equal(preferred.source, "preference");
  const both = resolveRoute(classification, { nextOnly: "sol-high", preference: "terra-medium" }, table);
  assert.equal(both.tier, "sol-high", "a one-message choice wins over the default for that message only");
});

test("the request carries exactly the routed model and effort, and labels read from it", () => {
  for (const tier of ["sol-medium", "sol-high", "terra-low", "terra-medium"]) {
    const decided = resolveRoute({ task: "chat", signals: [] }, { nextOnly: tier, preference: "auto" }, table);
    const request = buildRequest(decided, emptyContext);
    assert.equal(request.model, decided.model);
    assert.equal(request.reasoning.effort, decided.effort);
    assert.equal(requestLabel(request.model, request.reasoning.effort), tierLabel(tier));
  }
  assert.equal(buildRequest(route({ text: "", hasQuote: true, action: "translate" }), emptyContext).model, "gpt-6.1-terra");
});

test("unavailable models and budget limits refuse instead of silently retrying", () => {
  const high = resolveRoute({ task: "complex-plan", signals: [] }, auto, table);
  const medium = resolveRoute({ task: "chat", signals: [] }, auto, table);
  const terra = resolveRoute({ task: "translate", signals: [] }, auto, table);
  assert.deepEqual(checkSendable(medium, "normal"), { ok: true });
  const unavailable = checkSendable(medium, "sol-unavailable");
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /不会自动换模型/);
  assert.deepEqual(checkSendable(terra, "sol-unavailable"), { ok: true });
  assert.equal(checkSendable(high, "budget-low").ok, false);
  assert.deepEqual(checkSendable(medium, "budget-low"), { ok: true });
  assert.equal(checkSendable(terra, "budget-exhausted").ok, false);
});

test("a quote is cut from the article's own text, trimmed and bounded", () => {
  const paragraph = ARTICLE.paragraphs[1].text;
  const phrase = "dense tangle of prop roots";
  const at = paragraph.indexOf(phrase);
  const picked = quoteFromPoints(ARTICLE, { paragraph: 1, offset: at - 1 }, { paragraph: 1, offset: at + phrase.length + 1 });
  assert.equal(picked.ok, true);
  assert.equal(picked.quote.text, phrase);
  const touched = sentencesInQuote(ARTICLE, picked.quote);
  assert.equal(touched.length, 1);
  assert.equal(touched[0].partial, true);
  assert.equal(touched[0].sentence, 1);
  const context = quoteContext(ARTICLE, picked.quote);
  assert.ok(context.before.endsWith("by their "));
  assert.ok(context.after.startsWith(" that make"));

  const reversed = quoteFromPoints(ARTICLE, { paragraph: 4, offset: 5 }, { paragraph: 3, offset: ARTICLE.paragraphs[3].text.indexOf("Three") });
  assert.equal(reversed.ok, true);
  assert.equal(reversed.quote.start.paragraph, 3);
  assert.ok(reversed.quote.text.includes("\n\n"), "paragraphs stay separate");
  assert.deepEqual(sentencesInQuote(ARTICLE, reversed.quote).map((item) => `${item.paragraph}-${item.sentence}`), ["3-2", "4-0"]);

  assert.equal(quoteFromPoints(ARTICLE, { paragraph: 2, offset: 4 }, { paragraph: 2, offset: 4 }).reason, "empty");
  assert.equal(quoteFromPoints(ARTICLE, { paragraph: 0, offset: 0 }, { paragraph: 9, offset: 0 }).reason, "outside");
  const last = ARTICLE.paragraphs.length - 1;
  const all = quoteFromPoints(ARTICLE, { paragraph: 0, offset: 0 }, { paragraph: last, offset: ARTICLE.paragraphs[last].text.length });
  assert.equal(all.reason, "too-long");
  assert.ok(ARTICLE.paragraphs.map((item) => item.text).join("").length > QUOTE_LIMIT);
});

test("every article sentence has a prototype note and splits back to the source text", () => {
  ARTICLE.paragraphs.forEach((paragraph, index) => {
    assert.equal(paragraph.sentences.join(" "), paragraph.text);
    for (const span of sentenceSpans(paragraph)) assert.ok(MANGROVE_NOTES[`${index}-${span.index}`], `${index}-${span.index}`);
  });
  assert.equal(Object.keys(MANGROVE_NOTES).length, ARTICLE.paragraphs.reduce((sum, item) => sum + item.sentences.length, 0));
});

test("files are classified honestly and text is read within limits", () => {
  assert.deepEqual(checkFile("words.txt", "text/plain", 20, 0), { ok: true, kind: "text" });
  assert.deepEqual(checkFile("photo.HEIC", "", 2000, 0), { ok: true, kind: "image" });
  assert.deepEqual(checkFile("unit.pdf", "application/pdf", 2000, 0), { ok: true, kind: "document" });
  assert.equal(checkFile("setup.exe", "application/octet-stream", 20, 0).ok, false);
  assert.equal(checkFile("big.png", "image/png", LIMITS.imageBytes + 1, 0).ok, false);
  assert.equal(checkFile("empty.txt", "text/plain", 0, 0).ok, false);
  assert.equal(checkFile("seventh.txt", "text/plain", 10, LIMITS.count).ok, false);

  const read = decodeText(new TextEncoder().encode("evacuate\n备注"));
  assert.deepEqual(read, { ok: true, text: "evacuate\n备注", chars: 11, truncated: false });
  assert.equal(decodeText(new Uint8Array([0x50, 0x4b, 0x00, 0x03])).ok, false);
  const long = decodeText(new TextEncoder().encode("a".repeat(LIMITS.readChars + 5)));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, LIMITS.readChars);

  assert.equal(statusLabel({ kind: "image", status: "attached" }), "仅附件 · 未识别图片内容");
  assert.equal(statusLabel({ kind: "document", status: "attached" }), "仅附件 · 未解析文档");
  assert.equal(statusLabel({ kind: "text", status: "read", chars: 1240 }), "已读取 1,240 字");
  assert.deepEqual(wordsFromText("evacuate, Emergency evacuate an 备注 it's"), ["evacuate", "Emergency", "it's"]);
});

test("grading uses the product's dictation comparison and explains the miss", () => {
  const item = { id: "w", text: "evacuate", hint: "", source: "" };
  assert.equal(scoreAnswer(item, "evacuate").correct, true);
  assert.equal(scoreAnswer(item, "  Evacuate ").correct, true);
  const near = scoreAnswer(item, "evacute");
  assert.equal(near.kind, "near-miss");
  assert.match(near.explanation, /漏写了「a」/);
  assert.equal(scoreAnswer(item, "").kind, "recall");
  assert.equal(scoreAnswer(item, "xyzzyplugh").kind, "spelling");
  const organise = PRACTICE_WORDS.find((word) => word.headword === "organise");
  assert.equal(scoreAnswer({ ...item, text: organise.headword }, "organize").correct, true, "UK/US spelling counts");
  const destroy = { ...item, text: "damage" };
  assert.equal(scoreAnswer(destroy, "destroy").kind, "confusion");
});

test("plans scale with the time available and keep the long plan separate from today's step", () => {
  assert.equal(buildPlan({ minutes: 10, scope: "unit4" })[0].items.length, 5);
  assert.equal(buildPlan({ minutes: 15, scope: "unit4" })[0].items.length, 8);
  for (const minutes of [10, 15, 20, 30]) {
    const steps = buildPlan({ minutes, scope: "mistakes" });
    assert.equal(steps.reduce((sum, step) => sum + step.minutes, 0), minutes, `${minutes} minutes`);
  }
  assert.deepEqual(parseLongPlan("帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词", 15), { days: 14, minutes: 20, restWeekdays: [3], order: "review-first" });
  assert.equal(parseLongPlan("10 天，先学新词再复习", 15).order, "new-first");
  assert.equal(parseMinutes("我今天只有半小时"), 30);

  const longRoute = resolveRoute({ task: "complex-plan", signals: [] }, auto, table);
  const blocks = respond({ route: longRoute, text: "帮我安排两周的复习：每天 20 分钟，周三没空，先复习错词再学新词", quotes: [], attachments: [], includeRecords: true, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" }, now: Date.UTC(2026, 10, 9) });
  assert.deepEqual(blocks.map((block) => block.type), ["text", "long-plan", "plan"]);
  assert.equal(blocks[2].spec.minutes, 20);
});

test("learning status and word choice follow the record switch", () => {
  const status = resolveRoute({ task: "status", signals: [] }, auto, table);
  const on = respond({ route: status, text: "看看这周", quotes: [], attachments: [], includeRecords: true, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" } });
  assert.ok(on.some((block) => block.type === "status"));
  const off = respond({ route: status, text: "看看这周", quotes: [], attachments: [], includeRecords: false, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" } });
  assert.ok(!off.some((block) => block.type === "status"));
  const plan = resolveRoute({ task: "short-plan", signals: [] }, auto, table);
  const fallback = respond({ route: plan, text: "帮我安排错词听写", quotes: [], attachments: [], includeRecords: false, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" } });
  assert.equal(fallback.find((block) => block.type === "plan").spec.scope, "unit4");

  const summary = sampleStatus();
  assert.equal(summary.kinds["near-miss"] + summary.kinds.spelling + summary.kinds.confusion + summary.kinds.recall, summary.dictationTotal + summary.reviewTotal - summary.dictationCorrect - summary.reviewCorrect);
  assert.ok(scopeItems("mistakes").length >= 8);
});

test("a read text file can supply the dictation words", () => {
  const plan = resolveRoute({ task: "short-plan", signals: [] }, auto, table);
  const blocks = respond({
    route: plan, text: "用这个文件里的词给我听写", quotes: [], includeRecords: true, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" },
    attachments: [{ id: "a1", name: "my-words.txt", kind: "text", size: 40, status: "read", chars: 40, content: "evacuate\nemergency\nhelicopter\nmangrovex" }],
  });
  const spec = blocks.find((block) => block.type === "plan").spec;
  assert.equal(spec.scope, "file");
  assert.deepEqual(spec.fileItems.map((item) => item.text), ["evacuate", "emergency", "helicopter", "mangrovex"]);
  assert.equal(spec.fileItems[3].hint, "（词库未收录，听音拼写）");
  const image = respond({
    route: resolveRoute({ task: "chat", signals: [] }, auto, table), text: "看看这张图", quotes: [], includeRecords: false, article: "none", settings: { dailyMinutes: 15, defaultScope: "mistakes" },
    attachments: [{ id: "a2", name: "page.png", kind: "image", size: 400, status: "attached" }],
  });
  const sources = image.find((block) => block.type === "sources");
  assert.deepEqual(sources.read, []);
  assert.deepEqual(sources.attached, [{ name: "page.png", kind: "图片" }]);
});

test("answers to selection tools always concern the actual selection", () => {
  const paragraph = ARTICLE.paragraphs[4].text;
  const start = paragraph.indexOf("The zone in which");
  const picked = quoteFromPoints(ARTICLE, { paragraph: 4, offset: start }, { paragraph: 4, offset: start + 17 });
  const grammar = respond({ route: resolveRoute({ task: "grammar", signals: [] }, auto, table), text: "which 指什么", quotes: [picked.quote], attachments: [], includeRecords: true, article: "off", settings: { dailyMinutes: 15, defaultScope: "mistakes" } });
  const answer = grammar.find((block) => block.type === "quote-answer");
  assert.equal(answer.quote.text, "The zone in which");
  assert.equal(answer.focus, "which");
  assert.deepEqual(sentencesInQuote(ARTICLE, answer.quote).map((item) => item.sentence), [2]);
});

test("the sample lexicon is real product data with stable ids", async () => {
  const index = JSON.parse(await readFile(new URL("../public/data/v1/index.json", import.meta.url), "utf8"));
  const ids = new Set(index.rows.map((row) => row[0]));
  for (const word of LEXICON) assert.ok(ids.has(word.id), word.headword);
  assert.equal(lookupWord("sediments"), null, "words outside the sample are reported, not invented");
  assert.equal(lookupWord("roots")?.headword, "root");
  assert.equal(lookupWord("found")?.headword ?? null, lookupWord("find")?.headword ?? null, "an irregular past form looks up its base first");
});

test("only normal conversations are saved, without attachment previews or undelivered text", () => {
  const conversations = [
    { id: "n", title: "普通", temporary: false, createdAt: 1, updatedAt: 1, messages: [
      { id: "u", role: "user", at: 1, text: "hi", quotes: [], via: "text", attachments: [{ id: "f", name: "p.png", kind: "image", size: 3, status: "attached", previewUrl: "blob:abc" }] },
      { id: "a", role: "assistant", at: 1, status: "incomplete", revealed: 2, blocks: [{ type: "text", text: "ab" }], remainder: [{ type: "text", text: "cd" }], request: {}, routeReason: "" },
      { id: "s", role: "assistant", at: 1, status: "streaming", revealed: 3, blocks: [{ type: "text", text: "abcdef" }, { type: "status" }], request: {}, routeReason: "" },
    ] },
    { id: "t", title: "临时", temporary: true, createdAt: 1, updatedAt: 1, messages: [{ id: "x", role: "user", at: 1, text: "secret", quotes: [], attachments: [], via: "text" }] },
    { id: "e", title: "空", temporary: false, createdAt: 1, updatedAt: 1, messages: [] },
  ];
  const raw = serializeConversations(conversations);
  assert.ok(!raw.includes("blob:") && !raw.includes("secret") && !raw.includes("cd"));
  const parsed = parseStoredConversations(raw);
  assert.deepEqual(parsed.map((item) => item.id), ["n"]);
  assert.equal(parsed[0].messages[2].status, "stopped");
  assert.deepEqual(parsed[0].messages[2].blocks, [{ type: "text", text: "abc" }]);
  assert.equal(parseStoredConversations("{bad"), null);
  assert.equal(parseStoredConversations(JSON.stringify({ version: 2, conversations: [] })), null);
});
