/**
 * The prototype's local responder. It never pretends to be a model: structured answers come from
 * the article's sentence notes, the product lexicon, the example record and the plan rules; open
 * questions get an explicit "not connected" reply that says what the real request would carry.
 */
import { ARTICLE, lookupWord, sentenceSpans } from "./data";
import { englishTokens } from "./lexicon-match";
import { buildPlan, itemFromWord, sampleStatus, type PlanScope, type PracticeItem } from "./practice";
import { requestLabel, type Route } from "./routing";
import { sentencesInQuote, type Quote } from "./selection";
import { wordsFromText, type Attachment } from "./sources";
import type { Action, Block, PracticeResult, Settings } from "./types";

export type RespondInput = {
  route: Route;
  text: string;
  quotes: Quote[];
  attachments: (Attachment & { content?: string })[];
  includeRecords: boolean;
  article: "full" | "off" | "none";
  settings: Pick<Settings, "dailyMinutes" | "defaultScope">;
  result?: PracticeResult;
  now?: number;
};

let actionCounter = 0;
const actionId = () => `action-${++actionCounter}`;
const CN_NUMBERS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const toNumber = (value: string) => Number.isFinite(Number(value)) ? Number(value) : CN_NUMBERS[value] ?? NaN;

export function parseMinutes(text: string): number | null {
  const match = /(\d{1,3})\s*(分钟|min)/.exec(text);
  if (match) return Math.max(5, Math.min(60, Number(match[1])));
  if (/半小时/.test(text)) return 30;
  if (/一小时|一个小时/.test(text)) return 60;
  return null;
}

export function parseLongPlan(text: string, fallbackMinutes: number) {
  const span = /(\d+|[一二两三四五六七八九十])\s*(天|周|个星期|星期)/.exec(text);
  const days = span ? Math.min(28, Math.max(3, toNumber(span[1]) * (span[2] === "天" ? 1 : 7))) : 14;
  const daily = /每天\s*(\d{1,3})\s*分钟/.exec(text);
  const restWeekdays = [...text.matchAll(/(?:周|星期)([一二三四五六日天])(?:[^，。,.]{0,4})(没空|休息|不学|有课|不行|没时间)/g)]
    .map((match) => "日一二三四五六".indexOf(match[1] === "天" ? "日" : match[1])).filter((index) => index >= 0);
  // Whatever is named first after "先" leads: "先复习错词再学新词" is review first.
  const lead = text.slice(Math.max(0, text.indexOf("先")));
  const newAt = lead.search(/新词|新课/), reviewAt = lead.search(/复习|错词|到期/);
  const order: "review-first" | "new-first" = newAt >= 0 && (reviewAt < 0 || newAt < reviewAt) ? "new-first" : "review-first";
  return { days, minutes: daily ? Math.max(5, Math.min(60, Number(daily[1]))) : fallbackMinutes, restWeekdays: [...new Set(restWeekdays)], order };
}

function fileItems(input: RespondInput): { name: string; items: PracticeItem[] } | null {
  for (const attachment of input.attachments) {
    if (attachment.status !== "read" || !attachment.content) continue;
    const words = wordsFromText(attachment.content);
    if (words.length < 3) continue;
    return {
      name: attachment.name,
      items: words.map((text) => {
        const word = lookupWord(text);
        return word && word.headword.toLowerCase() === text.toLowerCase()
          ? { ...itemFromWord(word), source: `${attachment.name} · 词库释义` }
          : { id: `file:${attachment.id}:${text.toLowerCase()}`, text, hint: "（词库未收录，听音拼写）", source: attachment.name };
      }),
    };
  }
  return null;
}

function scopeFor(input: RespondInput, hasFile: boolean): { scope: PlanScope; note?: string } {
  const text = input.text;
  if (hasFile && /文件|这些词|列表|清单|单词表/.test(text)) return { scope: "file" };
  let scope: PlanScope = /错词|错的/.test(text) ? "mistakes" : /复习|到期/.test(text) ? "due" : /unit\s*4|第四单元|单元/i.test(text) ? "unit4" : input.settings.defaultScope;
  if (scope === "unit4" && hasFile && /听写/.test(text) && !/单元/.test(text)) scope = "file";
  if ((scope === "mistakes" || scope === "due") && !input.includeRecords) {
    return { scope: "unit4", note: "你关闭了「学习记录」来源，所以这次没有按错词或到期词取词，改用必修第一册 Unit 4。" };
  }
  return { scope };
}

function sourcesBlock(input: RespondInput): Block | null {
  const read = input.attachments.filter((item) => item.status === "read" && item.content).map((item) => ({
    name: item.name, chars: item.chars ?? 0, truncated: Boolean(item.truncated),
    excerpt: (item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
  }));
  const attached = input.attachments.filter((item) => item.status === "attached").map((item) => ({ name: item.name, kind: item.kind === "image" ? "图片" : "文档" }));
  if (!read.length && !attached.length && !input.quotes.length) return null;
  return { type: "sources", read, attached, records: input.includeRecords, article: input.article, quotes: input.quotes.length };
}

function practiceFeedback(result: PracticeResult): Block[] {
  const [first, ...retries] = result.rounds;
  const wrong = first.filter((answer) => !answer.score.correct);
  const kinds = new Map<string, number>();
  for (const answer of wrong) kinds.set(answer.score.kind ?? "spelling", (kinds.get(answer.score.kind ?? "spelling") ?? 0) + 1);
  const kindText = [...kinds].map(([kind, count]) => `${count} 个${{ "near-miss": "拼写差一点", spelling: "拼写错误", confusion: "写成了别的词", recall: "没写出来" }[kind] ?? kind}`).join("，");
  const last = retries.at(-1);
  const stillWrong = last ? last.filter((answer) => !answer.score.correct) : wrong;
  const lines = [
    `收到这次听写：第一轮 ${first.length} 词，对 ${first.length - wrong.length} 个${wrong.length ? `；错的 ${wrong.length} 个里，${kindText}` : "，全部正确"}。`,
  ];
  if (retries.length) lines.push(`重练 ${retries.length} 轮后，${stillWrong.length ? `还有 ${stillWrong.map((answer) => answer.item.text).join("、")} 没写对` : "错项都已写对"}。`);
  if (stillWrong.length) lines.push(`下一步：明天开头先听写 ${stillWrong.map((answer) => answer.item.text).join("、")}，写之前先看一眼上面标出的字母位置。`);
  else if (wrong.length) lines.push(`下一步：${wrong.map((answer) => answer.item.text).join("、")} 今天已改对，明天复习时会再出现一次，确认是否记住。`);
  else lines.push("下一步：这组词可以拉长复习间隔，明天换一组新词。");
  const actions: Action[] = stillWrong.length
    ? [{ id: actionId(), label: `现在再练 ${stillWrong.length} 个错项`, intent: "start-dictation", items: stillWrong.map((answer) => answer.item), title: "错项重练" }]
    : [];
  return [{ type: "text", text: lines.join("\n\n") }, ...(actions.length ? [{ type: "actions", actions } as Block] : [])];
}

export function respond(input: RespondInput): Block[] {
  const { route } = input;
  const quote = input.quotes[0];
  // A follow-up word counts when it appears in a sentence the quote touches, not only inside the selection.
  const quoted = quote ? sentencesInQuote(ARTICLE, quote).map((sentence) => sentence.text).join(" ") : "";
  const focus = englishTokens(input.text).find((token) => quoted && new RegExp(`\\b${token}\\b`, "i").test(quoted));
  switch (route.task) {
    case "translate":
    case "define":
    case "grammar": {
      if (!quote) break;
      const touched = sentencesInQuote(ARTICLE, quote);
      const partial = touched.some((sentence) => sentence.partial);
      const lead = route.task === "translate"
        ? partial ? "你选中的是句子的一部分，下面给出所在整句的译文，保留语境。" : "下面是选文的译文。"
        : route.task === "define" ? "按选文里的词查词迹词库；词库没有收录的词会如实标出。"
          : focus ? `结合你问的「${focus}」，先看所在句的结构。` : "下面是选文所在句的结构。";
      return [{ type: "text", text: lead }, { type: "quote-answer", mode: route.task, quote, focus }];
    }
    case "practice-feedback":
      if (input.result) return practiceFeedback(input.result);
      break;
    case "short-plan": {
      const file = fileItems(input);
      const { scope, note } = scopeFor(input, Boolean(file));
      const minutes = parseMinutes(input.text) ?? input.settings.dailyMinutes;
      const spec = { minutes, scope, ...(scope === "file" && file ? { fileName: file.name, fileItems: file.items } : {}) };
      const steps = buildPlan(spec);
      const lines = [`按 ${minutes} 分钟，先用听写找出真正没记住的词，再读一小段，最后只重练写错的词。卡片里的时间和范围可以直接调整。`];
      if (note) lines.push(note);
      if (scope === "file" && file) lines.push(`听写词来自「${file.name}」中读取到的 ${file.items.length} 个英文词。`);
      if (steps[0].items && steps[0].items.length === 0) lines.push("这个范围里暂时没有可用的词，换一个范围试试。");
      return [{ type: "text", text: lines.join("\n\n") }, { type: "plan", spec }];
    }
    case "complex-plan": {
      const plan = parseLongPlan(input.text, input.settings.dailyMinutes);
      const rest = plan.restWeekdays.map((day) => `周${"日一二三四五六"[day]}`).join("、");
      const recordsScope = input.includeRecords ? "mistakes" : "unit4";
      return [
        {
          type: "text",
          text: `这是 ${plan.days} 天的整段安排（草稿）：每天 ${plan.minutes} 分钟${rest ? `，${rest}休息` : ""}，${plan.order === "review-first" ? "前段先复习错词和到期词，再学新词" : "前段先学新词，后段集中复习"}，最后两天自测。\n\n整段安排只定节奏和重点；每天具体练哪些词，会在当天按前一天的练习表现重新挑选。今天的第一步单独列在下面，可以直接开始。`,
        },
        { type: "long-plan", ...plan, startedAt: input.now ?? Date.now() },
        { type: "plan", spec: { minutes: plan.minutes, scope: recordsScope } },
      ];
    }
    case "status": {
      if (!input.includeRecords) {
        return [{ type: "text", text: "你关闭了「学习记录」来源，这次看不到练习表现，所以不判断学习状态。可以在输入框的「来源」里重新打开。" }];
      }
      const status = sampleStatus();
      const actions: Action[] = status.nearMissWords.length
        ? [{ id: actionId(), label: `重练 ${status.nearMissWords.length} 个“差一点”的词`, intent: "start-dictation", items: status.nearMissWords.map(itemFromWord), title: "差一点的词" }]
        : [];
      return [
        { type: "text", text: "按这周的练习表现整理如下。依据是作答对错和错误类型，不按聊天次数打分。注意：这里用的是原型示例记录。" },
        { type: "status" },
        ...(actions.length ? [{ type: "actions", actions } as Block] : []),
      ];
    }
    case "essay-feedback":
      return [
        { type: "notice", tone: "info", text: `作文反馈需要模型完成（正式接入时用 ${requestLabel(route.model, route.effort)}）。演示中不生成批改，避免把示例内容当成对你作文的评价。` },
        ...(sourcesBlock(input) ? [sourcesBlock(input)!] : []),
      ];
    default:
      break;
  }

  // Open questions: say what is known locally and what a real request would carry.
  const blocks: Block[] = [];
  if (quote) {
    blocks.push({ type: "text", text: "按你引用的原文回答。演示模式没有连接模型，先给出可以直接确定的部分：" });
    blocks.push({ type: "quote-answer", mode: "context", quote, focus });
  } else if (/读|阅读|文章/.test(input.text)) {
    blocks.push({ type: "text", text: `可以一起读「${ARTICLE.title}」（${ARTICLE.author}，${ARTICLE.paragraphs.length} 段）。打开后选中任意句子，就能一键翻译、查词义、分析语法，或带着引用继续问。` });
    blocks.push({ type: "actions", actions: [{ id: actionId(), label: `打开 ${ARTICLE.title}`, intent: "open-reading" }] });
    return blocks;
  } else {
    blocks.push({ type: "text", text: "演示模式没有连接模型，这类开放问题不会得到真实回答。下面这些可以在本地完整走通：" });
  }
  const sources = sourcesBlock(input);
  if (sources) blocks.push(sources);
  blocks.push({ type: "notice", tone: "info", text: `正式接入后，这条消息会以 ${requestLabel(route.model, route.effort)} 发送${quote ? "，并附上你的引用" : ""}。` });
  if (!quote) {
    blocks.push({
      type: "actions",
      actions: [
        { id: actionId(), label: "安排 15 分钟练习", intent: "send", text: "我今天只有 15 分钟，帮我安排" },
        { id: actionId(), label: "看看这周学习", intent: "send", text: "看看我这周的学习状态" },
        { id: actionId(), label: `读 ${ARTICLE.title}`, intent: "open-reading" },
      ],
    });
  }
  return blocks;
}

/** Plain-text length of the streamed lead block, used to reveal it progressively. */
export function streamLength(blocks: Block[]) {
  return blocks[0]?.type === "text" ? blocks[0].text.length : 0;
}

export function sentenceIndexLabel(paragraph: number, sentence: number) {
  const spans = sentenceSpans(ARTICLE.paragraphs[paragraph]);
  return spans.length > 1 ? `第 ${paragraph + 1} 段第 ${sentence + 1} 句` : `第 ${paragraph + 1} 段`;
}
