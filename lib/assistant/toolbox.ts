import type { LexiconEvidence } from "./core";

/** Tools deliberately operate only on published vocabulary and this request's selected materials. */
export type ToolLexiconRow = LexiconEvidence & { lookup?: string; flags?: { formalReleaseEligible?: boolean } };
export type ToolSources = {
  article: { title: string; text: string } | null;
  files: { name: string; text: string }[];
  quotes: { text: string; title?: string; before?: string; after?: string }[];
};
export type ToolContext = { loadLexicon: () => Promise<ToolLexiconRow[]>; sources: ToolSources };
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ToolResult = {
  id: string; name: string; ok: boolean; data?: unknown;
  error?: { code: string; message: string }; evidence: LexiconEvidence[];
};
export const MAX_TOOL_OUTPUT_CHARS = 12000;

export const TOOL_DEFINITIONS = [
  { name: "lookup_words", description: "核对最多八个英文词或短语的教材释义与出处。精确词头优先；括号简写与可能的屈折词形会明确标记，词形候选须结合语境核对。没查到时给出词头建议。", parameters: { type: "object", properties: { words: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 60 } } }, required: ["words"], additionalProperties: false } },
  { name: "search_lexicon", description: "按英文或中文 query、册名/教材代号 book、单元 unit、词头 prefix、中文 meaning 筛选正式词库，至少提供一项。book 如 必修第一册 或 HS-R1，unit 如 Unit 2；无效名称返回可用名称。返回词条 ID、出处和匹配总数。", parameters: { type: "object", properties: { query: { type: "string", maxLength: 100 }, book: { type: "string", maxLength: 40 }, unit: { type: "string", maxLength: 40 }, prefix: { type: "string", maxLength: 20 }, meaning: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 8 } }, anyOf: [{ required: ["query"] }, { required: ["book"] }, { required: ["unit"] }, { required: ["prefix"] }, { required: ["meaning"] }], additionalProperties: false } },
  { name: "calculate", description: "计算学习时长、数量与比例。支持数字、小数、科学计数法、括号及 + - * / % ^，不运行代码。", parameters: { type: "object", properties: { expression: { type: "string", maxLength: 300 } }, required: ["expression"], additionalProperties: false } },
  { name: "text_stats", description: "统计英文词数、不同词数、句数与字符数；连字符与英文撇号连接的词计为一个。提供 text，或提供材料的 kind 与 index；已有材料优先用索引，无需复制正文。", parameters: { type: "object", properties: { text: { type: "string", maxLength: 12000 }, kind: { type: "string", enum: ["article", "file", "quote"] }, index: { type: "integer", minimum: 0, maximum: 3 } }, oneOf: [{ required: ["text"] }, { required: ["kind", "index"] }], additionalProperties: false } },
  { name: "read_source", description: "按材料清单读取本轮已选文章、文件或引用的片段。offset、length 按 JavaScript 字符索引计算；返回 totalChars 与 nextOffset。", parameters: { type: "object", properties: { kind: { type: "string", enum: ["article", "file", "quote"] }, index: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 2400 } }, required: ["kind", "index"], additionalProperties: false } },
] as const;

class ToolInputError extends Error {}
function invalid(): never { throw new ToolInputError(); }
function args(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(row, key))) return invalid();
  return row;
}
function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) return invalid();
  return value;
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

function selectedSource(sources: ToolSources, kind: unknown, indexValue: unknown) {
  if (indexValue === undefined) return invalid();
  const index = integer(indexValue, 0, 0, 3);
  const source = kind === "article" ? index === 0 ? sources.article : null
    : kind === "file" ? sources.files[index]
      : kind === "quote" ? sources.quotes[index] : null;
  if (!source) return invalid();
  return source;
}

/** A small arithmetic grammar; model text never reaches eval, Function or a shell. */
function calculate(expression: string): number {
  let cursor = 0;
  let operations = 0;
  let depth = 0;
  const whitespace = () => { while (/\s/.test(expression[cursor] ?? "") && cursor < expression.length) cursor++; };
  const checked = (value: number) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15 || ++operations > 128) return invalid();
    return value;
  };
  const atom = (): number => {
    whitespace();
    if (++depth > 24) return invalid();
    let value: number;
    if (expression[cursor] === "(") {
      cursor++;
      value = sum();
      whitespace();
      if (expression[cursor++] !== ")") return invalid();
    } else {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(cursor));
      if (!match) return invalid();
      cursor += match[0].length;
      value = checked(Number(match[0]));
    }
    depth--;
    return value;
  };
  const power = (): number => {
    const left = atom();
    whitespace();
    if (expression[cursor] !== "^") return left;
    cursor++;
    // Count recursive powers and signs together, before descending.
    if (++depth > 24) return invalid();
    const right = unary();
    depth--;
    if (Math.abs(right) > 100) return invalid();
    return checked(left ** right);
  };
  const unary = (): number => {
    whitespace();
    const sign = expression[cursor];
    if (sign !== "+" && sign !== "-") return power();
    cursor++;
    if (++depth > 24) return invalid();
    const value = unary();
    depth--;
    return checked(sign === "-" ? -value : value);
  };
  const product = (): number => {
    let value = unary();
    while (true) {
      whitespace();
      const operator = expression[cursor];
      if (operator !== "*" && operator !== "/" && operator !== "%") return value;
      cursor++;
      const right = unary();
      if ((operator === "/" || operator === "%") && right === 0) return invalid();
      value = checked(operator === "*" ? value * right : operator === "/" ? value / right : value % right);
    }
  };
  const sum = (): number => {
    let value = product();
    while (true) {
      whitespace();
      const operator = expression[cursor];
      if (operator !== "+" && operator !== "-") return value;
      cursor++;
      const right = product();
      value = checked(operator === "+" ? value + right : value - right);
    }
  };
  const value = sum();
  whitespace();
  if (cursor !== expression.length) return invalid();
  return Object.is(value, -0) ? 0 : value;
}

type LexiconIndex = {
  entries: { row: ToolLexiconRow; headword: string; meaning: string }[];
  exact: Map<string, ToolLexiconRow[]>;
  aliases: Map<string, ToolLexiconRow[]>;
  units: Map<string, string>;
  books: { bookId: string; volume: string; units: string[] }[];
};
const searchIndexes = new WeakMap<ToolLexiconRow[], LexiconIndex>();
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
function lexiconIndex(rows: ToolLexiconRow[]): LexiconIndex {
  let index = searchIndexes.get(rows);
  if (index) return index;
  const entries = rows.filter(row => row.flags?.formalReleaseEligible === true).map(row => ({ row, headword: normalized(row.headword), meaning: normalized(row.chineseCore) }));
  const exact = new Map<string, ToolLexiconRow[]>();
  const aliases = new Map<string, ToolLexiconRow[]>();
  const units = new Map<string, string>();
  const books = new Map<string, { bookId: string; volume: string; units: Set<string> }>();
  const add = (map: Map<string, ToolLexiconRow[]>, key: string, row: ToolLexiconRow) => {
    if (!key) return;
    const existing = map.get(key);
    if (existing) { if (!existing.includes(row)) existing.push(row); }
    else map.set(key, [row]);
  };
  for (const { row, headword } of entries) {
    add(exact, headword, row);
    // Only complete parenthesized phrases produce aliases; preserve the printed headword in evidence.
    for (const key of [normalized(row.lookup ?? row.headword), normalized(headword.replace(/\([^()]*\)/g, " ")), normalized(headword.replace(/\(([^()]*)\)/g, " $1 "))]) {
      if (key !== headword) add(aliases, key, row);
    }
    for (const source of row.sources) {
      if (!units.has(source.unit)) units.set(source.unit, normalized(source.unit));
      let book = books.get(source.bookId);
      if (!book) { book = { bookId: source.bookId, volume: source.volume, units: new Set() }; books.set(source.bookId, book); }
      book.units.add(source.unit);
    }
  }
  index = { entries, exact, aliases, units, books: [...books.values()].map(book => ({ ...book, units: [...book.units].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) })) };
  searchIndexes.set(rows, index);
  return index;
}

/** Orthographic candidates, never a claim that a word is the queried lemma. */
function possibleBaseForms(word: string): string[] {
  if (!/^[a-z]{3,60}$/.test(word)) return [];
  const forms = new Set<string>();
  const addStem = (stem: string) => {
    if (stem.length < 2) return;
    forms.add(stem);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) forms.add(stem.slice(0, -1));
  };
  if (/i(?:es|ed)$/.test(word)) forms.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ing")) { addStem(word.slice(0, -3)); forms.add(`${word.slice(0, -3)}e`); }
  if (word.endsWith("ed")) { addStem(word.slice(0, -2)); forms.add(word.slice(0, -1)); }
  if (word.endsWith("es")) forms.add(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) forms.add(word.slice(0, -1));
  return [...forms].filter(form => form.length >= 2 && form !== word);
}

function bookSuggestions(books: LexiconIndex["books"], includeUnits: boolean) {
  const suggestions = books.slice(0, 16).map(book => ({ bookId: book.bookId.slice(0, 80), volume: book.volume.slice(0, 80),
    ...(includeUnits ? { units: book.units.slice(0, 16).map(unit => unit.slice(0, 40)) } : {}) }));
  while (JSON.stringify(suggestions).length > 4000) suggestions.pop();
  return suggestions;
}
function evidenceFor(row: ToolLexiconRow): LexiconEvidence {
  return {
    id: row.id, headword: row.headword.slice(0, 128), chineseCore: row.chineseCore.slice(0, 400),
    partsOfSpeech: row.partsOfSpeech.slice(0, 8).map(value => value.slice(0, 30)),
    scopes: row.scopes.slice(0, 8).map(value => value.slice(0, 60)),
    sources: row.sources.slice(0, 3).map(source => ({
      bookId: source.bookId.slice(0, 100), volume: source.volume.slice(0, 100), unit: source.unit.slice(0, 100), printedPage: source.printedPage,
    })),
  };
}

export function toolSourceManifest(sources: ToolSources) {
  return [
    ...(sources.article ? [{ kind: "article" as const, index: 0, title: sources.article.title, chars: sources.article.text.length }] : []),
    ...sources.files.map((file, index) => ({ kind: "file" as const, index, title: file.name, chars: file.text.length })),
    ...sources.quotes.map((quote, index) => ({ kind: "quote" as const, index, title: quote.title || `引用 ${index + 1}`, chars: quote.text.length })),
  ];
}

/** Errors contain no source text or internal exception details. */
export async function executeTool(call: ToolCall, context: ToolContext): Promise<ToolResult> {
  const base = {
    id: typeof call.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(call.id) ? call.id : "invalid",
    name: typeof call.name === "string" && /^[a-z_]{1,40}$/.test(call.name) ? call.name : "invalid",
  };
  try {
    if (base.id !== call.id || base.name !== call.name) return invalid();
    let data: unknown;
    let evidence: LexiconEvidence[] = [];
    switch (call.name) {
      case "calculate": {
        const input = args(call.arguments, ["expression"], ["expression"]);
        data = { value: calculate(boundedText(input.expression, 300)), precision: "IEEE-754 double" };
        break;
      }
      case "text_stats": {
        const input = args(call.arguments, ["text", "kind", "index"], []);
        const hasText = Object.hasOwn(input, "text");
        if (hasText && (Object.hasOwn(input, "kind") || Object.hasOwn(input, "index"))) return invalid();
        const text = boundedText(hasText ? input.text : selectedSource(context.sources, input.kind, input.index).text, 12000);
        const words = text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) ?? [];
        data = { characters: [...text].length, words: words.length, uniqueWords: new Set(words.map(word => word.toLowerCase().replaceAll("’", "'"))).size,
          sentences: text.split(/[.!?。！？]+/).filter(part => /[\p{L}\p{N}]/u.test(part)).length };
        break;
      }
      case "read_source": {
        const input = args(call.arguments, ["kind", "index", "offset", "length"], ["kind", "index"]);
        const source = selectedSource(context.sources, input.kind, input.index);
        const offset = integer(input.offset, 0, 0, 12000);
        const length = integer(input.length, 1600, 1, 2400);
        if (offset > source.text.length) return invalid();
        const end = Math.min(source.text.length, offset + length);
        data = { kind: input.kind, index: input.index, title: "name" in source ? source.name : source.title ?? "引用", text: source.text.slice(offset, end),
          offset, totalChars: source.text.length, nextOffset: end < source.text.length ? end : null };
        break;
      }
      case "lookup_words": {
        const input = args(call.arguments, ["words"], ["words"]);
        if (!Array.isArray(input.words) || !input.words.length || input.words.length > 8) return invalid();
        const queries = [...new Set(input.words.map(word => normalized(boundedText(word, 60))))];
        const index = lexiconIndex(await context.loadLexicon());
        const results = queries.map(query => {
          const exact = index.exact.get(query);
          const alias = exact ? undefined : index.aliases.get(query);
          const candidates = exact || alias ? [] : possibleBaseForms(query).flatMap(form => index.exact.get(form) ?? []);
          const rows = [...new Map((exact ?? alias ?? candidates).map(row => [row.id, row])).values()];
          const match = exact ? "exact" : alias ? "normalized" : candidates.length ? "possible_inflection" : "not_found";
          const stem = query.slice(0, Math.min(4, query.length - 1));
          const suggestions: string[] = [];
          if (!rows.length && stem.length >= 3) for (const item of index.entries) {
            if (item.headword.startsWith(stem)) suggestions.push(item.row.headword.slice(0, 128));
            if (suggestions.length === 4) break;
          }
          return { query, match, matches: rows.slice(0, 3).map(evidenceFor), truncated: rows.length > 3,
            ...(match === "possible_inflection" ? { note: "未匹配精确词头；这些是可能的词形候选，请结合语境核对。" } : {}),
            ...(suggestions.length ? { suggestions } : {}) };
        });
        // Retain every query's status when a large multi-word lookup reaches the result budget.
        while (JSON.stringify(results).length > MAX_TOOL_OUTPUT_CHARS - 200) {
          const largest = results.reduce((left, right) => JSON.stringify(left.matches).length >= JSON.stringify(right.matches).length ? left : right);
          if (!largest.matches.length) return invalid();
          largest.matches.pop(); largest.truncated = true;
        }
        evidence = [...new Map(results.flatMap(result => result.matches).map(row => [row.id, row])).values()];
        data = { results };
        break;
      }
      case "search_lexicon": {
        const input = args(call.arguments, ["query", "book", "unit", "prefix", "meaning", "limit"], []);
        const optional = (name: string, maximum: number) => input[name] === undefined ? undefined : normalized(boundedText(input[name], maximum));
        const query = optional("query", 100), book = optional("book", 40), unitText = optional("unit", 40), prefix = optional("prefix", 20), meaning = optional("meaning", 40);
        if (!query && !book && !unitText && !prefix && !meaning) return invalid();
        const unit = unitText && /^\d+$/.test(unitText) ? `unit ${Number(unitText)}` : unitText;
        const limit = integer(input.limit, 5, 1, 8);
        const index = lexiconIndex(await context.loadLexicon());
        const exactBooks = book ? index.books.filter(item => normalized(item.bookId) === book || normalized(item.volume) === book) : index.books;
        const chosen = book && !exactBooks.length ? index.books.filter(item => normalized(item.volume).includes(book)) : exactBooks;
        if (book && chosen.length !== 1) {
          return { ...base, ok: false, error: { code: chosen.length ? "ambiguous_book" : "unknown_book", message: chosen.length ? "有多本教材符合，请使用完整册名或教材代号。" : "没有这本教材，请从可用名称中选择。" }, data: { books: bookSuggestions(chosen.length ? chosen : index.books, false) }, evidence: [] };
        }
        if (unit && !chosen.some(item => item.units.some(name => index.units.get(name) === unit))) {
          return { ...base, ok: false, error: { code: "unknown_unit", message: "所选教材没有这个单元，请从可用名称中选择。" }, data: { books: bookSuggestions(chosen, true) }, evidence: [] };
        }
        const bookIds = new Set(chosen.map(item => item.bookId));
        const sourceMatches = (source: ToolLexiconRow["sources"][number]) => bookIds.has(source.bookId) && (!unit || index.units.get(source.unit) === unit);
        const matches: ToolLexiconRow[][] = [[], [], []];
        let totalMatches = 0;
        for (const item of index.entries) {
          if ((book || unit) && !item.row.sources.some(sourceMatches)) continue;
          if (prefix && !item.headword.startsWith(prefix) || meaning && !item.meaning.includes(meaning)) continue;
          const rank = !query || item.headword === query ? 0 : item.headword.startsWith(query) ? 1 : item.headword.includes(query) || item.meaning.includes(query) ? 2 : -1;
          if (rank >= 0) {
            totalMatches++;
            if (matches[rank].length < limit) matches[rank].push(item.row);
          }
        }
        const ordered = matches.flat();
        evidence = ordered.slice(0, limit).map(row => evidenceFor(book || unit
          ? { ...row, sources: [...row.sources].sort((left, right) => Number(sourceMatches(right)) - Number(sourceMatches(left))) } : row));
        while (JSON.stringify(evidence).length > MAX_TOOL_OUTPUT_CHARS - 500) evidence.pop();
        data = { matches: evidence, totalMatches, hasMore: totalMatches > evidence.length };
        break;
      }
      default: return { ...base, ok: false, error: { code: "unknown_tool", message: "没有这个工具。" }, evidence: [] };
    }
    if (JSON.stringify(data).length > MAX_TOOL_OUTPUT_CHARS) return invalid();
    return { ...base, ok: true, data, evidence };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof ToolInputError
      ? { code: "invalid_arguments", message: "工具参数无效或超出限制，请按工具说明调整。" }
      : { code: "tool_unavailable", message: "工具暂时不可用。" }, evidence: [] };
  }
}
