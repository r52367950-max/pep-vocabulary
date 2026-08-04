import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { aiConfigs } from "@/db/schema";
import { decryptApiKey, isAiProvider, normalizeConfiguredBaseUrl } from "@/lib/ai-config";
import { authenticatedUserKey } from "@/lib/server-user";
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
  type AiProvider,
  type AssistantTask,
  type LexiconEvidence,
} from "./core";

const MAX_REQUEST_BYTES = 24_000;

type ReleaseIndexRow = LexiconEvidence & {
  flags?: { formalReleaseEligible?: boolean };
};

type RuntimeBindings = {
  ASSETS?: Fetcher;
  DB?: D1Database;
};

type UserRuntimeConfig = {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  dailyLimit: number;
};

class AiRuntimeConfigError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "AiRuntimeConfigError";
    this.code = code;
    this.status = status;
  }
}

class AssistantRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("AI 请求过于频繁，请稍后重试。");
    this.name = "AssistantRateLimitError";
    this.retryAfter = retryAfter;
  }
}

function bindings() {
  return env as unknown as RuntimeBindings;
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
  if (error instanceof AssistantInputError || error instanceof AiRuntimeConfigError) {
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
    {
      ok: false,
      error: {
        code: "assistant_unavailable",
        message: "AI 助手暂时不可用；本地学习数据没有受到影响。",
        retryable: true,
      },
    },
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

async function loadUserRuntimeConfig(userKey: string): Promise<UserRuntimeConfig> {
  let row: typeof aiConfigs.$inferSelect | undefined;
  try {
    [row] = await getDb().select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
  } catch {
    throw new AiRuntimeConfigError("configuration_unavailable", "暂时无法读取 AI 配置。");
  }
  if (!row) {
    throw new AiRuntimeConfigError("assistant_not_configured", "请先在设置中保存 AI 接口配置。");
  }
  if (!isAiProvider(row.provider)) {
    throw new AiRuntimeConfigError("configuration_invalid", "服务端 AI 接口类型无效。");
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeConfiguredBaseUrl(row.baseUrl);
  } catch {
    throw new AiRuntimeConfigError("configuration_invalid", "服务端 AI Base URL 无效。");
  }
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(row.encryptedApiKey, row.keyIv);
  } catch {
    throw new AiRuntimeConfigError("credential_unavailable", "无法解密当前密钥，请在设置中重新保存 API Key。");
  }
  return {
    provider: row.provider,
    baseUrl,
    model: row.model,
    apiKey,
    timeoutMs: Math.min(60, Math.max(10, row.timeoutSeconds)) * 1000,
    dailyLimit: Math.min(200, Math.max(5, row.dailyLimit)),
  };
}

let releaseIndexPromise: Promise<ReleaseIndexRow[]> | null = null;

async function releaseIndex(request: Request): Promise<ReleaseIndexRow[]> {
  if (releaseIndexPromise) return releaseIndexPromise;
  const assets = bindings().ASSETS;
  if (!assets) throw new AiRuntimeConfigError("evidence_store_unavailable", "正式词库证据暂时无法读取。");
  releaseIndexPromise = (async () => {
    const response = await assets.fetch(new Request(new URL("/data/v1/index.json", request.url)));
    if (!response.ok) throw new AiRuntimeConfigError("evidence_store_unavailable", "正式词库证据暂时无法读取。");
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new AiRuntimeConfigError("evidence_store_unavailable", "正式词库证据格式异常。");
    return payload as ReleaseIndexRow[];
  })().catch((error) => {
    releaseIndexPromise = null;
    throw error;
  });
  return releaseIndexPromise;
}

async function incrementBucket(bucketKey: string, expiresAt: number, limit: number): Promise<void> {
  const db = bindings().DB;
  if (!db) throw new AiRuntimeConfigError("rate_limit_unavailable", "服务端限流存储不可用。");
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
      throw new AiRuntimeConfigError("rate_limit_migration_required", "AI 限流表尚未创建，请先部署最新 D1 迁移。");
    }
    throw new AiRuntimeConfigError("rate_limit_unavailable", "服务端限流存储不可用。");
  }
  if (Number(row?.request_count || 0) > limit) {
    throw new AssistantRateLimitError(Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)));
  }
}

async function enforceRateLimit(userKey: string, dailyLimit: number) {
  const now = Date.now();
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  await incrementBucket(`minute:${userKey}:${minuteStart}`, minuteStart + 60_000, Math.min(12, dailyLimit));
  await incrementBucket(`day:${userKey}:${dayStart}`, dayStart + 86_400_000, dailyLimit);

  if (crypto.getRandomValues(new Uint8Array(1))[0] < 4) {
    bindings().DB?.prepare("DELETE FROM ai_rate_limits WHERE expires_at < ?")
      .bind(now - 86_400_000)
      .run()
      .catch(() => undefined);
  }
}

async function authenticatedRuntime(request: Request) {
  assertSameOrigin(request);
  const user = await getChatGPTUser();
  if (!user) throw new AssistantInputError("authentication_required", "AI 助手需要经过站点身份验证。", 401);
  const userKey = await authenticatedUserKey();
  if (!userKey) throw new AssistantInputError("authentication_required", "AI 助手需要经过站点身份验证。", 401);
  const config = await loadUserRuntimeConfig(userKey);
  await enforceRateLimit(userKey, config.dailyLimit);
  return config;
}

export async function handleAssistantRequest(request: Request, task: AssistantTask): Promise<Response> {
  let apiKey = "";
  try {
    assertSameOrigin(request);
    const body = await readJsonRequest(request);
    const parsed = parseAssistantRequest(task, body);
    const config = await authenticatedRuntime(request);
    apiKey = config.apiKey;
    const evidence = resolveLexiconEvidence(await releaseIndex(request), parsed.wordIds);
    const prompt = buildAssistantPrompt(parsed, evidence);
    const completion = await fetchChatCompletionWithTimeout(
      fetch,
      chatCompletionsUrl(config.baseUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(upstreamPayload(config.model, prompt, task)),
      },
      config.timeoutMs,
    );
    const maximumItems = parsed.task === "generate-practice" ? parsed.count : 8;
    const result = sanitizeModelResult(task, completion, evidence, maximumItems);
    return Response.json(
      { ok: true, task, provider: config.provider, model: config.model, evidence, result },
      { status: 200, headers: responseHeaders() },
    );
  } catch (error) {
    return assistantErrorResponse(error);
  } finally {
    apiKey = "";
  }
}

export async function testAssistantConnection(request: Request): Promise<Response> {
  let apiKey = "";
  try {
    assertSameOrigin(request);
    await readJsonRequest(request);
    const config = await authenticatedRuntime(request);
    apiKey = config.apiKey;
    const startedAt = Date.now();
    await fetchChatCompletionWithTimeout(
      fetch,
      chatCompletionsUrl(config.baseUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: "Return only the word OK." },
            { role: "user", content: "Connection test." },
          ],
          temperature: 0,
          max_tokens: 8,
          stream: false,
        }),
      },
      config.timeoutMs,
    );
    return Response.json(
      {
        ok: true,
        latencyMs: Date.now() - startedAt,
        provider: config.provider,
        selectedModel: config.model,
      },
      { status: 200, headers: responseHeaders() },
    );
  } catch (error) {
    return assistantErrorResponse(error);
  } finally {
    apiKey = "";
  }
}
