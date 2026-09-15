import type { LexiconDetail, LexiconIndexEntry } from "./lexicon";
import type { SkillName } from "./storage";

export type QuestionType =
  | "meaning-recall"
  | "spelling"
  | "listening-choice"
  | "dictation"
  | "context-choice"
  | "word-form"
  | "collocation-gap"
  | "family-conversion"
  | "confusable"
  | "phrase-dictation"
  | "natural-expression"
  | "textbook-context"
  | "sentence-output"
  | "paragraph-retell";

export const QUESTION_CATALOG: Array<{ id: QuestionType; label: string; short: string; skill: SkillName; objective: boolean }> = [
  { id: "meaning-recall", label: "英文 → 中文主动回忆", short: "识义", skill: "meaning", objective: false },
  { id: "spelling", label: "中文 → 英文输入", short: "拼写", skill: "spelling", objective: true },
  { id: "listening-choice", label: "听音选择", short: "听辨", skill: "listening", objective: true },
  { id: "dictation", label: "听写", short: "听写", skill: "listening", objective: true },
  { id: "context-choice", label: "语境义选择", short: "语境", skill: "context", objective: true },
  { id: "word-form", label: "词形填空", short: "词形", skill: "spelling", objective: true },
  { id: "collocation-gap", label: "搭配与介词填空", short: "搭配", skill: "collocation", objective: true },
  { id: "family-conversion", label: "词族转换", short: "词族", skill: "collocation", objective: true },
  { id: "confusable", label: "易混词辨析", short: "辨析", skill: "context", objective: true },
  { id: "phrase-dictation", label: "短语听写", short: "短语", skill: "listening", objective: true },
  { id: "natural-expression", label: "最自然表达选择", short: "表达", skill: "output", objective: true },
  { id: "textbook-context", label: "教材短语境回忆", short: "教材", skill: "context", objective: false },
  { id: "sentence-output", label: "自主造句与用法检查", short: "造句", skill: "output", objective: false },
  { id: "paragraph-retell", label: "短段阅读与复述", short: "复述", skill: "output", objective: false },
];

export type Question = {
  type: QuestionType;
  label: string;
  skill: SkillName;
  objective: boolean;
  prompt: string;
  support: string | null;
  answer: string;
  choices: string[];
  inputMode: "reveal" | "text" | "choice" | "textarea";
  audio: boolean;
};

export const normalizeAnswer = (value: string) => value.toLowerCase().normalize("NFKC")
  .replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/\s+/g, " ").trim();

function choicesFor(entry: LexiconIndexEntry, pool: LexiconIndexEntry[], field: "headword" | "chineseCore") {
  const correct = normalizeAnswer(entry[field]);
  const seen = new Set([correct]);
  const closest: Array<{ value: string; distance: number }> = [];
  for (const candidate of pool) {
    if (candidate.id === entry.id || !candidate[field] || !candidate.scopes.some((scope) => entry.scopes.includes(scope))) continue;
    const distance = Math.abs(candidate.headword.length - entry.headword.length);
    if (closest.length === 3 && distance >= closest[2].distance) continue;
    const normalized = normalizeAnswer(candidate[field]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    closest.push({ value: candidate[field], distance });
    closest.sort((a, b) => a.distance - b.distance);
    if (closest.length > 3) closest.pop();
  }
  return [...closest.map((item) => item.value), entry[field]].sort((a, b) => a.localeCompare(b));
}

export function buildQuestion(entry: LexiconIndexEntry, detail: LexiconDetail | undefined, requested: QuestionType, pool: LexiconIndexEntry[]): Question {
  const catalog = QUESTION_CATALOG.find((item) => item.id === requested) || QUESTION_CATALOG[0];
  const base = { type: requested, label: catalog.label, skill: catalog.skill, objective: catalog.objective, answer: entry.headword, choices: [] as string[], audio: false };
  const example = detail?.openExample || detail?.englishCore || null;
  switch (requested) {
    case "meaning-recall":
      return { ...base, prompt: entry.headword, support: entry.britishIpa ? `BrE /${entry.britishIpa}/` : null, answer: entry.chineseCore, inputMode: "reveal" };
    case "spelling":
      return { ...base, prompt: entry.chineseCore, support: entry.partsOfSpeech.join(" · ") || "请输入完整拼写", inputMode: "text" };
    case "listening-choice":
      return { ...base, prompt: "听系统语音，选择核心义", support: "系统语音，不是教材或真人录音", answer: entry.chineseCore, choices: choicesFor(entry, pool, "chineseCore"), inputMode: "choice", audio: true };
    case "dictation":
      return { ...base, prompt: "听音后输入单词", support: "可重播；大小写不计", inputMode: "text", audio: true };
    case "context-choice": {
      const sentence = example ? example.replace(new RegExp(`\\b${entry.headword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "____") : `____: ${detail?.englishCore || "根据核心义选择词语"}`;
      return { ...base, prompt: sentence, support: example ? "开放词典语境" : "开放英文简义", choices: choicesFor(entry, pool, "headword"), inputMode: "choice" };
    }
    case "word-form":
      return { ...base, prompt: `写出“${entry.chineseCore}”对应的教材词形`, support: detail?.variants?.length ? `变体：${detail.variants.join(" / ")}` : "注意词性与拼写", inputMode: "text" };
    case "collocation-gap": {
      const tokens = entry.headword.split(/\s+/);
      const answer = tokens.length > 1 ? tokens.at(-1)! : entry.headword;
      const prompt = tokens.length > 1 ? `${tokens.slice(0, -1).join(" ")} ____` : `完成与“${entry.chineseCore}”对应的教材表达`;
      return { ...base, prompt, support: tokens.length > 1 ? "填入缺失搭配词" : "本词暂无已审核短语，回退为词头输入", answer, inputMode: "text" };
    }
    case "family-conversion":
      return { ...base, prompt: `${entry.chineseCore}：写出当前词族中的目标形式`, support: detail?.relations.family.length ? `已连接 ${detail.relations.family.length} 个词族节点` : "未用模型补写派生词；本题核对教材词头", inputMode: "text" };
    case "confusable":
      return { ...base, prompt: `选择与“${entry.chineseCore}”匹配的词`, support: "干扰项来自同范围、近长度词头", choices: choicesFor(entry, pool, "headword"), inputMode: "choice" };
    case "phrase-dictation":
      return { ...base, prompt: entry.headword.includes(" ") ? "听写完整短语" : "当前词条不是短语；听写完整词头", support: "系统语音", inputMode: "text", audio: true };
    case "natural-expression":
      return { ...base, prompt: `哪一项最直接表达“${entry.chineseCore}”？`, support: "选项来自同一教材范围", choices: choicesFor(entry, pool, "headword"), inputMode: "choice" };
    case "textbook-context":
      return { ...base, prompt: entry.headword, support: entry.sources[0] ? `${entry.sources[0].volume} · ${entry.sources[0].unit}${entry.sources[0].printedPage ? ` · p.${entry.sources[0].printedPage}` : ""}` : "课程标准", answer: entry.chineseCore, inputMode: "reveal" };
    case "sentence-output":
      return { ...base, prompt: `用 ${entry.headword} 写一个自然、完整的句子`, support: "本地检查：是否含目标词、是否成句；AI 关闭时仍可完成", inputMode: "textarea" };
    case "paragraph-retell":
      return { ...base, prompt: example || `${entry.headword}: ${detail?.englishCore || entry.chineseCore}`, support: "读完后用英文复述要点；先自行判断，再翻卡", inputMode: "textarea" };
  }
}

export function gradeQuestion(question: Question, response: string) {
  if (!question.objective) return null;
  const answer = normalizeAnswer(response);
  return Boolean(answer) && answer === normalizeAnswer(question.answer);
}

export function localSentenceCheck(sentence: string, headword: string) {
  const normalized = normalizeAnswer(sentence);
  const target = normalizeAnswer(headword);
  const hasTarget = Boolean(target) && ` ${normalized} `.includes(` ${target} `);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return {
    hasTarget,
    completeEnough: wordCount >= 5,
    message: !hasTarget ? "句子里还没有目标词或短语。" : wordCount < 5 ? "已经用到目标词；再补足主语、谓语或语境。" : "已通过本地结构检查；搭配与风格仍请以词条用法为准。",
  };
}
