import type { LexiconDetail, LexiconIndexEntry } from "./lexicon";
import { findOriginalExample } from "./reading";
import type { SkillName } from "./storage";

export type QuestionType =
  | "meaning-recall"
  | "spelling"
  | "listening-choice"
  | "dictation"
  | "context-choice"
  | "context-gap"
  | "word-form"
  | "collocation-gap"
  | "family-conversion"
  | "confusable"
  | "phrase-dictation"
  | "natural-expression"
  | "textbook-context"
  | "sentence-output"
  | "paragraph-retell";

export const QUESTION_CATALOG: Array<{
  id: QuestionType;
  label: string;
  short: string;
  skill: SkillName;
  objective: boolean;
}> = [
  {
    id: "meaning-recall",
    label: "看英文回忆词义",
    short: "识义",
    skill: "meaning",
    objective: false,
  },
  {
    id: "spelling",
    label: "看中文拼写",
    short: "拼写",
    skill: "spelling",
    objective: true,
  },
  {
    id: "listening-choice",
    label: "听音选义",
    short: "听辨",
    skill: "listening",
    objective: true,
  },
  {
    id: "dictation",
    label: "单词听写",
    short: "听写",
    skill: "listening",
    objective: true,
  },
  {
    id: "context-choice",
    label: "语境选词",
    short: "语境",
    skill: "context",
    objective: true,
  },
  {
    id: "context-gap",
    label: "语境填空",
    short: "填空",
    skill: "context",
    objective: true,
  },
  {
    id: "word-form",
    label: "词形变化",
    short: "词形",
    skill: "spelling",
    objective: true,
  },
  {
    id: "collocation-gap",
    label: "短语搭配填空",
    short: "搭配",
    skill: "collocation",
    objective: true,
  },
  {
    id: "family-conversion",
    label: "词族转换",
    short: "词族",
    skill: "collocation",
    objective: true,
  },
  {
    id: "confusable",
    label: "易混词辨析",
    short: "辨析",
    skill: "context",
    objective: true,
  },
  {
    id: "phrase-dictation",
    label: "短语听写",
    short: "短语",
    skill: "listening",
    objective: true,
  },
  {
    id: "natural-expression",
    label: "自然表达选择",
    short: "表达",
    skill: "output",
    objective: true,
  },
  {
    id: "textbook-context",
    label: "教材语境回忆",
    short: "教材",
    skill: "context",
    objective: false,
  },
  {
    id: "sentence-output",
    label: "用目标词造句",
    short: "造句",
    skill: "output",
    objective: false,
  },
  {
    id: "paragraph-retell",
    label: "短文复述",
    short: "复述",
    skill: "output",
    objective: false,
  },
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
  /** Show only after the learner explicitly requests a hint. */
  hint?: string;
  /** These fields explain a real change of exercise, including its skill. */
  requestedType?: QuestionType;
  fallbackReason?: string;
  exampleSource?: string;
};

function normalizeTypography(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Accept case, width, smart apostrophes and redundant whitespace. Punctuation
// remains significant: "ice!cream" must not become a correct "ice cream".
export const normalizeAnswer = (value: string) =>
  normalizeTypography(value).toLowerCase();

function targetPattern(target: string, global = false) {
  const escaped = normalizeTypography(target)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/ /g, "\\s+");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}'-])(${escaped})(?=$|[^\\p{L}\\p{N}'-])`,
    global ? "giu" : "iu",
  );
}

/** Remove every complete occurrence so a second appearance cannot reveal the answer. */
export function blankTarget(sentence: string, headword: string): string | null {
  if (!normalizeAnswer(headword)) return null;
  const normalized = normalizeTypography(sentence);
  if (!targetPattern(headword).test(normalized)) return null;
  return normalized.replace(
    targetPattern(headword, true),
    (_match, before: string) => `${before}____`,
  );
}

export type EntryExample = { en: string; zh?: string; source: string };
export function getEntryExample(
  entry: LexiconIndexEntry,
  detail?: LexiconDetail,
): EntryExample | undefined {
  const original = findOriginalExample(entry.headword);
  if (original)
    return { en: original.en, zh: original.zh, source: original.source };
  // A dictionary definition is not a sentence context. Only an actual example
  // containing this exact word/phrase can become a cloze exercise.
  const example = detail?.openExample?.trim();
  if (
    !example ||
    example.length > 500 ||
    (example.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length || 0) < 4 ||
    !blankTarget(example, entry.headword)
  )
    return undefined;
  return { en: example, source: "开放词典例句" };
}

function choicesFor(
  entry: LexiconIndexEntry,
  pool: readonly LexiconIndexEntry[],
) {
  const correct = normalizeAnswer(entry.chineseCore);
  const headword = normalizeAnswer(entry.headword);
  const seen = new Set([correct]);
  const closest: Array<{ value: string; distance: number }> = [];
  for (const candidate of pool) {
    if (
      candidate.id === entry.id ||
      !candidate.chineseCore ||
      !candidate.scopes.some((scope) => entry.scopes.includes(scope))
    )
      continue;
    // Reject distant candidates before doing Unicode normalization. Only the
    // nearest three can enter the result, even for a several-thousand-word pool.
    const distance = Math.abs(
      candidate.headword.length - entry.headword.length,
    );
    if (closest.length === 3 && distance >= closest[2].distance) continue;
    const normalized = normalizeAnswer(candidate.chineseCore);
    if (!normalized || seen.has(normalized)) continue;
    if (normalizeAnswer(candidate.headword) === headword) continue;
    seen.add(normalized);
    closest.push({ value: candidate.chineseCore, distance });
    closest.sort((a, b) => a.distance - b.distance);
    if (closest.length > 3) closest.pop();
  }
  return [...closest.map((item) => item.value), entry.chineseCore].sort(
    (a, b) => a.localeCompare(b),
  );
}

function spellingHint(entry: LexiconIndexEntry) {
  const letters = entry.headword.match(/\p{L}/gu) || [];
  return `首字母 ${letters[0] || "—"} · ${letters.length} 个字母${entry.headword.includes(" ") ? "，注意词间空格" : ""}`;
}

export function buildQuestion(
  entry: LexiconIndexEntry,
  detail: LexiconDetail | undefined,
  requested: QuestionType,
  pool: LexiconIndexEntry[],
): Question {
  const make = (type: QuestionType, values: Partial<Question>): Question => {
    const catalog = QUESTION_CATALOG.find((item) => item.id === type)!;
    return {
      type,
      label: catalog.label,
      skill: catalog.skill,
      objective: catalog.objective,
      prompt: "",
      support: null,
      answer: entry.headword,
      choices: [],
      inputMode: "text",
      audio: false,
      ...values,
    };
  };
  const fallback = (type: QuestionType, reason: string): Question => {
    const question = buildQuestion(entry, detail, type, pool);
    return {
      ...question,
      requestedType: requested,
      fallbackReason: [reason, question.fallbackReason]
        .filter(Boolean)
        .join(" "),
    };
  };
  const example = getEntryExample(entry, detail);
  const contextFallback = (reason: string) =>
    fallback(example ? "context-choice" : "spelling", reason);
  switch (requested) {
    case "meaning-recall":
      return make(requested, {
        prompt: entry.headword,
        support: entry.britishIpa ? `/${entry.britishIpa}/` : null,
        answer: entry.chineseCore,
        inputMode: "reveal",
        hint: entry.partsOfSpeech.join(" · ") || "先回想在课文中见过它的场景。",
      });
    case "spelling":
      return make(requested, {
        prompt: entry.chineseCore,
        support:
          entry.partsOfSpeech.join(" · ") || "输入完整单词或短语；大小写不计。",
        hint: spellingHint(entry),
      });
    case "listening-choice": {
      const choices = choicesFor(entry, pool);
      if (choices.length < 2)
        return fallback("dictation", "可用释义选项不足，改为听写。");
      return make(requested, {
        prompt: "听发音，选择对应的中文释义。",
        support: "可重复播放系统语音。",
        answer: entry.chineseCore,
        choices,
        inputMode: "choice",
        audio: true,
        hint: entry.partsOfSpeech.join(" · ") || "再听一遍，留意重读音节。",
      });
    }
    case "dictation":
      return make(requested, {
        prompt: "听发音，写出完整单词或短语。",
        support: "大小写不计；词间空格与拼写需要正确。",
        audio: true,
        hint: entry.chineseCore,
      });
    case "context-choice": {
      if (!example)
        return fallback(
          "spelling",
          "当前词条暂无可用的完整例句，改为看中文拼写。",
        );
      const original = findOriginalExample(entry.headword);
      if (!original)
        return fallback(
          "context-gap",
          "该例句暂无已审核的选择项，改为语境填空。",
        );
      const choices = [
        ...new Set([...original.distractors, entry.headword]),
      ].sort((a, b) => a.localeCompare(b));
      return make(requested, {
        prompt: blankTarget(example.en, entry.headword)!,
        support: "选择最符合句意的一项。",
        choices,
        inputMode: "choice",
        hint: original.zh,
        exampleSource: example.source,
      });
    }
    case "context-gap":
      if (!example)
        return fallback(
          "spelling",
          "当前词条暂无可用的完整例句，改为看中文拼写。",
        );
      return make(requested, {
        prompt: blankTarget(example.en, entry.headword)!,
        support: `填入本轮所学、表示“${entry.chineseCore}”的词或短语。`,
        hint: spellingHint(entry),
        exampleSource: example.source,
      });
    case "word-form":
      return fallback(
        "spelling",
        "当前词条暂无已审核的词形变化题，改为基础拼写。",
      );
    case "collocation-gap": {
      const tokens = normalizeTypography(entry.headword).split(" ");
      if (
        tokens.length < 2 ||
        !tokens.every((token) => /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(token))
      )
        return fallback(
          "spelling",
          "当前词条暂无可用的完整短语，改为基础拼写。",
        );
      const answer = tokens[tokens.length - 1];
      const phrase = `${tokens.slice(0, -1).join(" ")} ____`;
      if (targetPattern(answer).test(phrase))
        return contextFallback(
          "短语中的重复词会提示答案，改练完整语境或基础拼写。",
        );
      return make(requested, {
        prompt: phrase,
        support: entry.chineseCore,
        answer,
        hint: `缺少 ${answer.length} 个字母的词。`,
      });
    }
    case "family-conversion":
      return fallback(
        "spelling",
        "词族关联不等于已审核的转换题，当前改为基础拼写。",
      );
    case "confusable":
      return contextFallback(
        "当前词条暂无已审核的易混词辨析题，改练可用语境或基础拼写。",
      );
    case "phrase-dictation":
      if (!entry.headword.trim().includes(" "))
        return fallback("dictation", "当前词条是单词，改为单词听写。");
      return make(requested, {
        prompt: "听发音，写出完整短语。",
        support: "注意词间空格；可重复播放。",
        audio: true,
        hint: entry.chineseCore,
      });
    case "natural-expression":
      return contextFallback(
        "当前词条暂无已审核的自然表达比较题，改练可用语境或基础拼写。",
      );
    case "textbook-context":
      return contextFallback(
        "当前词条未提供可用的教材原文语境，练习来源见题目说明。",
      );
    case "sentence-output":
      return make(requested, {
        prompt: `用 ${entry.headword} 写一个完整的英文句子。`,
        support: "完成后自行核对意思和用法。本地提示只检查目标词与长度。",
        inputMode: "textarea",
        hint: example?.zh || `意思：${entry.chineseCore}`,
      });
    case "paragraph-retell":
      return fallback(
        "sentence-output",
        "当前词条没有完整短文，改为造句；阅读页另有原创短文。",
      );
    default:
      return fallback("meaning-recall", "未识别的题型，改为释义回忆。");
  }
}

export function gradeQuestion(
  question: Question,
  response: string,
): boolean | null {
  if (!question.objective) return null;
  const answer = normalizeAnswer(response);
  return Boolean(answer) && answer === normalizeAnswer(question.answer);
}

export function localSentenceCheck(sentence: string, headword: string) {
  const normalized = normalizeTypography(sentence);
  const hasTarget =
    Boolean(normalizeAnswer(headword)) &&
    targetPattern(headword).test(normalized);
  const wordCount = normalized.match(/\p{L}+(?:['-]\p{L}+)*/gu)?.length || 0;
  return {
    hasTarget,
    completeEnough: wordCount >= 5,
    message: !hasTarget
      ? "句子里还没有目标词或短语。"
      : wordCount < 5
        ? "已找到目标词；可以补充更多信息，再核对句子是否完整。"
        : "已找到目标词，长度也足够；语法、搭配与句意仍需自行核对。",
  };
}
