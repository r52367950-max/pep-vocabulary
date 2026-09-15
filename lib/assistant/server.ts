import { readJsonObject, RequestBodyError, sameOriginRequest } from "@/lib/http";
import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { aiConfigs } from "@/db/schema";
import {
  decryptApiKey,
  isAiProvider,
  normalizeApiKey,
  normalizeConfiguredBaseUrl,
  normalizeConfiguredModel,
  sameOriginMutation,
} from "@/lib/ai-config";
import { authenticatedUserKey } from "@/lib/server-user";
import {
  AssistantInputError,
  AssistantUpstreamError,
  buildAssistantPrompt,
  chatCompletionsUrl,
  connectionEndpointCandidates,
  connectionTestPayload,
  fetchChatCompletionWithTimeout,
  parseAssistantRequest,
  probeConnectionEndpoint,
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
  ASSETS?: { fetch: typeof fetch };
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
  if (!sameOriginRequest(request)) throw new AssistantInputError("invalid_origin", "只允许同源请求。", 403);
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
  try { return await readJsonObject(request, MAX_REQUEST_BYTES); }
  catch (error) {
    if (error instanceof RequestBodyError) throw new AssistantInputError("invalid_request", error.message, error.status);
    throw error;
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
    baseUrl = normalizeConfiguredBaseUrl(row.baseUrl, row.provider);
  } catch {
    throw new AiRuntimeConfigError("configuration_invalid", "服务端 AI Base URL 无效。");
  }
  let apiKey: string;
  try {
    apiKey = normalizeApiKey(await decryptApiKey(row.encryptedApiKey, row.keyIv, row.encryptionVersion,
      { userKey, provider: row.provider, baseUrl }));
  } catch {
    throw new AiRuntimeConfigError("credential_unavailable", "无法解密当前密钥，请在设置中重新保存 API Key。");
  }
  let model: string;
  try {
    model = normalizeConfiguredModel(row.provider, row.model);
  } catch {
    throw new AiRuntimeConfigError("configuration_invalid", "服务端模型名无效，请在设置中重新保存。");
  }
  return {
    provider: row.provider,
    baseUrl,
    model,
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

async function enforceConnectionTestRateLimit(userKey: string) {
  const now = Date.now();
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  await incrementBucket(`connection-test:minute:${userKey}:${minuteStart}`, minuteStart + 60_000, 6);
  await incrementBucket(`connection-test:day:${userKey}:${dayStart}`, dayStart + 86_400_000, 30);
}

async function authenticatedConfig(request: Request) {
  assertSameOrigin(request);
  const user = await getChatGPTUser();
  if (!user) throw new AssistantInputError("authentication_required", "AI 助手需要经过站点身份验证。", 401);
  const userKey = await authenticatedUserKey();
  if (!userKey) throw new AssistantInputError("authentication_required", "AI 助手需要经过站点身份验证。", 401);
  const config = await loadUserRuntimeConfig(userKey);
  return { config, userKey };
}

async function authenticatedRuntime(request: Request) {
  const { config, userKey } = await authenticatedConfig(request);
  await enforceRateLimit(userKey, config.dailyLimit);
  return config;
}

type ConnectionCheckStatus = "passed" | "failed" | "unknown";
type ConnectionPhase = "reachability" | "basic" | "capability";
type ConnectionCheckId = "configuration" | "endpoint" | "authentication" | "account" | "model" | "service" | "capability";

type ConnectionCheck = {
  id: ConnectionCheckId;
  label: string;
  status: ConnectionCheckStatus;
  detail: string;
  latencyMs?: number;
};

const CHECK_LABELS: Record<ConnectionCheckId, string> = {
  configuration: "服务端配置",
  endpoint: "接口端点",
  authentication: "身份验证",
  account: "账户与限额",
  model: "模型生成",
  service: "服务状态",
  capability: "词迹助手能力",
};

function connectionCheck(
  id: ConnectionCheckId,
  status: ConnectionCheckStatus,
  detail: string,
  latencyMs?: number,
): ConnectionCheck {
  return { id, label: CHECK_LABELS[id], status, detail, ...(latencyMs === undefined ? {} : { latencyMs }) };
}

function unknownConnectionCheck(id: ConnectionCheckId) {
  return connectionCheck(id, "unknown", "前置检查未通过，本项没有继续发送请求。");
}

function serviceStatusUrl(provider: AiProvider) {
  return provider === "deepseek" ? "https://status.deepseek.com/" : null;
}

function failedConnectionChecks(
  phase: ConnectionPhase,
  error: AssistantUpstreamError,
  endpointLatencyMs?: number,
  basicLatencyMs?: number,
) {
  const hasProviderResponse = error.providerStatus !== null;
  const endpointFailed = phase === "reachability";
  const authenticationFailed = error.code === "provider_auth_failed";
  const accountFailed = error.code === "provider_payment_required";
  const serviceFailed = error.code === "provider_busy" || error.code === "provider_unavailable" || error.code === "upstream_timeout" || error.code === "upstream_network_error";
  const modelFailed = phase === "basic" && (error.code === "provider_endpoint_not_found" || error.code === "provider_rejected_request");

  return [
    connectionCheck("configuration", "passed", "已从服务端加密配置中读取；密钥没有返回浏览器。"),
    endpointFailed
      ? connectionCheck("endpoint", "failed", error.message)
      : endpointLatencyMs !== undefined
        ? connectionCheck("endpoint", "passed", "站点服务器已收到模型接口的 HTTP 响应。", endpointLatencyMs)
        : hasProviderResponse || basicLatencyMs !== undefined
          ? connectionCheck("endpoint", "passed", "Chat Completions 端点可达。", basicLatencyMs)
          : unknownConnectionCheck("endpoint"),
    authenticationFailed
      ? connectionCheck("authentication", "failed", error.message)
      : basicLatencyMs !== undefined || (hasProviderResponse && !serviceFailed)
        ? connectionCheck("authentication", "passed", "服务商已接受当前 API Key。")
        : unknownConnectionCheck("authentication"),
    accountFailed
      ? connectionCheck("account", "failed", error.message)
      : basicLatencyMs !== undefined
        ? connectionCheck("account", "passed", "服务商允许当前账户执行真实生成请求。")
        : unknownConnectionCheck("account"),
    basicLatencyMs !== undefined
      ? connectionCheck("model", "passed", "所选模型已返回非空回答。", basicLatencyMs)
      : modelFailed
        ? connectionCheck("model", "failed", error.message)
        : unknownConnectionCheck("model"),
    serviceFailed
      ? connectionCheck("service", "failed", error.message)
      : hasProviderResponse || basicLatencyMs !== undefined
        ? connectionCheck("service", "passed", "模型服务已响应本次检查。")
        : unknownConnectionCheck("service"),
    phase === "capability"
      ? connectionCheck("capability", "failed", error.message)
      : unknownConnectionCheck("capability"),
  ];
}

function logConnectionTest(
  outcome: "passed" | "failed",
  provider: AiProvider,
  phase: ConnectionPhase,
  latencyMs: number,
  error?: AssistantUpstreamError,
) {
  const event = JSON.stringify({
    event: "ai_connection_test",
    outcome,
    provider,
    phase,
    latencyMs,
    code: error?.code || "ok",
    providerStatus: error?.providerStatus ?? null,
    networkReason: error?.networkReason ?? null,
  });
  if (outcome === "passed") console.info(event);
  else console.warn(event);
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
      chatCompletionsUrl(config.baseUrl, config.provider),
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(upstreamPayload(config.model, prompt, task, config.provider)),
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
  let config: UserRuntimeConfig | null = null;
  let phase: ConnectionPhase = "reachability";
  let endpointLatencyMs: number | undefined;
  let basicLatencyMs: number | undefined;
  const startedAt = Date.now();
  try {
    if (!sameOriginMutation(request)) {
      throw new AssistantInputError("invalid_origin", "连接测试只能从设置页面发起。", 403);
    }
    await readJsonRequest(request);
    const authenticated = await authenticatedConfig(request);
    config = authenticated.config;
    await enforceConnectionTestRateLimit(authenticated.userKey);
    apiKey = config.apiKey;

    const endpoint = await probeConnectionEndpoint(
      fetch,
      connectionEndpointCandidates(config.provider, config.baseUrl),
      Math.min(config.timeoutMs, 8_000),
    );
    endpointLatencyMs = endpoint.latencyMs;

    phase = "basic";
    const basicStartedAt = Date.now();
    await fetchChatCompletionWithTimeout(
      fetch,
      endpoint.url,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(connectionTestPayload(config.provider, config.model, false)),
      },
      Math.min(config.timeoutMs, 20_000),
    );
    basicLatencyMs = Date.now() - basicStartedAt;

    phase = "capability";
    const capabilityStartedAt = Date.now();
    const capabilityContent = await fetchChatCompletionWithTimeout(
      fetch,
      endpoint.url,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(connectionTestPayload(config.provider, config.model, true)),
      },
      Math.min(config.timeoutMs, 20_000),
    );
    const capabilityLatencyMs = Date.now() - capabilityStartedAt;
    let capabilityResult: unknown;
    try {
      capabilityResult = JSON.parse(capabilityContent);
    } catch {
      throw new AssistantUpstreamError(
        "structured_output_unsupported",
        "模型可以生成文本，但没有返回词迹所需的 JSON 对象。",
        502,
        false,
      );
    }
    if (!capabilityResult || typeof capabilityResult !== "object" || Array.isArray(capabilityResult) || (capabilityResult as { ok?: unknown }).ok !== true) {
      throw new AssistantUpstreamError(
        "structured_output_unsupported",
        "模型可以生成文本，但结构化输出与词迹不兼容。",
        502,
        false,
      );
    }

    const latencyMs = Date.now() - startedAt;
    logConnectionTest("passed", config.provider, phase, latencyMs);
    return Response.json(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
        provider: config.provider,
        model: config.model,
        endpointHost: new URL(config.baseUrl).host,
        serviceStatusUrl: serviceStatusUrl(config.provider),
        checks: [
          connectionCheck("configuration", "passed", "已从服务端加密配置中读取；密钥没有返回浏览器。"),
          connectionCheck("endpoint", "passed", "站点服务器已收到模型接口的 HTTP 响应。", endpointLatencyMs),
          connectionCheck("authentication", "passed", "服务商已接受当前 API Key。"),
          connectionCheck("account", "passed", "服务商允许当前账户执行真实生成请求。"),
          connectionCheck("model", "passed", "所选模型已返回非空回答。", basicLatencyMs),
          connectionCheck("service", "passed", "模型服务已完成两次真实请求。"),
          connectionCheck("capability", "passed", "JSON 结构化输出可供四类词汇助手使用。", capabilityLatencyMs),
        ],
      },
      { status: 200, headers: responseHeaders() },
    );
  } catch (error) {
    if (!config || !(error instanceof AssistantUpstreamError)) return assistantErrorResponse(error);
    const latencyMs = Date.now() - startedAt;
    logConnectionTest("failed", config.provider, phase, latencyMs, error);
    return Response.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs,
        provider: config.provider,
        model: config.model,
        endpointHost: new URL(config.baseUrl).host,
        serviceStatusUrl: serviceStatusUrl(config.provider),
        checks: failedConnectionChecks(phase, error, endpointLatencyMs, basicLatencyMs),
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          providerStatus: error.providerStatus,
          networkReason: error.networkReason,
        },
      },
      { status: error.status, headers: responseHeaders() },
    );
  } finally {
    apiKey = "";
  }
}
