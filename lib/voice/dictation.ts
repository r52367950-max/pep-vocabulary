import type { LexiconIndexEntry } from "../lexicon";

export type DictationMode = "words" | "sentences";
export type DictationItem = { id: string; mode: DictationMode; text: string; hint: string; source: string; wordId?: string };
export type DictationDiff = { kind: "equal" | "missing" | "extra" | "replace"; expected?: string; actual?: string };
export type DictationResult = { correct: boolean; matched: number; total: number; differences: DictationDiff[] };
export type DictationHistory = { item: DictationItem; attempts: number; mistakes: number; lastAnswer: string; lastAt: string; resolved: boolean };
export const DICTATION_HISTORY_KEY = "vocab-studio:voice-dictation:v1";

/** Editorial sentences, not licensed textbook excerpts or purported authentic speech. */
export const DICTATION_SENTENCES: DictationItem[] = [
  ["daily-1", "I would rather take a short walk after dinner.", "日常 · 生活选择"],
  ["daily-2", "Could you remind me to return the book tomorrow?", "日常 · 请求帮助"],
  ["city-1", "The museum is within walking distance of the station.", "城市 · 出行"],
  ["city-2", "Public transport can make a city more accessible.", "城市 · 公共空间"],
  ["culture-1", "What makes this festival special is its sense of community.", "文化 · 节日"],
  ["culture-2", "The story made me see the situation from a different perspective.", "文化 · 阅读"],
  ["school-1", "Our club gives students a chance to explore new interests.", "校园 · 社团"],
  ["school-2", "I see your point, but we should consider another solution.", "校园 · 交流观点"],
  ["environment-1", "A practical first step is to reduce unnecessary packaging.", "环境 · 日常行动"],
  ["environment-2", "Protecting wildlife requires cooperation between local communities and researchers.", "环境 · 自然保护"],
  ["technology-1", "The evidence suggests that the new method could save energy.", "科技 · 讨论证据"],
  ["technology-2", "We should distinguish reliable information from personal opinions.", "科技 · 信息判断"],
].map(([id, text, hint]) => ({ id: `sentence:${id}`, mode: "sentences", text, hint, source: "词迹原创练习句" }));

export function wordDictationItems(entries: LexiconIndexEntry[]): DictationItem[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const text = entry.headword.trim();
    const key = text.toLowerCase();
    if (!/[a-z]/i.test(text) || text.length > 100 || seen.has(key)) return false;
    seen.add(key); return true;
  }).map((entry) => ({ id: `word:${entry.id}`, wordId: entry.id, mode: "words", text: entry.headword.trim(), hint: entry.chineseCore, source: "当前词库" }));
}
export function selectDictationRound<T>(items: readonly T[], count: number, random = Math.random): T[] {
  const selected = [...items];
  for (let index = selected.length - 1; index > 0; index--) {
    const target = Math.floor(Math.max(0, Math.min(0.999999999, random())) * (index + 1));
    [selected[index], selected[target]] = [selected[target], selected[index]];
  }
  return selected.slice(0, Math.max(0, Math.floor(count)));
}

const EQUIVALENTS: Record<string, string> = { colour: "color", colours: "colors", favourite: "favorite", favourites: "favorites", centre: "center", centres: "centers", organise: "organize", organised: "organized", realise: "realize", realised: "realized", travelling: "traveling", travelled: "traveled", theatre: "theater" };
const CONTRACTIONS: Record<string, string> = { "i'm": "i am", "you're": "you are", "we're": "we are", "they're": "they are", "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have", "i'll": "i will", "you'll": "you will", "he'll": "he will", "she'll": "she will", "we'll": "we will", "they'll": "they will", "can't": "can not", cannot: "can not", "won't": "will not", "don't": "do not", "doesn't": "does not", "didn't": "did not", "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not", "haven't": "have not", "hasn't": "has not", "hadn't": "had not", "couldn't": "could not", "wouldn't": "would not", "shouldn't": "should not", "let's": "let us" };
/** Punctuation/case, listed unambiguous contractions and listed UK/US spellings are equivalent. */
export function dictationTokens(text: string): string[] {
  return (text.slice(0, 3000).normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:'[a-z]+)*/g) ?? [])
    .flatMap((token) => (CONTRACTIONS[token] ?? token).split(" ")).map((token) => EQUIVALENTS[token] ?? token).slice(0, 160);
}
export function compareDictation(expectedText: string, answer: string): DictationResult {
  const expected = dictationTokens(expectedText), actual = dictationTokens(answer);
  const costs = Array.from({ length: expected.length + 1 }, () => new Uint16Array(actual.length + 1));
  for (let i = 0; i <= expected.length; i++) costs[i][0] = i;
  for (let j = 0; j <= actual.length; j++) costs[0][j] = j;
  for (let i = 1; i <= expected.length; i++) for (let j = 1; j <= actual.length; j++) {
    costs[i][j] = expected[i - 1] === actual[j - 1] ? costs[i - 1][j - 1] : 1 + Math.min(costs[i - 1][j - 1], costs[i - 1][j], costs[i][j - 1]);
  }
  const differences: DictationDiff[] = [];
  let i = expected.length, j = actual.length;
  while (i || j) {
    if (i && j && expected[i - 1] === actual[j - 1]) { differences.push({ kind: "equal", expected: expected[--i], actual: actual[--j] }); }
    else if (i && j && costs[i][j] === costs[i - 1][j - 1] + 1) { differences.push({ kind: "replace", expected: expected[--i], actual: actual[--j] }); }
    else if (i && costs[i][j] === costs[i - 1][j] + 1) { differences.push({ kind: "missing", expected: expected[--i] }); }
    else { differences.push({ kind: "extra", actual: actual[--j] }); }
  }
  differences.reverse();
  return { correct: expected.length > 0 && costs[expected.length][actual.length] === 0, matched: differences.filter((part) => part.kind === "equal").length, total: expected.length, differences };
}
export function recordDictationAttempt(history: DictationHistory[], item: DictationItem, answer: string, now = new Date().toISOString()): DictationHistory[] {
  const previous = history.find((record) => record.item.id === item.id);
  const correct = compareDictation(item.text, answer).correct;
  return [{ item, attempts: (previous?.attempts ?? 0) + 1, mistakes: (previous?.mistakes ?? 0) + (correct ? 0 : 1), lastAnswer: answer.slice(0, 3000), lastAt: now, resolved: correct }, ...history.filter((record) => record.item.id !== item.id)].slice(0, 300);
}
/** Independently versioned, bounded local history; never writes an FSRS card or review event. */
export function parseDictationHistory(json: string | null): DictationHistory[] {
  if (!json || json.length > 2_000_000) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is DictationHistory => {
      if (!record || typeof record !== "object") return false;
      const { item, attempts, mistakes, lastAnswer, lastAt, resolved } = record;
      return !!item && typeof item.id === "string" && item.id.length <= 200 && (item.mode === "words" || item.mode === "sentences") && typeof item.text === "string" && item.text.length <= 500 && typeof item.hint === "string" && item.hint.length <= 1000 && typeof item.source === "string" && typeof lastAnswer === "string" && lastAnswer.length <= 3000 && typeof lastAt === "string" && Number.isFinite(Date.parse(lastAt)) && Number.isSafeInteger(attempts) && attempts > 0 && Number.isSafeInteger(mistakes) && mistakes >= 0 && mistakes <= attempts && typeof resolved === "boolean";
    }).slice(0, 300);
  } catch { return []; }
}
