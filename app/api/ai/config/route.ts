import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiConfigs } from "@/db/schema";
import {
  AI_PROVIDER_DEFAULTS,
  encryptApiKey,
  isAiProvider,
  normalizeConfiguredBaseUrl,
  normalizeConfiguredModel,
  normalizeApiKey,
  sameOriginMutation,
  securityHeaders,
} from "@/lib/ai-config";
import { sameAiCredentialScope, type AiProvider } from "@/lib/assistant/core";
import { authenticatedUserKey } from "@/lib/server-user";

const DEFAULT_LIMITS = { dailyLimit: 30, timeoutSeconds: 25 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: securityHeaders() });
}

function safeProvider(value: string | undefined): AiProvider {
  return isAiProvider(value) ? value : "deepseek";
}

function publicConfig(row?: typeof aiConfigs.$inferSelect) {
  const provider = safeProvider(row?.provider);
  let baseUrl = AI_PROVIDER_DEFAULTS[provider].baseUrl;
  try {
    baseUrl = normalizeConfiguredBaseUrl(row?.baseUrl || baseUrl, provider);
  } catch {
    // Invalid legacy values are never reflected into editable settings.
  }
  let model = AI_PROVIDER_DEFAULTS[provider].model;
  try {
    model = normalizeConfiguredModel(provider, row?.model || model);
  } catch {
    // Invalid legacy values are never reflected into editable settings.
  }
  return {
    provider,
    baseUrl,
    model,
    dailyLimit: row?.dailyLimit || DEFAULT_LIMITS.dailyLimit,
    timeoutSeconds: row?.timeoutSeconds || DEFAULT_LIMITS.timeoutSeconds,
    hasApiKey: Boolean(row?.encryptedApiKey),
    updatedAt: row?.updatedAt || null,
    secretStorage: "server-encrypted" as const,
  };
}

export async function GET() {
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  try {
    const [row] = await getDb().select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
    return json(publicConfig(row));
  } catch {
    return json({ error: "暂时无法读取 API 配置。" }, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "配置请求必须使用 JSON。" }, 415);
  }
  if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "配置请求过大。" }, 413);

  let body: {
    provider?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    dailyLimit?: unknown;
    timeoutSeconds?: unknown;
    apiKey?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "配置格式无效。" }, 400);
  }

  if (!isAiProvider(body.provider)) return json({ error: "请选择受支持的接口类型。" }, 400);
  let baseUrl: string;
  try {
    baseUrl = normalizeConfiguredBaseUrl(body.baseUrl, body.provider);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Base URL 格式无效。" }, 400);
  }
  let model: string;
  try {
    model = normalizeConfiguredModel(body.provider, body.model);
  } catch {
    return json({ error: "模型名格式无效。" }, 400);
  }

  const dailyLimit = Number(body.dailyLimit);
  const timeoutSeconds = Number(body.timeoutSeconds);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 5 || dailyLimit > 200) {
    return json({ error: "每日调用上限应为 5–200。" }, 400);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 60) {
    return json({ error: "超时时间应为 10–60 秒。" }, 400);
  }

  const db = getDb();
  const [current] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
  let encrypted: { encryptedApiKey: string; keyIv: string } | null = null;
  if (current) {
    let currentBaseUrl = current.baseUrl;
    try {
      currentBaseUrl = normalizeConfiguredBaseUrl(current.baseUrl, safeProvider(current.provider));
    } catch {
      // An invalid legacy destination never receives a retained credential.
    }
    if (sameAiCredentialScope(
      { provider: safeProvider(current.provider), baseUrl: currentBaseUrl },
      { provider: body.provider, baseUrl },
    )) {
      encrypted = { encryptedApiKey: current.encryptedApiKey, keyIv: current.keyIv };
    }
  }

  if (body.apiKey !== undefined && body.apiKey !== "") {
    let apiKey: string;
    try {
      apiKey = normalizeApiKey(body.apiKey);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "API Key 格式无效。" }, 400);
    }
    try {
      encrypted = await encryptApiKey(apiKey);
    } catch {
      return json({ error: "当前部署尚未启用安全密钥存储。" }, 503);
    }
  }
  if (!encrypted) {
    return json({ error: current ? "更换服务商或 Base URL 时必须重新填写 API Key。" : "首次配置时需要填写 API Key。" }, 400);
  }

  await db.insert(aiConfigs).values({
    userKey,
    provider: body.provider,
    baseUrl,
    model,
    dailyLimit,
    timeoutSeconds,
    ...encrypted,
  }).onConflictDoUpdate({
    target: aiConfigs.userKey,
    set: {
      provider: body.provider,
      baseUrl,
      model,
      dailyLimit,
      timeoutSeconds,
      ...encrypted,
      encryptionVersion: 1,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  });
  const [saved] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
  return json(publicConfig(saved));
}

export async function DELETE(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  await getDb().delete(aiConfigs).where(eq(aiConfigs.userKey, userKey));
  return json({ ok: true, ...publicConfig() });
}
