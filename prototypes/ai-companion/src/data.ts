import sample from "./data/sample.json" with { type: "json" };
import { lemmaCandidates } from "./lexicon-match";

export type LexiconSource = { bookId: string; volume: string; unit: string };
export type LexiconWord = { id: string; headword: string; chineseCore: string; ipa: string; sources: LexiconSource[] };
export type Paragraph = { text: string; sentences: string[] };
export type Article = {
  id: string; title: string; titleZh: string; author: string; sourceUrl: string;
  rights: { label: string; basis: string; url: string };
  difficulty: string; form: string; background: string; paragraphs: Paragraph[];
};

export const ARTICLE = sample.article as Article;
export const LEXICON = sample.lexicon as LexiconWord[];
export const DATA_ORIGIN = sample.generatedFrom;

const byId = new Map(LEXICON.map((word) => [word.id, word]));
const byHeadword = new Map(LEXICON.map((word) => [word.headword.toLowerCase(), word]));

export function wordById(id: string) { return byId.get(id); }

/** Finds a lexicon word for an inflected English token; null when the sample lexicon has none. */
export function lookupWord(token: string): LexiconWord | null {
  for (const candidate of lemmaCandidates(token)) {
    const word = byHeadword.get(candidate);
    if (word) return word;
  }
  return null;
}

/** "必修第一册 · Unit 4"; textbook volumes come before the curriculum list. */
export function sourceLabel(word: LexiconWord) {
  const source = word.sources.find((item) => item.bookId.startsWith("HS-")) ?? word.sources.find((item) => item.bookId.startsWith("JH-")) ?? word.sources[0];
  return source ? `${source.volume} · ${source.unit}` : "词库";
}

export const PRACTICE_WORDS = sample.practiceIds.map((id) => byId.get(id)!).filter(Boolean);
export const UNIT4_WORDS = PRACTICE_WORDS.filter((word) => word.sources.some((source) => source.bookId === "HS-R1" && source.unit === "Unit 4"));

/** Paragraph offsets of each sentence: sentences are joined by single spaces in the source text. */
export function sentenceSpans(paragraph: Paragraph) {
  let offset = 0;
  return paragraph.sentences.map((sentence, index) => {
    const start = offset;
    offset += sentence.length + 1;
    return { index, start, end: start + sentence.length, text: sentence };
  });
}

export const SAMPLE_LABEL = "示例数据";

/** Example practice history: every attempt names a real lexicon word; answers are invented for the demo. */
export type SampleAttempt = { daysAgo: number; kind: "dictation" | "review"; wordId: string; answer: string };
const attempt = (daysAgo: number, kind: SampleAttempt["kind"], headword: string, answer: string): SampleAttempt => {
  const word = PRACTICE_WORDS.find((item) => item.headword === headword);
  if (!word) throw new Error(`Sample word missing: ${headword}`);
  return { daysAgo, kind, wordId: word.id, answer };
};
export const SAMPLE_ATTEMPTS: SampleAttempt[] = [
  attempt(6, "dictation", "evacuate", "evacute"),
  attempt(6, "dictation", "emergency", "emergency"),
  attempt(6, "dictation", "electricity", "electricty"),
  attempt(6, "dictation", "drought", "draught"),
  attempt(5, "review", "disaster", "disaster"),
  attempt(5, "review", "landslide", "landslide"),
  attempt(5, "review", "helicopter", "helicoptor"),
  attempt(3, "dictation", "concentrate", "concentate"),
  attempt(3, "dictation", "awkward", "akward"),
  attempt(3, "dictation", "curious", ""),
  attempt(3, "dictation", "anxious", "anxious"),
  attempt(3, "dictation", "impression", "impression"),
  attempt(2, "review", "evacuate", "evacuate"),
  attempt(2, "review", "electricity", "electricity"),
  attempt(2, "review", "destroy", "destory"),
  attempt(1, "dictation", "confident", "confident"),
  attempt(1, "dictation", "emergency", "emergancy"),
  attempt(1, "dictation", "organise", "organize"),
  attempt(1, "dictation", "explore", "explore"),
  attempt(1, "dictation", "damage", "damage"),
];
/** Due reviews in the example record (shown as a count, not as a schedule). */
export const SAMPLE_DUE_IDS = ["drought", "helicopter", "breathe", "context", "effort", "destroy"].map((headword) => PRACTICE_WORDS.find((word) => word.headword === headword)!.id);

export function dayLabel(daysAgo: number, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
