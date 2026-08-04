import { env } from "cloudflare:workers";
import { AssistantInputError, normalizeBaseUrl, sameAiCredentialScope, type AiProvider } from "./core";
import { decryptSecret, encryptSecret, hashIdentity, SecretCryptoError } from "./crypto";

type AssistantBindings = {
  ASSETS?: Fetcher;
  DB?: D1Database;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_PROVIDER?: string;
  AI_CONFIG_ENCRYPTION_KEY?: string;
  AI_CONFIG_ADMIN_EMAILS?: string;
  AI_ALLOW_INSECURE_LOCAL_BASE_URL?: string;
  AI_REQUEST_TIMEOUT_MS?: string;
  AI_RATE_LIMIT_PER_MINUTE?: string;
  AI_RATE_LIMIT_PER_DAY?: string;
};

type StoredConfigRow = {
  provider: string;
  base_url: string;
  model: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  updated_at: string;
};

export type AiRuntimeConfig = {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  source: "database" | "environment";
};

export type SafeAiConfig = {
  configured: boolean;
  source: "database" | "environment" | "unconfigured";
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  canManage: boolean;
  updatedAt: string | null;
};

export class AiConfigurationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "AiConfigurationError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULTS: Record<AiProvider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

export function assistantBindings(): AssistantBindings {
  return env as unknown as AssistantBindings;
}

function provider(value: unknown, fallback: AiProvider = "deepseek"): AiProvider {
  return value === "openai-compatible" || value === "deepseek" ? value : fallback;
}

function modelName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new AssistantInputError("invalid_model", "模型名必须是字符串。");
  const result = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(result)) {
    throw new AssistantInputError("invalid_model", "模型名只能包含字母、数字、点、下划线、冒号、斜杠和连字符。");
  }
  return result;
}

function configuredApiKey(value: unknown): string {
  if (typeof value !== "string") throw new AssistantInputError("invalid_api_key", "API key 必须是字符串。");
  const result = value.trim();
  if (result.length < 8 || result.length > 4096) {
    throw new AssistantInputError("invalid_api_key", "API key 长度不符合要求。");
  }
  return result;
}

function allowInsecureLocal(bindings = assistantBindings()): boolean {
  return bindings.AI_ALLOW_INSECURE_LOCAL_BASE_URL === "true";
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table|SQLITE_ERROR.*ai_provider_config/i.test(error.message);
}

async function storedConfig(bindings = assistantBindings()): Promise<StoredConfigRow | null> {
  if (!bindings.DB) return null;
  try {
    return await bindings.DB.prepare(
      "SELECT provider, base_url, model, api_key_ciphertext, api_key_iv, updated_at FROM ai_provider_config WHERE id = ? LIMIT 1",
    ).bind("default").first<StoredConfigRow>();
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw new AiConfigurationError("config_storage_unavailable", "AI 服务端配置暂时无法读取。");
  }
}

async function decryptApiKey(ciphertext: string, iv: string, secret: string): Promise<string> {
  try {
    return configuredApiKey(await decryptSecret(ciphertext, iv, secret));
  } catch (error) {
    if (error instanceof SecretCryptoError && error.code === "encryption_key_missing") {
      throw new AiConfigurationError("encryption_key_missing", "服务端缺少有效的 AI_CONFIG_ENCRYPTION_KEY Secret。");
    }
    throw new AiConfigurationError("config_decryption_failed", "已保存的 AI 密钥无法解密，请重新配置。");
  }
}

export { hashIdentity };

export function canManageAiConfig(email: string, bindings = assistantBindings()): boolean {
  const allowed = (bindings.AI_CONFIG_ADMIN_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

function environmentConfig(bindings = assistantBindings()): AiRuntimeConfig | null {
  if (!bindings.AI_API_KEY) return null;
  const selectedProvider = provider(bindings.AI_PROVIDER, bindings.AI_BASE_URL?.includes("deepseek") ? "deepseek" : "openai-compatible");
  const defaults = DEFAULTS[selectedProvider];
  return {
    provider: selectedProvider,
    baseUrl: normalizeBaseUrl(bindings.AI_BASE_URL || defaults.baseUrl, allowInsecureLocal(bindings)),
    model: modelName(bindings.AI_MODEL, defaults.model),
    apiKey: configuredApiKey(bindings.AI_API_KEY),
    source: "environment",
  };
}

export async function loadAiRuntimeConfig(bindings = assistantBindings()): Promise<AiRuntimeConfig> {
  const row = await storedConfig(bindings);
  if (row) {
    if (!bindings.AI_CONFIG_ENCRYPTION_KEY) {
      throw new AiConfigurationError("encryption_key_missing", "服务端缺少 AI_CONFIG_ENCRYPTION_KEY Secret，无法读取已保存的模型密钥。");
    }
    const selectedProvider = provider(row.provider);
    return {
      provider: selectedProvider,
      baseUrl: normalizeBaseUrl(row.base_url, allowInsecureLocal(bindings)),
      model: modelName(row.model, DEFAULTS[selectedProvider].model),
      apiKey: await decryptApiKey(row.api_key_ciphertext, row.api_key_iv, bindings.AI_CONFIG_ENCRYPTION_KEY),
      source: "database",
    };
  }
  const fallback = environmentConfig(bindings);
  if (fallback) return fallback;
  throw new AiConfigurationError("ai_not_configured", "服务端尚未配置模型接口；本地学习仍可正常使用。");
}

export async function safeAiConfig(email: string, bindings = assistantBindings()): Promise<SafeAiConfig> {
  const row = await storedConfig(bindings);
  if (row) {
    const selectedProvider = provider(row.provider);
    return {
      configured: Boolean(row.api_key_ciphertext),
      source: "database",
      provider: selectedProvider,
      baseUrl: normalizeBaseUrl(row.base_url, allowInsecureLocal(bindings)),
      model: modelName(row.model, DEFAULTS[selectedProvider].model),
      hasApiKey: Boolean(row.api_key_ciphertext),
      canManage: canManageAiConfig(email, bindings),
      updatedAt: row.updated_at,
    };
  }
  const fallback = environmentConfig(bindings);
  if (fallback) {
    return {
      configured: true,
      source: "environment",
      provider: fallback.provider,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
      hasApiKey: true,
      canManage: canManageAiConfig(email, bindings),
      updatedAt: null,
    };
  }
  return {
    configured: false,
    source: "unconfigured",
    provider: "deepseek",
    baseUrl: DEFAULTS.deepseek.baseUrl,
    model: DEFAULTS.deepseek.model,
    hasApiKey: false,
    canManage: canManageAiConfig(email, bindings),
    updatedAt: null,
  };
}

export async function saveAiConfig(
  email: string,
  value: unknown,
  bindings = assistantBindings(),
): Promise<SafeAiConfig> {
  if (!canManageAiConfig(email, bindings)) {
    throw new AiConfigurationError("config_forbidden", "当前账号没有修改服务端 AI 配置的权限。", 403);
  }
  if (!bindings.DB) throw new AiConfigurationError("config_storage_unavailable", "D1 未绑定，无法保存服务端 AI 配置。");
  if (!bindings.AI_CONFIG_ENCRYPTION_KEY) {
    throw new AiConfigurationError("encryption_key_missing", "请先在 Sites Secrets 中设置 AI_CONFIG_ENCRYPTION_KEY。", 503);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantInputError("invalid_request", "配置必须是 JSON 对象。");
  }
  const body = value as Record<string, unknown>;
  const selectedProvider = provider(body.provider);
  const defaults = DEFAULTS[selectedProvider];
  const baseUrl = normalizeBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : defaults.baseUrl, allowInsecureLocal(bindings));
  const model = modelName(body.model, defaults.model);
  const current = await storedConfig(bindings);
  const hasReplacementKey = body.apiKey !== undefined && body.apiKey !== "";
  if (current && !hasReplacementKey) {
    const currentProvider = provider(current.provider);
    const currentBaseUrl = normalizeBaseUrl(current.base_url, allowInsecureLocal(bindings));
    if (!sameAiCredentialScope(
      { provider: currentProvider, baseUrl: currentBaseUrl },
      { provider: selectedProvider, baseUrl },
    )) {
      throw new AssistantInputError(
        "api_key_required_for_destination_change",
        "修改接口类型或 Base URL 时必须重新填写 API key。",
      );
    }
  }
  const apiKey = hasReplacementKey
    ? configuredApiKey(body.apiKey)
    : current && await decryptApiKey(current.api_key_ciphertext, current.api_key_iv, bindings.AI_CONFIG_ENCRYPTION_KEY);
  if (!apiKey) throw new AssistantInputError("api_key_required", "首次保存服务端配置时必须填写 API key。");
  let encrypted: { ciphertext: string; iv: string };
  try {
    encrypted = await encryptSecret(apiKey, bindings.AI_CONFIG_ENCRYPTION_KEY);
  } catch {
    throw new AiConfigurationError("encryption_key_missing", "服务端缺少有效的 AI_CONFIG_ENCRYPTION_KEY Secret。");
  }
  const updatedBy = await hashIdentity(email);

  try {
    await bindings.DB.prepare(
      `INSERT INTO ai_provider_config (id, provider, base_url, model, api_key_ciphertext, api_key_iv, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         base_url = excluded.base_url,
         model = excluded.model,
         api_key_ciphertext = excluded.api_key_ciphertext,
         api_key_iv = excluded.api_key_iv,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind("default", selectedProvider, baseUrl, model, encrypted.ciphertext, encrypted.iv, updatedBy).run();
  } catch (error) {
    if (isMissingTable(error)) {
      throw new AiConfigurationError("config_migration_required", "AI 配置表尚未创建，请先部署本分支附带的 D1 迁移。");
    }
    throw new AiConfigurationError("config_storage_unavailable", "AI 服务端配置保存失败，请稍后重试。");
  }
  return safeAiConfig(email, bindings);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function assistantLimits(bindings = assistantBindings()) {
  return {
    timeoutMs: boundedInteger(bindings.AI_REQUEST_TIMEOUT_MS, 20_000, 5_000, 60_000),
    perMinute: boundedInteger(bindings.AI_RATE_LIMIT_PER_MINUTE, 12, 1, 120),
    perDay: boundedInteger(bindings.AI_RATE_LIMIT_PER_DAY, 200, 10, 5_000),
  };
}
