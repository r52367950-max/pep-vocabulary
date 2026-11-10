import type { LexiconEvidence } from "./core";

/** Tools deliberately operate only on published vocabulary and this request's selected materials. */
export type ToolLexiconRow = LexiconEvidence & { flags?: { formalReleaseEligible?: boolean } };
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
  { name: "search_lexicon", description: "搜索正式词库中的英文词头或中文释义，返回可引用的词条 ID 与教材出处。", parameters: { type: "object", properties: { query: { type: "string", maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false } },
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

const searchIndexes = new WeakMap<ToolLexiconRow[], { row: ToolLexiconRow; headword: string; meaning: string }[]>();
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().trim();
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
      case "search_lexicon": {
        const input = args(call.arguments, ["query", "limit"], ["query"]);
        const query = normalized(boundedText(input.query, 100));
        const limit = integer(input.limit, 5, 1, 8);
        const rows = await context.loadLexicon();
        let index = searchIndexes.get(rows);
        if (!index) {
          index = rows.filter(row => row.flags?.formalReleaseEligible === true).map(row => ({ row, headword: normalized(row.headword), meaning: normalized(row.chineseCore) }));
          searchIndexes.set(rows, index);
        }
        const matches: ToolLexiconRow[][] = [[], [], []];
        for (const item of index) {
          const rank = item.headword === query ? 0 : item.headword.startsWith(query) ? 1 : item.headword.includes(query) || item.meaning.includes(query) ? 2 : -1;
          if (rank >= 0) matches[rank].push(item.row);
        }
        const ordered = matches.flat();
        evidence = ordered.slice(0, limit).map(evidenceFor);
        while (JSON.stringify(evidence).length > MAX_TOOL_OUTPUT_CHARS - 500) evidence.pop();
        data = { matches: evidence, totalMatches: ordered.length, hasMore: ordered.length > evidence.length };
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
