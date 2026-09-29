import { readJsonObject, RequestBodyError } from "@/lib/http";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiConfigs, aiPreferences } from "@/db/schema";
import {
  AI_PROVIDER_DEFAULTS,
  encryptApiKey,
  isAiProvider,
  needsReencryption,
  normalizeConfiguredBaseUrl,
  normalizeConfiguredModel,
  normalizeApiKey,
  reencryptApiKey,
  sameOriginMutation,
  securityHeaders,
} from "@/lib/ai-config";
import { knownOutputLimit, OUTPUT_TOKEN_TARGET, resolveMaxOutputTokens, sameAiCredentialScope, type AiProvider } from "@/lib/assistant/core";
import { DEFAULT_TOKEN_BUDGET, readTokenUsage } from "@/lib/assistant/usage";
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

const TOKEN_BUDGET_RANGE = [10_000, 5_000_000] as const;
const OUTPUT_CAP_RANGE = [256, OUTPUT_TOKEN_TARGET] as const;

/** Missing rows use defaults; failed preference reads never relax a saved budget. */
async function usageConfig(userKey: string, model: string) {
  let preferences: typeof aiPreferences.$inferSelect | undefined;
  [preferences] = await getDb().select().from(aiPreferences).where(eq(aiPreferences.userKey, userKey)).limit(1);
  const maxOutputTokens = preferences?.maxOutputTokens ?? null;
  let usageToday = null;
  try { usageToday = await readTokenUsage(userKey); } catch { /* usage unavailable */ }
  return {
    dailyTokenBudget: preferences?.dailyTokenBudget || DEFAULT_TOKEN_BUDGET,
    maxOutputTokens,
    effectiveMaxOutputTokens: resolveMaxOutputTokens(model, maxOutputTokens),
    modelOutputLimit: knownOutputLimit(model),
    usageToday,
  };
}

export async function GET() {
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  try {
    const [row] = await getDb().select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
    const config = publicConfig(row);
    return json({ ...config, ...(await usageConfig(userKey, config.model)) });
  } catch {
    return json({ error: "暂时无法读取 API 配置。" }, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request, 4096); }
  catch (error) { return json({ error: error instanceof RequestBodyError ? error.message : "配置格式无效。" }, error instanceof RequestBodyError ? error.status : 400); }

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
  const dailyTokenBudget = body.dailyTokenBudget === undefined ? undefined : Number(body.dailyTokenBudget);
  if (dailyTokenBudget !== undefined && (!Number.isInteger(dailyTokenBudget) || dailyTokenBudget < TOKEN_BUDGET_RANGE[0] || dailyTokenBudget > TOKEN_BUDGET_RANGE[1])) {
    return json({ error: "每日 token 预算应为 1 万–500 万。" }, 400);
  }
  const maxOutputTokens = body.maxOutputTokens === undefined || body.maxOutputTokens === null ? null : Number(body.maxOutputTokens);
  if (maxOutputTokens !== null && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < OUTPUT_CAP_RANGE[0] || maxOutputTokens > OUTPUT_CAP_RANGE[1])) {
    return json({ error: `输出上限应为 ${OUTPUT_CAP_RANGE[0]}–${OUTPUT_CAP_RANGE[1]}。` }, 400);
  }

  try {
    const db = getDb();
    const [current] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
    const scope = { userKey, provider: body.provider, baseUrl };
    let encrypted: { encryptedApiKey: string; keyIv: string; encryptionVersion: number } | null = null;
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
        encrypted = { encryptedApiKey: current.encryptedApiKey, keyIv: current.keyIv, encryptionVersion: current.encryptionVersion };
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
        encrypted = await encryptApiKey(apiKey, scope);
      } catch {
        return json({ error: "当前部署尚未启用安全密钥存储。" }, 503);
      }
    }
    if (!encrypted) {
      return json({ error: current ? "更换服务商或 Base URL 时必须重新填写 API Key。" : "首次配置时需要填写 API Key。" }, 400);
    }
    try {
      // Retaining a credential moves it to the current format and active key without asking the browser for it.
      if (needsReencryption(encrypted)) encrypted = await reencryptApiKey(encrypted, scope);
    } catch {
      return json({ error: "无法升级当前密钥存储，请重新填写 API Key。" }, 503);
    }

    // Compare the exact configuration read above. A racing key replacement or
    // deletion cannot be resurrected by a model-only save retaining an old key.
    const binding = env.DB;
    if (!binding) throw new Error("Configuration store unavailable");
    const writeToken = crypto.randomUUID();
    const values = [body.provider, baseUrl, model, dailyLimit, timeoutSeconds,
      encrypted.encryptedApiKey, encrypted.keyIv, encrypted.encryptionVersion, writeToken];
    const configWrite = current
      ? binding.prepare(`UPDATE ai_configs SET provider=?, base_url=?, model=?, daily_limit=?, timeout_seconds=?,
          encrypted_api_key=?, key_iv=?, encryption_version=?, write_token=?, updated_at=CURRENT_TIMESTAMP
          WHERE user_key=? AND write_token=? AND encrypted_api_key=? AND key_iv=? RETURNING user_key`)
        .bind(...values, userKey, current.writeToken, current.encryptedApiKey, current.keyIv)
      : binding.prepare(`INSERT INTO ai_configs (provider, base_url, model, daily_limit, timeout_seconds,
          encrypted_api_key, key_iv, encryption_version, write_token, user_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_key) DO NOTHING RETURNING user_key`).bind(...values, userKey);
    const writes = [configWrite];
    if (dailyTokenBudget !== undefined || body.maxOutputTokens !== undefined) {
      // This write runs only if THIS batch won the config CAS. The unique token
      // also prevents a losing batch from changing the winner's preferences.
      writes.push(binding.prepare(`INSERT INTO ai_preferences (user_key, daily_token_budget, max_output_tokens)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ai_configs WHERE user_key=? AND write_token=?)
        ON CONFLICT(user_key) DO UPDATE SET
          daily_token_budget=CASE WHEN ? THEN excluded.daily_token_budget ELSE ai_preferences.daily_token_budget END,
          max_output_tokens=CASE WHEN ? THEN excluded.max_output_tokens ELSE ai_preferences.max_output_tokens END,
          updated_at=CURRENT_TIMESTAMP`)
        .bind(userKey, dailyTokenBudget ?? DEFAULT_TOKEN_BUDGET, maxOutputTokens, userKey, writeToken,
          dailyTokenBudget !== undefined ? 1 : 0, body.maxOutputTokens !== undefined ? 1 : 0));
    }
    const [written] = await binding.batch(writes);
    if (!written.results.length) return json({ error: "API 配置已在其他页面修改或移除，请重新打开设置后再保存。", code: "configuration_conflict" }, 409);
    const [saved] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
    const config = publicConfig(saved);
    return json({ ...config, ...(await usageConfig(userKey, config.model)) });
  } catch { return json({ error: "暂时无法保存 API 配置。" }, 503); }
}

export async function DELETE(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey();
  if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  try {
    await getDb().delete(aiConfigs).where(eq(aiConfigs.userKey, userKey));
    return json({ ok: true, ...publicConfig() });
  } catch { return json({ error: "暂时无法移除 API 配置。" }, 503); }
}
