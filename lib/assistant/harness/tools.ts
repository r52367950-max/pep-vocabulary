/**
 * The chat assistant's toolbox.
 *
 * Every tool is read-only and works on data the server already trusts: the published
 * lexicon and a sandboxed calculator. Nothing here reaches the network, the database or
 * the learner's stored records, so no call needs approval. Changes to the learner's study
 * (starting a dictation, opening a reading) stay as buttons the learner presses.
 *
 * A tool returns data or `{ error }`. Errors go back to the model as an ordinary result so
 * it can correct the call; they never fail the request.
 */
import { resolveLexiconEvidence, type LexiconEvidence } from "../core";
import { runPython } from "./python";

export type LexiconRow = LexiconEvidence & { lookup?: string; flags?: { formalReleaseEligible?: boolean } };
export type ToolContext = {
  rows: LexiconRow[];
  /** Beijing calendar date, `YYYY-MM-DD`. */
  today: string;
  /** Entries a tool has shown the model; actions may refer to these IDs. */
  evidence: Map<string, LexiconEvidence>;
};
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** What the learner sees under the answer. Never sent to the model. */
  label: string;
  run: (args: Record<string, unknown>, context: ToolContext) => unknown;
};

export const TOOL_LIMITS = { lookupWords: 12, wordChars: 60, searchResults: 40, searchDefault: 20, evidence: 96 } as const;

type Lexicon = { eligible: LexiconRow[]; byKey: Map<string, LexiconRow[]>; volumes: { bookId: string; volume: string; units: string[] }[] };
const lexicons = new WeakMap<LexiconRow[], Lexicon>();
const fold = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

/** Keys a headword answers to: as printed, without its bracketed part, and with the brackets opened. */
function headwordKeys(row: LexiconRow): string[] {
  const printed = fold(row.headword);
  return [...new Set([printed, fold(row.lookup ?? row.headword), fold(printed.replace(/[(（][^)）]*[)）]?/g, " ")), fold(printed.replace(/[()（）]/g, " "))])].filter(Boolean);
}
/** Release rows never change while a Worker is alive, so the lookup tables are built once. */
function lexicon(rows: LexiconRow[]): Lexicon {
  let built = lexicons.get(rows);
  if (!built) {
    const eligible = rows.filter((row) => row.flags?.formalReleaseEligible === true), byKey = new Map<string, LexiconRow[]>(), volumes = new Map<string, { bookId: string; volume: string; units: Set<string> }>();
    for (const row of eligible) {
      for (const key of headwordKeys(row)) { const list = byKey.get(key); if (list) list.push(row); else byKey.set(key, [row]); }
      for (const source of row.sources) {
        const volume = volumes.get(source.bookId) ?? { bookId: source.bookId, volume: source.volume, units: new Set<string>() };
        volume.units.add(source.unit); volumes.set(source.bookId, volume);
      }
    }
    const unitOrder = (unit: string) => { const number = /(\d+)\s*$/.exec(unit); return (/^unit/i.test(unit) ? 100 : 0) + (number ? Number(number[1]) : 0); };
    built = { eligible, byKey, volumes: [...volumes.values()].map((item) => ({ bookId: item.bookId, volume: item.volume, units: [...item.units].sort((a, b) => unitOrder(a) - unitOrder(b)) })).sort((a, b) => a.bookId.localeCompare(b.bookId)) };
    lexicons.set(rows, built);
  }
  return built;
}

/** Likely dictionary forms of an inflected word, most specific first. */
function baseForms(word: string): string[] {
  if (!/^[a-z][a-z'-]*$/.test(word)) return [];
  const forms: string[] = [], add = (stem: string) => { if (stem.length > 1) { forms.push(stem); if (/([b-df-hj-np-tv-z])\1$/.test(stem)) forms.push(stem.slice(0, -1)); } };
  if (word.endsWith("ies") || word.endsWith("ied")) forms.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ing")) { add(word.slice(0, -3)); forms.push(`${word.slice(0, -3)}e`); }
  if (word.endsWith("ed")) { add(word.slice(0, -2)); forms.push(word.slice(0, -1)); }
  if (word.endsWith("es")) forms.push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) forms.push(word.slice(0, -1));
  if (word.endsWith("er")) { add(word.slice(0, -2)); forms.push(word.slice(0, -1)); }
  if (word.endsWith("est")) { add(word.slice(0, -3)); forms.push(word.slice(0, -2)); }
  if (word.endsWith("ly")) forms.push(word.slice(0, -2));
  return [...new Set(forms)].filter((form) => form !== word);
}

function entry(row: LexiconRow, context: ToolContext) {
  if (!context.evidence.has(row.id) && context.evidence.size < TOOL_LIMITS.evidence) context.evidence.set(row.id, resolveLexiconEvidence(context.rows, [row.id])[0]);
  const textbook = row.sources.slice(0, 4).map((source) => `${source.volume} ${source.unit}${typeof source.printedPage === "number" ? ` 第${source.printedPage}页` : ""}`);
  return { id: row.id, headword: row.headword, meaning: row.chineseCore, partsOfSpeech: row.partsOfSpeech.slice(0, 6), textbook, usableInActions: context.evidence.has(row.id) };
}
const strings = (value: unknown, maximum: number, each: number): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every((item) => typeof item === "string" && item.trim() && item.length <= each) ? value as string[] : null;
const optional = (value: unknown, maximum: number): string | null | undefined =>
  value === undefined || value === null || value === "" ? undefined : typeof value === "string" && value.length <= maximum ? fold(value) : null;

const lookupWords: ToolDefinition = {
  name: "lookup_words",
  label: "查了词库",
  description: "在教材词库里核对英文单词或短语。返回词条 ID、中文释义、词性和教材出处；没收录的词会标明，并给出拼写相近的词条。讲解某个词在教材里的意思、判断一个词是否在词库里、或需要词条 ID 来安排听写和复习时使用。变形（如 stopped、studies）会按原形查找。",
  parameters: { type: "object", additionalProperties: false, required: ["words"], properties: { words: { type: "array", minItems: 1, maxItems: TOOL_LIMITS.lookupWords, items: { type: "string", maxLength: TOOL_LIMITS.wordChars }, description: "要核对的英文单词或短语" } } },
  run(args, context) {
    const words = strings(args.words, TOOL_LIMITS.lookupWords, TOOL_LIMITS.wordChars);
    if (!words) return { error: `words 需要 1–${TOOL_LIMITS.lookupWords} 个英文单词或短语，每个不超过 ${TOOL_LIMITS.wordChars} 个字符` };
    const { byKey, eligible } = lexicon(context.rows);
    return { results: [...new Set(words.map(fold))].map((query) => {
      const exact = byKey.get(query);
      if (exact) return { query, entries: exact.slice(0, 3).map((row) => entry(row, context)) };
      const base = baseForms(query).find((form) => byKey.has(form));
      if (base) return { query, matchedBaseForm: base, entries: byKey.get(base)!.slice(0, 3).map((row) => entry(row, context)) };
      const stem = query.slice(0, Math.max(3, Math.min(5, query.length - 1)));
      return { query, entries: [], note: "教材词库没有收录这个词", similar: stem.length >= 3 ? eligible.filter((row) => fold(row.headword).startsWith(stem)).slice(0, 5).map((row) => row.headword) : [] };
    }) };
  },
};

const searchLexicon: ToolDefinition = {
  name: "search_lexicon",
  label: "翻了教材词表",
  description: "按教材、单元、开头字母或中文释义筛选教材词库，返回词条列表和总数。用户提到“必修第一册 Unit 2 的词”“八年级上册的词”“表示放弃的词”这类范围时使用。book 用册名（如 必修第一册、选择性必修第二册、八年级上册）或教材代号；unit 写成 Unit 3 或 Welcome Unit。条件至少给一个；册名或单元不存在时会返回可用的名称。",
  parameters: { type: "object", additionalProperties: false, properties: {
    book: { type: "string", maxLength: 40, description: "册名或教材代号" },
    unit: { type: "string", maxLength: 40, description: "单元名，如 Unit 3" },
    prefix: { type: "string", maxLength: 20, description: "词头的开头字母" },
    meaning: { type: "string", maxLength: 20, description: "中文释义里包含的字词" },
    limit: { type: "integer", minimum: 1, maximum: TOOL_LIMITS.searchResults, description: `返回条数，默认 ${TOOL_LIMITS.searchDefault}` },
  } },
  run(args, context) {
    const book = optional(args.book, 40), unitText = optional(args.unit, 40), prefix = optional(args.prefix, 20), meaning = optional(args.meaning, 20);
    if (book === null || unitText === null || prefix === null || meaning === null) return { error: "筛选条件需要是较短的文字" };
    if (!book && !unitText && !prefix && !meaning) return { error: "请至少给出 book、unit、prefix、meaning 中的一个条件" };
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(TOOL_LIMITS.searchResults, args.limit)) : TOOL_LIMITS.searchDefault;
    const { eligible, volumes } = lexicon(context.rows);
    const catalogue = volumes.map((item) => ({ book: item.volume, code: item.bookId, units: item.units }));
    const matched = book ? volumes.filter((item) => fold(item.bookId) === book || fold(item.volume) === book) : volumes;
    const chosen = book && !matched.length ? volumes.filter((item) => fold(item.volume).includes(book)) : matched;
    if (book && chosen.length !== 1) return { error: chosen.length ? "有多本教材符合这个名称，请写完整册名" : "没有这本教材", books: (chosen.length ? chosen : volumes).map((item) => ({ book: item.volume, code: item.bookId })) };
    const unit = unitText ? (/^\d+$/.test(unitText) ? `unit ${unitText}` : unitText) : undefined;
    const bookIds = new Set(chosen.map((item) => item.bookId));
    if (unit && !chosen.some((item) => item.units.some((name) => fold(name) === unit))) return { error: "没有这个单元", books: catalogue.filter((item) => bookIds.has(item.code)) };
    const rows = eligible.filter((row) =>
      (!book && !unit || row.sources.some((source) => bookIds.has(source.bookId) && (!unit || fold(source.unit) === unit)))
      && (!prefix || fold(row.headword).startsWith(prefix)) && (!meaning || fold(row.chineseCore).includes(meaning)));
    return { total: rows.length, shown: Math.min(rows.length, limit), entries: rows.slice(0, limit).map((row) => entry(row, context)) };
  },
};

const python: ToolDefinition = {
  name: "python",
  label: "算了一下",
  description: "运行一小段 Python 做精确计算：时间和天数分配、正确率和平均数、日期推算、给列表排序计数。用 print() 输出，最后一行如果是表达式也会显示结果。只支持 Python 的常用子集：数字、字符串、列表、元组、字典、集合、if/for/while、def、lambda、推导式、f-string，以及 len、sum、min、max、sorted、range、round、enumerate、zip、mean、median 和 math。日期用 today()、add_days(日期, 天数)、days_between(起, 止)、weekday(日期)（周一为 1）、weekday_name(日期)，日期写成 'YYYY-MM-DD'。没有 import（math 除外）、class、try、文件、网络和随机数；代码看不到对话内容，需要的数据要写进代码里。",
  parameters: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", maxLength: 4000, description: "要运行的代码" } } },
  run(args, context) {
    if (typeof args.code !== "string") return { error: "code 需要是一段代码" };
    const result = runPython(args.code, { today: context.today });
    return result.ok ? { output: result.output || "（没有输出；用 print() 显示结果）" } : { error: result.error, ...(result.output ? { output: result.output } : {}) };
  },
};

export const CHAT_TOOLS: readonly ToolDefinition[] = [lookupWords, searchLexicon, python];
