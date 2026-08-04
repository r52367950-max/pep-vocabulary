import { getChatGPTUser } from "@/app/chatgpt-auth";
import {
  AssistantInputError,
  AssistantUpstreamError,
  buildAssistantPrompt,
  chatCompletionsUrl,
  fetchChatCompletionWithTimeout,
  parseAssistantRequest,
  resolveLexiconEvidence,
  sanitizeModelResult,
  upstreamPayload,
  type AssistantTask,
  type LexiconEvidence,
} from "./core";
import {
  AiConfigurationError,
  assistantBindings,
  assistantLimits,
  hashIdentity,
  loadAiRuntimeConfig,
} from "./config";

const MAX_REQUEST_BYTES = 24_000;

type ReleaseIndexRow = LexiconEvidence & {
  flags?: { formalReleaseEligible?: boolean };
};

class AssistantRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("AI 请求过于频繁，请稍后重试。");
    this.name = "AssistantRateLimitError";
    this.retryAfter = retryAfter;
  }
}

function responseHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

export function assistantErrorResponse(error: unknown): Response {
  if (error instanceof AssistantRateLimitError) {
    return Response.json(
      { ok: false, error: { code: "rate_limited", message: error.message, retryable: true } },
      { status: 429, headers: responseHeaders({ "retry-after": String(error.retryAfter) }) },
    );
  }
  if (error instanceof AssistantInputError || error instanceof AiConfigurationError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message, retryable: error.status >= 500 } },
      { status: error.status, headers: responseHeaders() },
    );
  }
  if (error instanceof AssistantUpstreamError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable } },
      { status: error.status, headers: responseHeaders() },
    );
  }
  return Response.json(
    { ok: false, error: { code: "assistant_unavailable", message: "AI 助手暂时不可用；本地学习数据没有受到影响。", retryable: true } },
    { status: 503, headers: responseHeaders() },
  );
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let expected: string;
  try {
    expected = new URL(request.url).origin;
  } catch {
    throw new AssistantInputError("invalid_origin", "请求来源无法验证。", 403);
  }
  if (origin !== expected) throw new AssistantInputError("invalid_origin", "只允许同源请求。", 403);
}

export async function readJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AssistantInputError("unsupported_media_type", "请求必须使用 application/json。", 415);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new AssistantInputError("request_too_large", "AI 请求超过 24 KB 限制。", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new AssistantInputError("request_too_large", "AI 请求超过 24 KB 限制。", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AssistantInputError("invalid_json", "请求不是有效 JSON。");
  }
}

let releaseIndexPromise: Promise<ReleaseIndexRow[]> | null = null;

async function releaseIndex(request: Request): Promise<ReleaseIndexRow[]> {
  if (releaseIndexPromise) return releaseIndexPromise;
  const bindings = assistantBindings();
  if (!bindings.ASSETS) throw new AiConfigurationError("evidence_store_unavailable", "正式词库证据暂时无法读取。");
  releaseIndexPromise = (async () => {
    const response = await bindings.ASSETS!.fetch(new Request(new URL("/data/v1/index.json", request.url)));
    if (!response.ok) throw new AiConfigurationError("evidence_store_unavailable", "正式词库证据暂时无法读取。");
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new AiConfigurationError("evidence_store_unavailable", "正式词库证据格式异常。");
    return payload as ReleaseIndexRow[];
  })().catch((error) => {
    releaseIndexPromise = null;
    throw error;
  });
  return releaseIndexPromise;
}

async function incrementBucket(bucketKey: string, expiresAt: number, limit: number): Promise<number> {
  const db = assistantBindings().DB;
  if (!db) throw new AiConfigurationError("rate_limit_unavailable", "服务端限流存储不可用。");
  let row: { request_count: number } | null;
  try {
    row = await db.prepare(
      `INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`,
    ).bind(bucketKey, expiresAt).first<{ request_count: number }>();
  } catch (error) {
    if (error instanceof Error && /no such table|SQLITE_ERROR.*ai_rate_limits/i.test(error.message)) {
      throw new AiConfigurationError("rate_limit_migration_required", "AI 限流表尚未创建，请先部署本分支附带的 D1 迁移。");
    }
    throw new AiConfigurationError("rate_limit_unavailable", "服务端限流存储不可用。");
  }
  const count = Number(row?.request_count || 0);
  if (count > limit) throw new AssistantRateLimitError(Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)));
  return count;
}

async function enforceRateLimit(identity: string) {
  const { perMinute, perDay } = assistantLimits();
  const subject = await hashIdentity(identity);
  const now = Date.now();
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  await incrementBucket(`minute:${subject}:${minuteStart}`, minuteStart + 60_000, perMinute);
  await incrementBucket(`day:${subject}:${dayStart}`, dayStart + 86_400_000, perDay);

  // The keys contain only a one-way identity digest. Opportunistic cleanup keeps
  // the table bounded without adding request content or provider data to logs.
  if (crypto.getRandomValues(new Uint8Array(1))[0] < 4) {
    assistantBindings().DB?.prepare("DELETE FROM ai_rate_limits WHERE expires_at < ?").bind(now - 86_400_000).run().catch(() => undefined);
  }
}

export async function handleAssistantRequest(request: Request, task: AssistantTask): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getChatGPTUser();
    if (!user) throw new AssistantInputError("authentication_required", "AI 助手需要经过站点身份验证。", 401);
    const body = await readJsonRequest(request);
    const parsed = parseAssistantRequest(task, body);
    await enforceRateLimit(user.email);

    const evidence = resolveLexiconEvidence(await releaseIndex(request), parsed.wordIds);
    const config = await loadAiRuntimeConfig();
    const prompt = buildAssistantPrompt(parsed, evidence);
    const { timeoutMs } = assistantLimits();
    const completion = await fetchChatCompletionWithTimeout(
      fetch,
      chatCompletionsUrl(config.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(upstreamPayload(config.model, prompt, task)),
      },
      timeoutMs,
    );
    const maximumItems = parsed.task === "generate-practice" ? parsed.count : 8;
    const result = sanitizeModelResult(task, completion, evidence, maximumItems);

    return Response.json(
      {
        ok: true,
        task,
        provider: config.provider,
        model: config.model,
        evidence,
        result,
      },
      { status: 200, headers: responseHeaders() },
    );
  } catch (error) {
    return assistantErrorResponse(error);
  }
}
