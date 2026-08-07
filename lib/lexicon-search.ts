import { recallSearchCandidates } from "./assistant/local-search.ts";
import type { LexiconIndexEntry, Scope } from "./lexicon";
import type { ReviewEvent, StoredCard } from "./storage";

const BOOK_ALIASES: Array<[RegExp, string]> = [
  [/(?:选择性必修|选必)\s*(?:一|1)(?!\d)/i, "HS-S1"],
  [/(?:选择性必修|选必)\s*(?:二|2)(?!\d)/i, "HS-S2"],
  [/(?:选择性必修|选必)\s*(?:三|3)(?!\d)/i, "HS-S3"],
  [/(?:选择性必修|选必)\s*(?:四|4)(?!\d)/i, "HS-S4"],
  [/(?:高中)?必修\s*(?:一|1)(?!\d)/i, "HS-R1"],
  [/(?:高中)?必修\s*(?:二|2)(?!\d)/i, "HS-R2"],
  [/(?:高中)?必修\s*(?:三|3)(?!\d)/i, "HS-R3"],
  [/(?:七年级上|七上)/, "JH-7A"], [/(?:七年级下|七下)/, "JH-7B"],
  [/(?:八年级上|八上)/, "JH-8A"], [/(?:八年级下|八下)/, "JH-8B"],
  [/(?:九年级|九上|九下)/, "JH-9"],
];

const UNIT_NUMBER: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const SEARCH_NOISE_ZH = /(?:请|帮我|搜索|查找|找出|列出|显示|看看|所有|全部|有哪些|表示|意思|含义|关于|相关|单词|词语|词汇|高频|核心|重点|英语|英文|用于|可以|一个|一下|里面|范围|教材|课本|词)/g;
const SEARCH_NOISE_EN = /\b(?:words?|vocabulary|about|related|show|find|all|the|of|in)\b/gi;

function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function sourceOrder(entry: LexiconIndexEntry) {
  const first = entry.sources[0];
  const unit = Number(first?.unit.match(/\d+/)?.[0] || 999);
  return `${first?.bookId || "ZZZ"}-${String(unit).padStart(3, "0")}-${String(first?.printedPage || 9999).padStart(4, "0")}-${entry.headword}`;
}

export function rankWeakMemory(entries: LexiconIndexEntry[], cards: Map<string, StoredCard>, events: ReviewEvent[] = [], limit = 100) {
  const misses = new Map<string, number>();
  for (const event of events) if (!event.correct) misses.set(event.cardId, (misses.get(event.cardId) || 0) + 1);
  return entries
    .map((entry) => {
      const card = cards.get(entry.id);
      if (!card?.lastReviewed || card.status === "paused") return null;
      const weakest = Math.min(...Object.values(card.skills));
      const difficulty = Number(card.fsrs.difficulty || 0);
      const overdueDays = Math.max(0, (Date.now() - new Date(card.due).getTime()) / 86_400_000);
      const score = (card.status === "weak" ? 1_000 : 0) + (1 - weakest) * 500 + difficulty * 15 + Math.min(30, overdueDays) * 3 + Math.min(20, misses.get(entry.id) || 0) * 12;
      return { entry, score };
    })
    .filter(Boolean)
    .sort((left, right) => right!.score - left!.score || sourceOrder(left!.entry).localeCompare(sourceOrder(right!.entry)))
    .slice(0, Math.max(0, limit))
    .map((row) => row!.entry);
}

export function searchLexicon(entries: LexiconIndexEntry[], rawQuery: string, cards: Map<string, StoredCard>, events: ReviewEvent[] = []) {
  const query = normalized(rawQuery);
  if (!query) return entries;

  const scopes = new Set<Scope>();
  if (/初中|junior\s*high|middle\s*school/i.test(query)) scopes.add("middle-core");
  if (/高中|senior\s*high|high\s*school/i.test(query)) {
    scopes.add("high-required"); scopes.add("high-selective"); scopes.add("curriculum-not-textbook"); scopes.add("gaokao-supplement");
  }
  if (/高考|gaokao/i.test(query)) scopes.add("gaokao-supplement");

  const books = BOOK_ALIASES.filter(([pattern]) => pattern.test(query)).map(([, id]) => id);
  const unitMatch = query.match(/(?:unit|u)\s*([0-9]{1,2})\b/i) || query.match(/第?\s*([一二三四五六七八九十]|[0-9]{1,2})\s*单元/i);
  const unitNumber = unitMatch ? (Number(unitMatch[1]) || UNIT_NUMBER[unitMatch[1]]) : null;
  const wantsWeak = /薄弱|错词|不熟|不会|不擅长|记忆清单|weak|mistake/i.test(query);
  const wantsUnseen = /未学|没学|new\s*words?/i.test(query);
  const wantsMastered = /已掌握|熟练|mastered/i.test(query);

  const pool = entries.filter((entry) => {
    const card = cards.get(entry.id);
    if (scopes.size && !entry.scopes.some((scope) => scopes.has(scope))) return false;
    if (books.length && !entry.sources.some((source) => books.includes(source.bookId))) return false;
    if (unitNumber && !entry.sources.some((source) => source.unit === `Unit ${unitNumber}` && (!books.length || books.includes(source.bookId)))) return false;
    if (wantsUnseen && card?.lastReviewed) return false;
    if (wantsMastered && card?.status !== "mastered") return false;
    return true;
  });

  if (wantsWeak) {
    const ranked = rankWeakMemory(pool, cards, events, 100);
    if (ranked.length) return ranked;
  }

  let residual = query.replace(SEARCH_NOISE_ZH, " ").replace(SEARCH_NOISE_EN, " ");
  for (const [pattern] of BOOK_ALIASES) residual = residual.replace(pattern, " ");
  residual = residual
    .replace(/(?:初中|高中|高考|junior\s*high|middle\s*school|senior\s*high|high\s*school|gaokao)/gi, " ")
    .replace(/(?:unit|u)\s*[0-9]{1,2}\b|第?\s*(?:[一二三四五六七八九十]|[0-9]{1,2})\s*单元/gi, " ")
    .replace(/(?:薄弱|错词|不熟|不会|不擅长|记忆清单|未学|没学|已掌握|熟练|weak|mistake|mastered|new)/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!residual) return [...pool].sort((a, b) => sourceOrder(a).localeCompare(sourceOrder(b)));

  const tokens = residual.split(/\s+/).filter(Boolean);
  const direct = pool.map((entry) => {
    const haystack = normalized(`${entry.headword} ${entry.lookup} ${entry.chineseCore} ${entry.partsOfSpeech.join(" ")} ${entry.sources.map((source) => `${source.volume} ${source.unit}`).join(" ")}`);
    const exact = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? (entry.headword.toLowerCase().includes(token) ? 80 : 35) : 0), 0);
    return { entry, score: exact };
  }).filter((row) => row.score > 0);
  const recalled = recallSearchCandidates(pool, residual, { limit: pool.length });
  const recallRank = new Map(recalled.map((entry, index) => [entry.id, recalled.length - index]));
  const combined = new Map<string, { entry: LexiconIndexEntry; score: number }>();
  for (const row of direct) combined.set(row.entry.id, row);
  for (const entry of recalled) {
    const previous = combined.get(entry.id);
    combined.set(entry.id, { entry, score: (previous?.score || 0) + (recallRank.get(entry.id) || 0) });
  }
  return [...combined.values()].sort((a, b) => b.score - a.score || sourceOrder(a.entry).localeCompare(sourceOrder(b.entry))).map((row) => row.entry);
}
