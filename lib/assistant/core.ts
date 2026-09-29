import { ASSISTANT_TASKS, buildUserMessage, SYSTEM_PROMPT, type AssistantTask } from "./prompt";

export { ASSISTANT_TASKS, type AssistantTask };
export type AiProvider = "deepseek" | "openai-compatible";

export type LexiconEvidence = {
  id: string;
  headword: string;
  chineseCore: string;
  partsOfSpeech: string[];
  scopes: string[];
  sources: Array<{
    bookId: string;
    volume: string;
    unit: string;
    printedPage: number | null;
  }>;
};

type LexiconEvidenceRow = LexiconEvidence & {
  flags?: { formalReleaseEligible?: boolean };
};

export type ParsedAssistantRequest =
  | {
      task: "explain";
      wordIds: string[];
      focus: "meaning" | "grammar" | "collocation" | "exam" | "mistakes" | "general";
      masteryTags: string[];
    }
  | {
      task: "check-sentence";
      wordIds: string[];
      sentence: string;
      masteryTags: string[];
    }
  | {
      task: "generate-practice";
      wordIds: string[];
      skill: "meaning" | "listening" | "spelling" | "context" | "collocation" | "output";
      difficulty: "foundation" | "standard" | "challenge";
      count: number;
      masteryTags: string[];
    }
  | {
      task: "contrast-words";
      wordIds: string[];
      masteryTags: string[];
    }
  | {
      task: "review-essay";
      wordIds: string[];
      genre: "practical" | "continuation" | "free";
      prompt: string | null;
      essay: string;
      masteryTags: string[];
    }
  | {
      task: "mnemonic";
      wordIds: string[];
      masteryTags: string[];
    }
  | {
      task: "story";
      wordIds: string[];
      level: "A2" | "B1" | "B2";
      length: "short" | "medium";
      theme: string | null;
      masteryTags: string[];
    }
  | {
      task: "diagnose";
      wordIds: string[];
      masteryTags: string[];
    };

export class AssistantInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AssistantInputError";
    this.code = code;
    this.status = status;
  }
}

export class AssistantUpstreamError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerStatus: number | null;
  readonly networkReason: "dns" | "tls" | "connection" | "invalid_header" | "unknown" | null;

  constructor(
    code: string,
    message: string,
    status: number,
    retryable: boolean,
    providerStatus: number | null = null,
    networkReason: "dns" | "tls" | "connection" | "invalid_header" | "unknown" | null = null,
  ) {
    super(message);
    this.name = "AssistantUpstreamError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.providerStatus = providerStatus;
    this.networkReason = networkReason;
  }
}

const WORD_ID = /^pep-[a-f0-9]{16}$/;
const MASTERY_TAGS = new Set([
  "meaning-weak",
  "listening-weak",
  "spelling-weak",
  "context-weak",
  "collocation-weak",
  "output-weak",
  "recent-error",
  "new-word",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantInputError("invalid_request", "请求必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string") {
    throw new AssistantInputError("invalid_request", `${field} 必须是字符串。`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new AssistantInputError("invalid_request", `${field} 长度应为 ${minimum}–${maximum} 个字符。`);
  }
  return normalized;
}

function wordIds(value: unknown, minimum: number, maximum: number): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) {
    throw new AssistantInputError("invalid_request", "wordId 或 wordIds 格式不正确。");
  }
  const normalized = [...new Set(values.map((item) => boundedString(item, "wordId", 32)))];
  if (normalized.length < minimum || normalized.length > maximum || normalized.some((id) => !WORD_ID.test(id))) {
    throw new AssistantInputError("invalid_request", `词条数量应为 ${minimum}–${maximum}，且必须使用正式词库 ID。`);
  }
  return normalized;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function masteryTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new AssistantInputError("invalid_request", "masteryTags 最多包含 8 个受支持标签。");
  }
  return [...new Set(value.map((item) => boundedString(item, "masteryTag", 32)))].filter((item) => MASTERY_TAGS.has(item));
}

export function parseAssistantRequest(task: AssistantTask, value: unknown): ParsedAssistantRequest {
  const body = record(value);
  const tags = masteryTags(body.masteryTags);

  if (task === "explain") {
    return {
      task,
      wordIds: wordIds(body.wordId ?? body.wordIds, 1, 1),
      focus: enumValue(body.focus, ["meaning", "grammar", "collocation", "exam", "mistakes", "general"] as const, "general"),
      masteryTags: tags,
    };
  }

  if (task === "check-sentence") {
    return {
      task,
      wordIds: wordIds(body.wordId ?? body.wordIds, 1, 1),
      sentence: boundedString(body.sentence, "sentence", 600, 2),
      masteryTags: tags,
    };
  }

  if (task === "generate-practice") {
    const requestedCount = typeof body.count === "number" && Number.isInteger(body.count) ? body.count : 4;
    if (requestedCount < 1 || requestedCount > 10) {
      throw new AssistantInputError("invalid_request", "count 必须是 1–10 的整数。");
    }
    return {
      task,
      wordIds: wordIds(body.wordIds ?? body.wordId, 1, 10),
      skill: enumValue(body.skill, ["meaning", "listening", "spelling", "context", "collocation", "output"] as const, "context"),
      difficulty: enumValue(body.difficulty, ["foundation", "standard", "challenge"] as const, "standard"),
      count: requestedCount,
      masteryTags: tags,
    };
  }

  if (task === "review-essay") {
    return {
      task,
      wordIds: body.wordIds === undefined || (Array.isArray(body.wordIds) && !body.wordIds.length) ? [] : wordIds(body.wordIds, 1, 12),
      genre: enumValue(body.genre, ["practical", "continuation", "free"] as const, "free"),
      prompt: body.prompt === undefined || body.prompt === "" ? null : boundedString(body.prompt, "prompt", 1200),
      essay: boundedString(body.essay, "essay", 8000, 20),
      masteryTags: tags,
    };
  }

  if (task === "mnemonic") return { task, wordIds: wordIds(body.wordId ?? body.wordIds, 1, 1), masteryTags: tags };

  if (task === "story") {
    return {
      task,
      wordIds: wordIds(body.wordIds, 3, 12),
      level: enumValue(body.level, ["A2", "B1", "B2"] as const, "B1"),
      length: enumValue(body.length, ["short", "medium"] as const, "short"),
      theme: body.theme === undefined || body.theme === "" ? null : boundedString(body.theme, "theme", 80),
      masteryTags: tags,
    };
  }

  if (task === "diagnose") {
    return {
      task,
      wordIds: body.wordIds === undefined || (Array.isArray(body.wordIds) && !body.wordIds.length) ? [] : wordIds(body.wordIds, 1, 20),
      masteryTags: tags,
    };
  }

  return {
    task,
    wordIds: wordIds(body.wordIds ?? body.wordId, 2, 4),
    masteryTags: tags,
  };
}

export function resolveLexiconEvidence(rows: LexiconEvidenceRow[], ids: string[]): LexiconEvidence[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row || row.flags?.formalReleaseEligible !== true) {
      throw new AssistantInputError("evidence_unavailable", `词条 ${id} 没有可用于 AI 的正式词库证据。`, 422);
    }
    return {
      id: row.id,
      headword: row.headword,
      chineseCore: row.chineseCore,
      partsOfSpeech: row.partsOfSpeech.slice(0, 8),
      scopes: row.scopes.slice(0, 8),
      sources: row.sources.slice(0, 12).map((source) => ({
        bookId: source.bookId,
        volume: source.volume,
        unit: source.unit,
        printedPage: typeof source.printedPage === "number" ? source.printedPage : null,
      })),
    };
  });
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function privateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  return hostname.startsWith("::") || hostname.startsWith("64:ff9b:") || hostname.startsWith("2002:") ||
    hostname.includes(".") || hostname.startsWith("fc") || hostname.startsWith("fd") ||
    /^fe[89a-f]/.test(hostname) || hostname.startsWith("ff");
}

function localHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return (!host.includes(".") && !host.includes(":")) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || privateIpv4(host) || privateIpv6(host);
}

export function normalizeBaseUrl(raw: string, allowInsecureLocal = false): string {
  const input = boundedString(raw, "baseUrl", 500);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AssistantInputError("invalid_base_url", "Base URL 不是有效网址。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AssistantInputError("invalid_base_url", "Base URL 不能包含账号、密码、查询参数或片段。");
  }
  const isLocal = localHostname(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocal && url.protocol === "http:" && isLocal)) {
    throw new AssistantInputError("invalid_base_url", "Base URL 必须使用 HTTPS；本地 HTTP 需要服务端显式允许。");
  }
  if (isLocal && !(allowInsecureLocal && url.protocol === "http:")) {
    throw new AssistantInputError("invalid_base_url", "Base URL 不能指向本机或私有网络地址。");
  }
  return url.toString().replace(/\/$/, "");
}

export function chatCompletionsUrl(baseUrl: string, provider?: AiProvider): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (provider === "deepseek" && url.hostname === "api.deepseek.com" && (path === "" || path === "/v1")) {
    url.pathname = "/v1/chat/completions";
  } else {
    url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  }
  return url.toString();
}

export function connectionEndpointCandidates(provider: AiProvider, baseUrl: string): string[] {
  const primary = chatCompletionsUrl(baseUrl, provider);
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (provider !== "deepseek" || url.hostname !== "api.deepseek.com" || (path !== "" && path !== "/v1")) {
    return [primary];
  }
  url.pathname = "/chat/completions";
  return [...new Set([primary, url.toString()])];
}

export function sameAiCredentialScope(
  current: { provider: AiProvider; baseUrl: string },
  next: { provider: AiProvider; baseUrl: string },
): boolean {
  return current.provider === next.provider && current.baseUrl === next.baseUrl;
}

/**
 * System prompt first (identical for every request), then the learner profile, then this task.
 * See ./prompt.ts for why the order matters for provider-side prompt caching.
 */
export function buildAssistantPrompt(request: ParsedAssistantRequest, evidence: LexiconEvidence[], profile: unknown = null) {
  const { task, ...input } = request;
  return { system: SYSTEM_PROMPT, user: buildUserMessage(profile, task, input, evidence) };
}

function cleanOutputText(value: unknown, field: string, maximum = 2000): string {
  if (typeof value !== "string") throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 格式不正确。`, 502, true);
  const result = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!result || result.length > maximum) throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 长度异常。`, 502, true);
  return result;
}

function outputRecord(value: unknown, field = "result"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 不是对象。`, 502, true);
  }
  return value as Record<string, unknown>;
}

function outputStringArray(value: unknown, field: string, maximumItems = 8, itemLength = 600): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 格式不正确。`, 502, true);
  }
  return value.map((item, index) => cleanOutputText(item, `${field}[${index}]`, itemLength));
}

function outputEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 格式不正确。`, 502, true);
}

function outputEvidenceIds(value: unknown, allowedIds: Set<string>, field = "evidenceIds"): string[] {
  if (!allowedIds.size && (value === undefined || (Array.isArray(value) && !value.length))) return [];
  const ids = outputStringArray(Array.isArray(value) ? [...new Set(value)] : value, field, Math.max(1, allowedIds.size), 32);
  const unique = [...new Set(ids)];
  if (!unique.length || unique.some((id) => !allowedIds.has(id))) {
    throw new AssistantUpstreamError("evidence_violation", "模型引用了请求证据之外的词条。", 502, false);
  }
  return unique;
}

function statusBlock(value: unknown, field: string) {
  const item = outputRecord(value, field);
  const status = outputEnum(item.status, ["ok", "issue", "uncertain"] as const, `${field}.status`);
  return { status, feedback: cleanOutputText(item.feedback, `${field}.feedback`, 1000) };
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return cleanOutputText(value, field, maximum);
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (trimmed.length > 300_000) throw new AssistantUpstreamError("model_response_too_large", "模型返回内容过大。", 502, true);
  try {
    return outputRecord(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof AssistantUpstreamError) throw error;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return outputRecord(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        // Fall through to the normalized error below.
      }
    }
    throw new AssistantUpstreamError("invalid_model_response", "模型没有返回有效 JSON。", 502, true);
  }
}

function assertEvidenceClaims(value: unknown, evidence: LexiconEvidence[], studentText = "") {
  const text = JSON.stringify(value);
  const textbookAttribution = /(?:教材|课本|课文)[^。；\n]{0,40}(?:原句|原文|摘录|摘自|引用|引自|写道|出自)|(?:原句|原文|摘录|摘自|引用|引自|出自)[^。；\n]{0,40}(?:教材|课本|课文)/;
  if (textbookAttribution.test(text)) {
    throw new AssistantUpstreamError("evidence_violation", "模型把生成内容误称为教材原句。", 502, false);
  }
  const allowedPages = new Set(evidence.flatMap((item) => item.sources.map((source) => source.printedPage).filter((page): page is number => typeof page === "number")));
  const pageClaims = [
    ...[...text.matchAll(/(\d{1,3})\s*页/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(/\b(?:page\s+|p\.\s*)(\d{1,3})\b/gi)].map((match) => Number(match[1])),
  ];
  // A page number the student wrote may be quoted back in feedback or the revised essay.
  const studentPages = new Set([...studentText.matchAll(/\d{1,3}/g)].map((match) => Number(match[0])));
  if (pageClaims.some((page) => !allowedPages.has(page) && !studentPages.has(page))) {
    throw new AssistantUpstreamError("evidence_violation", "模型返回了词库证据中不存在的教材页码。", 502, false);
  }
}

const personalNote = (value: unknown) => nullableText(value, "personalNote", 1500);
const items = (value: unknown, field: string, maximum: number) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 格式不正确。`, 502, true);
  return value.slice(0, maximum);
};
const outputInteger = (value: unknown, field: string, low: number, high: number) => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) throw new AssistantUpstreamError("invalid_model_response", `模型返回的 ${field} 不是数字。`, 502, true);
  return Math.min(high, Math.max(low, Math.round(number)));
};
const squash = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export function sanitizeModelResult(task: AssistantTask, content: string, evidence: LexiconEvidence[], maximumItems = 8, request?: ParsedAssistantRequest) {
  const raw = parseJsonObject(content);
  const allowedIds = new Set(evidence.map((item) => item.id));
  const evidenceIds = outputEvidenceIds(raw.evidenceIds, allowedIds);
  const limitations = raw.limitations === undefined ? [] : outputStringArray(items(raw.limitations, "limitations", 8), "limitations", 8, 800);
  const allowedWord = (value: unknown, field: string) => {
    const id = cleanOutputText(value, field, 32);
    if (!allowedIds.has(id)) throw new AssistantUpstreamError("evidence_violation", "模型引用了请求证据之外的词条。", 502, false);
    return id;
  };
  let result: Record<string, unknown>;
  let studentText = "";

  if (task === "explain") {
    result = {
      kind: task,
      summary: cleanOutputText(raw.summary, "summary", 4000),
      meaning: outputStringArray(items(raw.meaning, "meaning", 10), "meaning", 10, 1500),
      grammar: outputStringArray(items(raw.grammar, "grammar", 10), "grammar", 10, 1500),
      collocations: outputStringArray(items(raw.collocations, "collocations", 12), "collocations", 12, 1500),
      examples: items(raw.examples, "examples", 5).map((value, index) => {
        const item = outputRecord(value, `examples[${index}]`);
        return {
          sentence: cleanOutputText(item.sentence, `examples[${index}].sentence`, 800),
          translation: cleanOutputText(item.translation, `examples[${index}].translation`, 800),
          origin: "model-generated" as const,
        };
      }),
      personalNote: personalNote(raw.personalNote),
      evidenceIds,
      limitations,
    };
  } else if (task === "check-sentence") {
    studentText = request?.task === "check-sentence" ? request.sentence : "";
    result = {
      kind: task,
      verdict: outputEnum(raw.verdict, ["correct", "needs-revision", "uncertain"] as const, "verdict"),
      grammar: statusBlock(raw.grammar, "grammar"),
      collocation: statusBlock(raw.collocation, "collocation"),
      style: statusBlock(raw.style, "style"),
      revision: nullableText(raw.revision, "revision", 1200),
      personalNote: personalNote(raw.personalNote),
      evidenceIds,
      limitations,
    };
  } else if (task === "generate-practice") {
    if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > maximumItems) {
      throw new AssistantUpstreamError("invalid_model_response", "模型返回的练习数量不正确。", 502, true);
    }
    result = {
      kind: task,
      title: cleanOutputText(raw.title, "title", 160),
      focusReason: nullableText(raw.focusReason, "focusReason", 800),
      items: raw.items.map((value, index) => {
        const item = outputRecord(value, `items[${index}]`);
        const type = outputEnum(item.type, ["choice", "gap", "rewrite", "sentence"] as const, `items[${index}].type`);
        const options = item.options === undefined || item.options === null ? [] : outputStringArray(item.options, `items[${index}].options`, 6, 400);
        const answer = cleanOutputText(item.answer, `items[${index}].answer`, 800);
        if (type === "choice" && (options.length < 2 || !options.includes(answer))) {
          throw new AssistantUpstreamError("invalid_model_response", "模型返回的选择题答案不在选项中。", 502, true);
        }
        return {
          type,
          prompt: cleanOutputText(item.prompt, `items[${index}].prompt`, 1200),
          options,
          answer,
          explanation: cleanOutputText(item.explanation, `items[${index}].explanation`, 1500),
          evidenceIds: outputEvidenceIds(item.evidenceIds, allowedIds, `items[${index}].evidenceIds`),
        };
      }),
      evidenceIds,
      limitations,
    };
  } else if (task === "contrast-words") {
    if (!Array.isArray(raw.differences) || !raw.differences.length || raw.differences.length > 4) {
      throw new AssistantUpstreamError("invalid_model_response", "模型返回的辨析词条数量不正确。", 502, true);
    }
    const differences = raw.differences.map((value, index) => {
      const item = outputRecord(value, `differences[${index}]`);
      const wordId = cleanOutputText(item.wordId, `differences[${index}].wordId`, 32);
      if (!allowedIds.has(wordId)) throw new AssistantUpstreamError("evidence_violation", "模型辨析了请求范围之外的词条。", 502, false);
      return {
        wordId,
        use: cleanOutputText(item.use, `differences[${index}].use`, 1500),
        pattern: cleanOutputText(item.pattern, `differences[${index}].pattern`, 1000),
        contrast: cleanOutputText(item.contrast, `differences[${index}].contrast`, 1500),
      };
    });
    const differenceIds = new Set(differences.map((item) => item.wordId));
    if (differences.length !== allowedIds.size || differenceIds.size !== allowedIds.size || [...allowedIds].some((id) => !differenceIds.has(id))) {
      throw new AssistantUpstreamError("evidence_violation", "模型没有逐一辨析请求中的全部词条。", 502, false);
    }
    result = {
      kind: task,
      summary: cleanOutputText(raw.summary, "summary", 3000),
      differences,
      examplePairs: items(raw.examplePairs, "examplePairs", 6).map((value, index) => {
        const item = outputRecord(value, `examplePairs[${index}]`);
        return {
          sentences: outputStringArray(item.sentences, `examplePairs[${index}].sentences`, 4, 800),
          note: cleanOutputText(item.note, `examplePairs[${index}].note`, 1200),
          origin: "model-generated" as const,
        };
      }),
      personalNote: personalNote(raw.personalNote),
      evidenceIds,
      limitations,
    };
  } else if (task === "review-essay") {
    const essay = request?.task === "review-essay" ? request.essay : "";
    studentText = essay;
    const haystack = squash(essay);
    const located = (quote: string) => !essay || haystack.includes(squash(quote));
    const scores = outputRecord(raw.scores, "scores");
    let dropped = 0;
    const issues = items(raw.issues, "issues", 40).flatMap((value, index) => {
      const item = outputRecord(value, `issues[${index}]`);
      const quote = cleanOutputText(item.quote, `issues[${index}].quote`, 400);
      // Feedback must point at text the student actually wrote.
      if (!located(quote)) { dropped++; return []; }
      return [{
        quote,
        type: outputEnum(item.type, ["grammar", "spelling", "word-choice", "collocation", "coherence", "punctuation", "style"] as const, `issues[${index}].type`),
        suggestion: cleanOutputText(item.suggestion, `issues[${index}].suggestion`, 800),
        reason: cleanOutputText(item.reason, `issues[${index}].reason`, 1200),
      }];
    });
    const upgrades = items(raw.upgrades, "upgrades", 12).flatMap((value, index) => {
      const item = outputRecord(value, `upgrades[${index}]`);
      const original = cleanOutputText(item.original, `upgrades[${index}].original`, 400);
      if (!located(original)) { dropped++; return []; }
      return [{ original, better: cleanOutputText(item.better, `upgrades[${index}].better`, 600), note: cleanOutputText(item.note, `upgrades[${index}].note`, 1000) }];
    });
    const seen = new Set<string>();
    const targetWords = items(raw.targetWords, "targetWords", 12).flatMap((value, index) => {
      const item = outputRecord(value, `targetWords[${index}]`);
      const wordId = allowedWord(item.wordId, `targetWords[${index}].wordId`);
      if (seen.has(wordId)) return [];
      seen.add(wordId);
      return [{ wordId, status: outputEnum(item.status, ["good", "issue", "missing"] as const, `targetWords[${index}].status`), note: cleanOutputText(item.note, `targetWords[${index}].note`, 1000) }];
    });
    const outOf = request?.task === "review-essay" && request.genre === "practical" ? 15 : 25;
    result = {
      kind: task,
      overall: cleanOutputText(raw.overall, "overall", 2000),
      scores: Object.fromEntries((["content", "vocabulary", "grammar", "structure"] as const).map((key) => [key, outputInteger(scores[key], `scores.${key}`, 0, 5)])),
      estimatedScore: outputInteger(raw.estimatedScore, "estimatedScore", 0, outOf),
      outOf,
      issues,
      targetWords,
      upgrades,
      revised: cleanOutputText(raw.revised, "revised", 12000),
      nextSteps: outputStringArray(items(raw.nextSteps, "nextSteps", 6), "nextSteps", 6, 800),
      evidenceIds,
      limitations: dropped ? [...limitations, `已略去 ${dropped} 条无法在原文中定位的批注。`] : limitations,
    };
  } else if (task === "mnemonic") {
    result = {
      kind: task,
      breakdown: items(raw.breakdown, "breakdown", 6).map((value, index) => {
        const item = outputRecord(value, `breakdown[${index}]`);
        return { part: cleanOutputText(item.part, `breakdown[${index}].part`, 60), meaning: cleanOutputText(item.meaning, `breakdown[${index}].meaning`, 300) };
      }),
      memoryHook: cleanOutputText(raw.memoryHook, "memoryHook", 800),
      story: cleanOutputText(raw.story, "story", 1500),
      family: outputStringArray(items(raw.family, "family", 6), "family", 6, 80),
      confidence: outputEnum(raw.confidence, ["high", "medium", "low"] as const, "confidence"),
      evidenceIds,
      limitations,
    };
  } else if (task === "story") {
    const paragraphs = outputStringArray(items(raw.paragraphs, "paragraphs", 12), "paragraphs", 12, 3000);
    if (!paragraphs.length) throw new AssistantUpstreamError("invalid_model_response", "模型没有返回短文。", 502, true);
    const used = new Set<string>();
    for (const [index, id] of items(raw.usedWordIds, "usedWordIds", 12).entries()) used.add(allowedWord(id, `usedWordIds[${index}]`));
    result = {
      kind: task,
      title: cleanOutputText(raw.title, "title", 160),
      paragraphs,
      usedWordIds: [...used],
      glossary: items(raw.glossary, "glossary", 12).map((value, index) => {
        const item = outputRecord(value, `glossary[${index}]`);
        return { wordId: allowedWord(item.wordId, `glossary[${index}].wordId`), meaningInContext: cleanOutputText(item.meaningInContext, `glossary[${index}].meaningInContext`, 300) };
      }),
      questions: items(raw.questions, "questions", 4).map((value, index) => {
        const item = outputRecord(value, `questions[${index}]`);
        const options = outputStringArray(item.options, `questions[${index}].options`, 5, 400);
        if (options.length < 2) throw new AssistantUpstreamError("invalid_model_response", "模型返回的理解题选项不足。", 502, true);
        return {
          prompt: cleanOutputText(item.prompt, `questions[${index}].prompt`, 600),
          options,
          answerIndex: outputInteger(item.answerIndex, `questions[${index}].answerIndex`, 0, options.length - 1),
          explanation: cleanOutputText(item.explanation, `questions[${index}].explanation`, 1000),
        };
      }),
      evidenceIds,
      limitations,
    };
  } else {
    result = {
      kind: task,
      summary: cleanOutputText(raw.summary, "summary", 3000),
      strengths: outputStringArray(items(raw.strengths, "strengths", 6), "strengths", 6, 800),
      problems: items(raw.problems, "problems", 6).map((value, index) => {
        const item = outputRecord(value, `problems[${index}]`);
        return {
          pattern: cleanOutputText(item.pattern, `problems[${index}].pattern`, 400),
          evidence: cleanOutputText(item.evidence, `problems[${index}].evidence`, 800),
          advice: cleanOutputText(item.advice, `problems[${index}].advice`, 1200),
        };
      }),
      plan: items(raw.plan, "plan", 7).map((value, index) => {
        const item = outputRecord(value, `plan[${index}]`);
        return {
          day: cleanOutputText(item.day, `plan[${index}].day`, 40),
          focus: cleanOutputText(item.focus, `plan[${index}].focus`, 600),
          minutes: outputInteger(item.minutes, `plan[${index}].minutes`, 0, 240),
        };
      }),
      wordsToFocus: items(raw.wordsToFocus, "wordsToFocus", 20).map((id, index) => allowedWord(id, `wordsToFocus[${index}]`)),
      evidenceIds,
      limitations,
    };
  }

  result.origin = "model-generated";
  assertEvidenceClaims(result, evidence, studentText);
  return result;
}

/** Every assistant task asks for up to this many output tokens, unless the model allows fewer. */
export const OUTPUT_TOKEN_TARGET = 10_000;

// Documented maximum output tokens per model family. Unknown models use the target and
// can be capped in settings. DeepSeek V4/V4.1 (deepseek-flash, deepseek-v4-*) allow 384K.
const MODEL_OUTPUT_LIMITS: Array<[RegExp, number]> = [
  [/^deepseek-(?:flash|pro|v4)/, 393_216],
  [/^deepseek-reasoner$/, 65_536],
  [/^deepseek-chat$/, 8_192],
  [/^gpt-4\.1/, 32_768],
  [/^gpt-4o/, 16_384],
  [/^gpt-4-turbo|^gpt-4-\d{4}/, 4_096],
  [/^gpt-3\.5/, 4_096],
  [/^(?:o\d|gpt-5)/, 100_000],
];

export function knownOutputLimit(model: string): number | null {
  const name = model.toLowerCase().split("/").pop() || "";
  return MODEL_OUTPUT_LIMITS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

export function resolveMaxOutputTokens(model: string, configuredCap?: number | null) {
  return Math.max(256, Math.min(OUTPUT_TOKEN_TARGET, knownOutputLimit(model) ?? OUTPUT_TOKEN_TARGET, configuredCap || OUTPUT_TOKEN_TARGET));
}

const TEMPERATURE: Record<AssistantTask, number> = {
  explain: 0.4, "check-sentence": 0.2, "generate-practice": 0.6, "contrast-words": 0.3,
  "review-essay": 0.2, mnemonic: 0.8, story: 0.9, diagnose: 0.3,
};

export type UpstreamOptions = { maxTokens?: number; stream?: boolean; baseUrl?: string; cacheKey?: string };

export function upstreamPayload(model: string, prompt: { system: string; user: string }, task: AssistantTask, provider?: AiProvider, options: UpstreamOptions = {}) {
  const maxTokens = options.maxTokens ?? resolveMaxOutputTokens(model);
  const host = options.baseUrl ? new URL(options.baseUrl).hostname : "";
  const officialOpenAI = host === "api.openai.com";
  // Newer OpenAI reasoning models reject max_tokens.
  const tokenField = officialOpenAI && /^(?:o\d|gpt-5)/.test(model) ? "max_completion_tokens" : "max_tokens";
  return {
    model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    temperature: TEMPERATURE[task],
    [tokenField]: maxTokens,
    response_format: { type: "json_object" },
    stream: Boolean(options.stream),
    // Usage arrives in the final chunk only when asked; unknown compatible hosts may reject the field.
    ...(options.stream && (provider === "deepseek" || officialOpenAI) ? { stream_options: { include_usage: true } } : {}),
    ...(officialOpenAI && options.cacheKey ? { prompt_cache_key: options.cacheKey } : {}),
    ...(provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
  };
}

export function connectionTestPayload(provider: AiProvider, model: string, structured: boolean) {
  if (structured) {
    return {
      model,
      messages: [
        { role: "system", content: "Return a JSON object only. Do not include Markdown." },
        { role: "user", content: 'Return exactly {"ok":true}.' },
      ],
      max_tokens: 64,
      response_format: { type: "json_object" },
      stream: false,
      ...(provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    };
  }
  return {
    model,
    messages: [
      { role: "system", content: "Reply with exactly OK." },
      { role: "user", content: "Connection test." },
    ],
    max_tokens: 16,
    stream: false,
    ...(provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
  };
}

function networkFailure(error: unknown): AssistantUpstreamError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const cause = error instanceof Error && error.cause && typeof error.cause === "object"
    ? String((error.cause as { code?: unknown }).code || "")
    : "";
  const diagnostic = `${name} ${message} ${cause}`.toLowerCase();
  if (/header|bytestring|invalid character|non[- ]ascii/.test(diagnostic)) {
    return new AssistantUpstreamError(
      "credential_header_invalid",
      "API Key 含有接口请求头不支持的字符，请重新复制并保存密钥。",
      400,
      false,
      null,
      "invalid_header",
    );
  }
  if (/dns|enotfound|eai_again|name resolution/.test(diagnostic)) {
    return new AssistantUpstreamError(
      "upstream_network_error",
      "站点服务器无法解析模型服务域名，未收到 HTTP 响应。",
      502,
      true,
      null,
      "dns",
    );
  }
  if (/tls|ssl|certificate|cert_/.test(diagnostic)) {
    return new AssistantUpstreamError(
      "upstream_network_error",
      "站点服务器与模型服务建立 HTTPS 连接失败，未收到 HTTP 响应。",
      502,
      true,
      null,
      "tls",
    );
  }
  if (/connect|network|socket|reset|refused|fetch failed/.test(diagnostic)) {
    return new AssistantUpstreamError(
      "upstream_network_error",
      "站点服务器无法建立到模型服务的网络连接，未收到 HTTP 响应。",
      502,
      true,
      null,
      "connection",
    );
  }
  return new AssistantUpstreamError(
    "upstream_network_error",
    "站点服务器未能连接模型服务，且没有收到 HTTP 响应。",
    502,
    true,
    null,
    "unknown",
  );
}

export async function probeConnectionEndpoint(
  fetcher: typeof fetch,
  candidates: string[],
  timeoutMs: number,
): Promise<{ url: string; status: number; latencyMs: number }> {
  let lastError: AssistantUpstreamError | null = null;
  for (const url of candidates) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400) {
        lastError = new AssistantUpstreamError(
          "provider_redirect_rejected",
          "模型接口返回了重定向；为防止密钥被转发，词迹没有继续请求。",
          502,
          false,
          response.status,
        );
        continue;
      }
      return { url, status: response.status, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        lastError = new AssistantUpstreamError(
          "upstream_timeout",
          "模型服务网络探测超时，未收到 HTTP 响应。",
          504,
          true,
        );
      } else {
        lastError = networkFailure(error);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new AssistantUpstreamError("upstream_network_error", "没有可测试的模型接口地址。", 502, false);
}

export async function fetchChatCompletionWithTimeout(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "manual" });
    return await readChatCompletion(response, controller.signal);
  } catch (error) {
    if (error instanceof AssistantUpstreamError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AssistantUpstreamError("upstream_timeout", "模型服务响应超时，请稍后重试。", 504, true);
    }
    throw networkFailure(error);
  } finally {
    clearTimeout(timeout);
  }
}

function mappedUpstreamFailure(status: number): AssistantUpstreamError {
  if (status >= 300 && status < 400) return new AssistantUpstreamError("provider_redirect_rejected", "模型接口返回了重定向；为防止密钥被转发，词迹没有继续请求。", 502, false, status);
  if (status === 401 || status === 403) return new AssistantUpstreamError("provider_auth_failed", "API Key 无效，或当前密钥无权调用该模型。", 503, false, status);
  if (status === 402) return new AssistantUpstreamError("provider_payment_required", "模型账户余额不足，或尚未开通 API 计费。", 503, false, status);
  if (status === 404 || status === 405) return new AssistantUpstreamError("provider_endpoint_not_found", "Chat Completions 地址或模型名不正确。", 502, false, status);
  if (status === 408 || status === 429) return new AssistantUpstreamError("provider_busy", "模型服务当前繁忙或已达到服务商限额，请稍后重试。", 503, true, status);
  if (status === 400 || status === 422) return new AssistantUpstreamError("provider_rejected_request", "模型服务拒绝了请求参数，请检查模型名和接口兼容性。", 502, false, status);
  if (status >= 500) return new AssistantUpstreamError("provider_unavailable", "模型服务暂时不可用，请稍后重试。", 502, true, status);
  return new AssistantUpstreamError("provider_rejected_request", "模型服务拒绝了这次请求，请检查服务端配置。", 502, false, status);
}

export type CompletionUsage = { prompt: number; completion: number; cacheHit: number; total: number; estimated: boolean };
export type Completion = { content: string; usage: CompletionUsage; finishReason: string | null };

const tokenCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** DeepSeek reports prompt_cache_hit_tokens; OpenAI reports prompt_tokens_details.cached_tokens. */
export function parseUsage(value: unknown): CompletionUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const prompt = tokenCount(usage.prompt_tokens), completion = tokenCount(usage.completion_tokens);
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheHit = tokenCount(usage.prompt_cache_hit_tokens) || tokenCount(details?.cached_tokens);
  if (!prompt && !completion) return null;
  return { prompt, completion, cacheHit: Math.min(cacheHit, prompt), total: tokenCount(usage.total_tokens) || prompt + completion, estimated: false };
}

/** A rough fallback when a provider returns no usage: about three characters per token. */
export function estimateUsage(promptChars: number, content: string): CompletionUsage {
  const prompt = Math.ceil(promptChars / 3), completion = Math.ceil(content.length / 3);
  return { prompt, completion, cacheHit: 0, total: prompt + completion, estimated: true };
}

export async function readChatCompletion(response: Response, signal?: AbortSignal): Promise<string> {
  return (await readChatCompletionDetailed(response, signal)).content;
}

export async function readChatCompletionDetailed(response: Response, signal?: AbortSignal, promptChars = 0): Promise<Completion> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw mappedUpstreamFailure(response.status);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 300_000) {
    void response.body?.cancel().catch(() => undefined);
    throw new AssistantUpstreamError("model_response_too_large", "模型返回内容过大。", 502, true);
  }
  const text = await readBoundedResponseText(response, 300_000, signal);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AssistantUpstreamError("invalid_provider_response", "模型服务返回了无法识别的数据。", 502, true);
  }
  const choices = outputRecord(payload).choices;
  if (!Array.isArray(choices) || !choices.length) throw new AssistantUpstreamError("invalid_provider_response", "模型服务没有返回回答。", 502, true);
  const choice = outputRecord(choices[0], "choices[0]");
  const message = outputRecord(choice.message, "choices[0].message");
  const content = cleanOutputText(message.content, "choices[0].message.content", 300_000);
  return {
    content,
    usage: parseUsage((payload as Record<string, unknown>).usage) || estimateUsage(promptChars, content),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
  };
}

const MAX_STREAM_BYTES = 6_000_000;

/**
 * Reads a Chat Completions SSE stream. `onChunk` is called on every received chunk so the
 * caller can run an idle timeout instead of one deadline for a long generation.
 */
export async function readChatCompletionStream(response: Response, signal?: AbortSignal, onChunk?: () => void, promptChars = 0): Promise<Completion> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw mappedUpstreamFailure(response.status);
  }
  // Some compatible services ignore `stream: true` and answer with one JSON document.
  if (!/text\/event-stream/i.test(response.headers.get("content-type") || "")) return readChatCompletionDetailed(response, signal, promptChars);
  if (!response.body) throw new AssistantUpstreamError("invalid_provider_response", "模型服务没有返回回答。", 502, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  let onAbort: (() => void) | null = null;
  const aborted = signal ? new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(abortError());
    else { onAbort = () => reject(abortError()); signal.addEventListener("abort", onAbort, { once: true }); }
  }) : null;
  let buffer = "", content = "", bytes = 0, finishReason: string | null = null, usage: CompletionUsage | null = null, done = false;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { done = true; return; }
    let chunk: Record<string, unknown>;
    try { chunk = outputRecord(JSON.parse(data)); }
    catch { throw new AssistantUpstreamError("invalid_provider_response", "模型服务返回了无法识别的数据。", 502, true); }
    usage = parseUsage(chunk.usage) || usage;
    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (content.length > 300_000) throw new AssistantUpstreamError("model_response_too_large", "模型返回内容过大。", 502, true);
  };
  try {
    while (!done) {
      const chunk = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (chunk.done) break;
      onChunk?.();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new AssistantUpstreamError("model_response_too_large", "模型返回内容过大。", 502, true);
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) { handle(line); if (done) break; }
    }
    if (!done && buffer) handle(buffer);
  } catch (error) {
    void reader.cancel("stream-aborted").catch(() => undefined);
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (done) void reader.cancel("done").catch(() => undefined);
    try { reader.releaseLock(); } catch { /* The aborted stream still owns the lock. */ }
  }
  const text = cleanOutputText(content, "choices[0].message.content", 300_000);
  return { content: text, usage: usage || estimateUsage(promptChars, text), finishReason };
}

/**
 * Sends one request and reads the answer. Streams reset `idleMs` on every chunk; `totalMs`
 * bounds the whole exchange. Redirects are never followed.
 */
export async function fetchCompletion(fetcher: typeof fetch, url: string, init: RequestInit, options: { idleMs: number; totalMs: number; stream: boolean; promptChars?: number }): Promise<Completion> {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), options.idleMs); };
  const total = setTimeout(() => controller.abort(), options.totalMs);
  arm();
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "manual" });
    arm();
    return options.stream
      ? await readChatCompletionStream(response, controller.signal, arm, options.promptChars)
      : await readChatCompletionDetailed(response, controller.signal, options.promptChars);
  } catch (error) {
    if (error instanceof AssistantUpstreamError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new AssistantUpstreamError("upstream_timeout", "模型服务响应超时，请稍后重试。", 504, true);
    }
    throw networkFailure(error);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  let onAbort: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(abortError());
        else {
          onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }
      })
    : null;
  try {
    while (true) {
      const chunk = await (abortPromise ? Promise.race([reader.read(), abortPromise]) : reader.read());
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        void reader.cancel("response-too-large").catch(() => undefined);
        throw new AssistantUpstreamError("model_response_too_large", "模型返回内容过大。", 502, true);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal?.aborted) void reader.cancel("request-timeout").catch(() => undefined);
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* The aborted stream still owns the lock. */ }
  }
}
