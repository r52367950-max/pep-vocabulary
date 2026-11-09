import { compareDictation } from "@/lib/voice/dictation";
import { editDistance } from "@/lib/mistakes";
import { LEXICON, PRACTICE_WORDS, SAMPLE_ATTEMPTS, SAMPLE_DUE_IDS, UNIT4_WORDS, wordById, sourceLabel, type LexiconWord } from "./data";

export type PracticeItem = { id: string; text: string; hint: string; wordId?: string; source: string };
export type MistakeKind = "near-miss" | "spelling" | "confusion" | "recall";
export const MISTAKE_TITLE: Record<MistakeKind, string> = {
  "near-miss": "拼写差一点",
  spelling: "拼写错误",
  confusion: "写成了另一个词",
  recall: "没写出来",
};
export type CharPart = { kind: "same" | "missing" | "extra" | "wrong"; expected?: string; actual?: string };
export type Score = { correct: boolean; kind?: MistakeKind; parts: CharPart[]; explanation: string };

export function itemFromWord(word: LexiconWord): PracticeItem {
  return { id: `word:${word.id}`, text: word.headword, hint: word.chineseCore, wordId: word.id, source: sourceLabel(word) };
}

/** Letter alignment for showing exactly where an answer differs. */
export function letterDiff(expected: string, actual: string): CharPart[] {
  const a = expected.toLowerCase(), b = actual.toLowerCase();
  const cost = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    cost[i][j] = a[i - 1] === b[j - 1] ? cost[i - 1][j - 1] : 1 + Math.min(cost[i - 1][j - 1], cost[i - 1][j], cost[i][j - 1]);
  }
  const parts: CharPart[] = [];
  let i = a.length, j = b.length;
  while (i || j) {
    if (i && j && a[i - 1] === b[j - 1]) { parts.push({ kind: "same", expected: expected[i - 1], actual: actual[j - 1] }); i--; j--; }
    else if (i && j && cost[i][j] === cost[i - 1][j - 1] + 1) { parts.push({ kind: "wrong", expected: expected[i - 1], actual: actual[j - 1] }); i--; j--; }
    else if (i && cost[i][j] === cost[i - 1][j] + 1) { parts.push({ kind: "missing", expected: expected[i - 1] }); i--; }
    else { parts.push({ kind: "extra", actual: actual[j - 1] }); j--; }
  }
  return parts.reverse();
}

const otherHeadwords = new Map(LEXICON.map((word) => [word.headword.toLowerCase(), word]));

/** Deterministic grading: the product's dictation comparison decides correctness. */
export function scoreAnswer(item: PracticeItem, answer: string): Score {
  const typed = answer.trim();
  const result = compareDictation(item.text, typed);
  if (result.correct) {
    const exact = typed.toLowerCase() === item.text.toLowerCase();
    return { correct: true, parts: letterDiff(item.text, item.text), explanation: exact ? "正确。" : `正确。「${typed}」与「${item.text}」是英美拼写差异，按正确计。` };
  }
  if (!typed) return { correct: false, kind: "recall", parts: letterDiff(item.text, ""), explanation: "这次没有写出来。先听两遍，再看释义回想词形。" };
  const other = otherHeadwords.get(typed.toLowerCase());
  if (other && other.headword.toLowerCase() !== item.text.toLowerCase()) {
    return { correct: false, kind: "confusion", parts: letterDiff(item.text, typed), explanation: `你写的是另一个词「${other.headword}」（${other.chineseCore}）。注意两者的拼写和意思。` };
  }
  const parts = letterDiff(item.text, typed);
  const tolerance = item.text.length <= 4 ? 1 : 2;
  const distance = editDistance(typed.toLowerCase(), item.text.toLowerCase(), tolerance);
  const missing = parts.filter((part) => part.kind === "missing").map((part) => part.expected).join("");
  const extra = parts.filter((part) => part.kind === "extra").map((part) => part.actual).join("");
  const wrong = parts.filter((part) => part.kind === "wrong");
  const details = [
    missing && `漏写了「${missing}」`,
    extra && `多写了「${extra}」`,
    wrong.length ? wrong.map((part) => `把「${part.expected}」写成了「${part.actual}」`).join("，") : "",
  ].filter(Boolean).join("；");
  if (distance <= tolerance) return { correct: false, kind: "near-miss", parts, explanation: `只差一点：${details}。` };
  return { correct: false, kind: "spelling", parts, explanation: `拼写和答案相差较多${details ? `：${details}` : ""}。建议按音节拆开再写一遍。` };
}

/** Word pools a plan can draw from. */
export type PlanScope = "mistakes" | "due" | "unit4" | "file";
export const SCOPE_LABEL: Record<PlanScope, string> = {
  mistakes: "最近错词",
  due: "到期复习",
  unit4: "必修第一册 · Unit 4",
  file: "你的文件中的词",
};

export function sampleMistakeWords(): LexiconWord[] {
  const seen = new Set<string>();
  const out: LexiconWord[] = [];
  for (const attempt of [...SAMPLE_ATTEMPTS].sort((a, b) => a.daysAgo - b.daysAgo)) {
    const word = wordById(attempt.wordId);
    if (!word || seen.has(word.id) || compareDictation(word.headword, attempt.answer).correct) continue;
    seen.add(word.id);
    out.push(word);
  }
  return out;
}

export function scopeItems(scope: PlanScope, fileItems: PracticeItem[] = []): PracticeItem[] {
  if (scope === "file") return fileItems;
  const words = scope === "mistakes"
    ? [...sampleMistakeWords(), ...UNIT4_WORDS]
    : scope === "due" ? [...SAMPLE_DUE_IDS.map((id) => wordById(id)!), ...UNIT4_WORDS] : UNIT4_WORDS;
  const seen = new Set<string>();
  return words.filter((word) => word && !seen.has(word.id) && seen.add(word.id)).map(itemFromWord);
}

export type PlanStep = { id: string; kind: "dictation" | "reading" | "review"; title: string; detail: string; minutes: number; items?: PracticeItem[] };
export type PlanSpec = { minutes: number; scope: PlanScope; fileName?: string; fileItems?: PracticeItem[] };

/** A short plan for one sitting. Word count follows the time: about 0.8 minutes per dictated word. */
export function buildPlan(spec: PlanSpec): PlanStep[] {
  const minutes = Math.max(5, Math.min(60, Math.round(spec.minutes)));
  const pool = scopeItems(spec.scope, spec.fileItems);
  const count = Math.max(Math.min(4, pool.length), Math.min(12, pool.length, Math.floor((minutes * 0.45) / 0.8)));
  const items = pool.slice(0, count);
  const dictationMinutes = Math.max(2, Math.round(items.length * 0.8));
  const readingMinutes = minutes >= 15 ? Math.round(minutes * 0.35) : 0;
  const reviewMinutes = Math.max(1, minutes - dictationMinutes - readingMinutes);
  const steps: PlanStep[] = [{
    id: "dictation", kind: "dictation", minutes: dictationMinutes, items,
    title: `单词听写 · ${items.length} 词`,
    detail: `${SCOPE_LABEL[spec.scope]}${spec.scope === "file" && spec.fileName ? `：${spec.fileName}` : ""}`,
  }];
  if (readingMinutes) {
    steps.push({ id: "reading", kind: "reading", minutes: readingMinutes, title: "读 Mangrove Forests 第 1–2 段", detail: "选中难句即可提问" });
  }
  steps.push({ id: "review", kind: "review", minutes: reviewMinutes, title: "只重练今天写错的词", detail: "听写后按错项生成" });
  return steps;
}

/** Week summary from the example record, by practice performance only. */
export function sampleStatus() {
  const days = new Set(SAMPLE_ATTEMPTS.map((attempt) => attempt.daysAgo));
  const dictation = SAMPLE_ATTEMPTS.filter((attempt) => attempt.kind === "dictation");
  const scored = SAMPLE_ATTEMPTS.map((attempt) => {
    const word = wordById(attempt.wordId)!;
    return { attempt, word, score: scoreAnswer(itemFromWord(word), attempt.answer) };
  });
  const kinds: Record<MistakeKind, number> = { "near-miss": 0, spelling: 0, confusion: 0, recall: 0 };
  for (const row of scored) if (!row.score.correct && row.score.kind) kinds[row.score.kind] += 1;
  const misses = new Map<string, { word: LexiconWord; count: number; last: string }>();
  for (const row of scored) {
    if (row.score.correct) continue;
    const entry = misses.get(row.word.id) ?? { word: row.word, count: 0, last: row.attempt.answer };
    entry.count += 1;
    misses.set(row.word.id, entry);
  }
  const fixed = sampleMistakeWords().length;
  return {
    practiceDays: days.size,
    dictationCorrect: dictation.filter((attempt) => compareDictation(wordById(attempt.wordId)!.headword, attempt.answer).correct).length,
    dictationTotal: dictation.length,
    reviewCorrect: SAMPLE_ATTEMPTS.filter((attempt) => attempt.kind === "review" && compareDictation(wordById(attempt.wordId)!.headword, attempt.answer).correct).length,
    reviewTotal: SAMPLE_ATTEMPTS.filter((attempt) => attempt.kind === "review").length,
    kinds,
    frequent: [...misses.values()].sort((a, b) => b.count - a.count || a.word.headword.localeCompare(b.word.headword)).slice(0, 4),
    openMistakes: fixed,
    due: SAMPLE_DUE_IDS.length,
    nearMissWords: scored.filter((row) => row.score.kind === "near-miss").map((row) => row.word).filter((word, index, all) => all.findIndex((other) => other.id === word.id) === index),
  };
}

export const ALL_PRACTICE_WORDS = PRACTICE_WORDS;
