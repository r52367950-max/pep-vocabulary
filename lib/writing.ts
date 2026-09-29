import type { LexiconIndexEntry } from "./lexicon";
import { activeReviews } from "./progress";
import type { ReviewEvent, StoredCard, WritingGenre, WritingRecord } from "./storage";
import { createLocalId } from "./storage";

export const WRITING_GENRES: Record<WritingGenre, { label: string; detail: string; range: [number, number]; outOf: number }> = {
  free: { label: "自由写作", detail: "围绕一个话题写一段", range: [80, 120], outOf: 25 },
  practical: { label: "应用文", detail: "书信、通知、邀请等，约 80 词", range: [80, 100], outOf: 15 },
  continuation: { label: "读后续写", detail: "按给定开头续写两段，约 150 词", range: [140, 170], outOf: 25 },
};

export const countWords = (text: string) => text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;

// Common irregular forms, so "chose" counts as using "choose". Regular endings are handled below.
const IRREGULAR: Record<string, string[]> = {
  be: ["am", "is", "are", "was", "were", "been", "being"], begin: ["began", "begun"], break: ["broke", "broken"],
  bring: ["brought"], build: ["built"], buy: ["bought"], catch: ["caught"], choose: ["chose", "chosen"], come: ["came"],
  do: ["did", "done", "does"], draw: ["drew", "drawn"], drive: ["drove", "driven"], eat: ["ate", "eaten"], fall: ["fell", "fallen"],
  feel: ["felt"], fight: ["fought"], find: ["found"], fly: ["flew", "flown", "flies"], forget: ["forgot", "forgotten"],
  get: ["got", "gotten"], give: ["gave", "given"], go: ["went", "gone", "goes"], grow: ["grew", "grown"], have: ["had", "has"],
  hear: ["heard"], hide: ["hid", "hidden"], hold: ["held"], keep: ["kept"], know: ["knew", "known"], lay: ["laid"],
  lead: ["led"], leave: ["left"], lend: ["lent"], lie: ["lay", "lain", "lying"], lose: ["lost"], make: ["made"], mean: ["meant"],
  meet: ["met"], pay: ["paid"], ride: ["rode", "ridden"], rise: ["rose", "risen"], run: ["ran"], say: ["said"], see: ["saw", "seen"],
  seek: ["sought"], sell: ["sold"], send: ["sent"], shake: ["shook", "shaken"], shine: ["shone"], sing: ["sang", "sung"],
  sit: ["sat"], sleep: ["slept"], speak: ["spoke", "spoken"], spend: ["spent"], stand: ["stood"], steal: ["stole", "stolen"],
  strike: ["struck"], swim: ["swam", "swum"], take: ["took", "taken"], teach: ["taught"], tear: ["tore", "torn"], tell: ["told"],
  think: ["thought"], throw: ["threw", "thrown"], understand: ["understood"], wake: ["woke", "woken"], wear: ["wore", "worn"],
  win: ["won"], write: ["wrote", "written"], child: ["children"], man: ["men"], woman: ["women"], foot: ["feet"], tooth: ["teeth"],
  good: ["better", "best"], bad: ["worse", "worst"], many: ["more", "most"], much: ["more", "most"],
};

/** Surface forms of one word: itself, regular inflections and known irregular forms. */
export function wordForms(word: string): string[] {
  const w = word.toLowerCase();
  const forms = new Set([w, ...(IRREGULAR[w] || [])]);
  if (!/^[a-z]+$/.test(w) || w.length < 2) return [...forms];
  const consonantY = /[^aeiou]y$/.test(w);
  const stem = w.endsWith("e") ? w.slice(0, -1) : w;
  const doubled = /[^aeiou][aeiou][bdgklmnprt]$/.test(w) && w.length <= 6 ? w + w.at(-1) : null;
  forms.add(/(?:s|x|z|ch|sh|o)$/.test(w) ? `${w}es` : consonantY ? `${w.slice(0, -1)}ies` : `${w}s`);
  forms.add(consonantY ? `${w.slice(0, -1)}ied` : w.endsWith("e") ? `${w}d` : `${w}ed`);
  forms.add(w.endsWith("ie") ? `${w.slice(0, -2)}ying` : `${stem}ing`);
  if (doubled) { forms.add(`${doubled}ed`); forms.add(`${doubled}ing`); }
  forms.add(consonantY ? `${w.slice(0, -1)}ier` : `${stem}er`);
  forms.add(consonantY ? `${w.slice(0, -1)}iest` : `${stem}est`);
  forms.add(consonantY ? `${w.slice(0, -1)}ily` : w.endsWith("le") ? `${w.slice(0, -1)}y` : `${w}ly`);
  return [...forms];
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a headword or phrase in running text, inflecting the first word of a phrase. */
export function targetMatcher(headword: string): RegExp | null {
  const parts = headword.toLowerCase().replace(/[’]/g, "'").replace(/\b(?:sb|sth|one's|someone|something)\b\.?/g, " ").split(/\s+/).filter((part) => /[a-z]/.test(part));
  if (!parts.length) return null;
  const [first, ...rest] = parts;
  const head = `(?:${wordForms(first).map(escape).join("|")})`;
  // Phrase words may be separated by a short object ("take it easy", "put the book off").
  const tail = rest.map((part) => `(?:\\s+[a-z'’-]+){0,2}?\\s+${escape(part)}`).join("");
  return new RegExp(`(?<![A-Za-z'’-])${head}${tail}(?![A-Za-z'’-])`, "gi");
}

export type TargetUse = { id: string; headword: string; count: number; ranges: [number, number][] };

export function findTargetUses(text: string, targets: readonly Pick<LexiconIndexEntry, "id" | "headword">[]): TargetUse[] {
  return targets.map((target) => {
    const pattern = targetMatcher(target.headword);
    const ranges: [number, number][] = [];
    if (pattern) for (const match of text.matchAll(pattern)) ranges.push([match.index!, match.index! + match[0].length]);
    return { id: target.id, headword: target.headword, count: ranges.length, ranges };
  });
}

export type LocalCheck = { id: string; level: "ok" | "tip" | "issue"; message: string };

/** Checks that need no model: length, target coverage, repetition, sentence length and capitals. */
export function localWritingChecks(text: string, uses: readonly TargetUse[], range: [number, number]): LocalCheck[] {
  const words = countWords(text);
  const checks: LocalCheck[] = [];
  if (words < range[0]) checks.push({ id: "length", level: words < range[0] * 0.6 ? "issue" : "tip", message: `现在 ${words} 词，目标 ${range[0]}–${range[1]} 词。` });
  else if (words > range[1] * 1.2) checks.push({ id: "length", level: "tip", message: `现在 ${words} 词，超过目标 ${range[1]} 词较多，可以精简。` });
  else checks.push({ id: "length", level: "ok", message: `${words} 词，篇幅合适。` });
  const missing = uses.filter((use) => !use.count);
  checks.push(missing.length
    ? { id: "targets", level: "tip", message: `还没用到：${missing.map((use) => use.headword).join("、")}。` }
    : { id: "targets", level: "ok", message: "目标词都用到了。" });
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z]{5,}/g) || []) counts.set(word, (counts.get(word) || 0) + 1);
  const repeated = [...counts].filter(([, count]) => count >= 4).map(([word]) => word).slice(0, 4);
  if (repeated.length) checks.push({ id: "repeat", level: "tip", message: `${repeated.join("、")} 出现较多，可以换个说法。` });
  const sentences = text.split(/(?<=[.!?])\s+/).map((sentence) => countWords(sentence)).filter(Boolean);
  const long = sentences.filter((length) => length > 35).length;
  if (long) checks.push({ id: "long", level: "tip", message: `有 ${long} 个句子超过 35 词，读起来可能吃力。` });
  if (sentences.length >= 3 && sentences.every((length) => length < 9)) checks.push({ id: "short", level: "tip", message: "句子都比较短，可以用连接词合并几句。" });
  const lowercaseStarts = text.split(/(?<=[.!?])\s+/).filter((sentence) => /^[a-z]/.test(sentence.trim())).length;
  if (lowercaseStarts) checks.push({ id: "capital", level: "issue", message: `有 ${lowercaseStarts} 个句子开头没有大写。` });
  if (/\bi\b/.test(text)) checks.push({ id: "pronoun", level: "issue", message: "代词 I 需要大写。" });
  return checks;
}

/**
 * Suggested target words: recent mistakes first, then words practised in the last week,
 * skipping phrases with placeholders and paused cards. Deterministic for a given history.
 */
export function suggestTargets(events: readonly ReviewEvent[], cards: ReadonlyMap<string, StoredCard>, byId: ReadonlyMap<string, LexiconIndexEntry>, count = 6): LexiconIndexEntry[] {
  const picked: LexiconIndexEntry[] = [];
  const seen = new Set<string>();
  const reviews = activeReviews(events);
  const add = (id: string) => {
    if (picked.length >= count || seen.has(id)) return;
    seen.add(id);
    const entry = byId.get(id);
    if (!entry || cards.get(id)?.status === "paused" || /\b(?:sb|sth)\b|\.\.\./.test(entry.headword) || entry.flags.properName) return;
    picked.push(entry);
  };
  for (let i = reviews.length - 1; i >= 0 && picked.length < Math.ceil(count / 2); i--) if (!reviews[i].correct) add(reviews[i].cardId);
  for (let i = reviews.length - 1; i >= 0 && picked.length < count; i--) add(reviews[i].cardId);
  return picked;
}

export function newWriting(genre: WritingGenre, targetIds: string[], prompt = "", now = new Date()): WritingRecord {
  const time = now.toISOString();
  return {
    id: createLocalId(), createdAt: time, updatedAt: time, genre, title: "", prompt, targetIds,
    wordRange: WRITING_GENRES[genre].range, versions: [{ id: createLocalId(), text: "", savedAt: time, review: null }],
  };
}

export const latestVersion = (record: WritingRecord) => record.versions[record.versions.length - 1];

/** Title for lists: the saved title, else the first words of the text. */
export function writingTitle(record: WritingRecord) {
  if (record.title.trim()) return record.title.trim();
  const text = latestVersion(record)?.text.trim() || "";
  return text ? `${text.split(/\s+/).slice(0, 6).join(" ")}${countWords(text) > 6 ? "…" : ""}` : "未命名草稿";
}
