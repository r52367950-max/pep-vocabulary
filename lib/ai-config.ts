import { sameOriginRequest } from "@/lib/http";
import { env } from "cloudflare:workers";
import { normalizeBaseUrl, type AiProvider } from "@/lib/assistant/core";

export const AI_PROVIDER_DEFAULTS: Record<AiProvider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

export class AiProviderOriginError extends Error {}

const LEGACY_KEY_ID = "k1";
const KEY_ID_PATTERN = /^[a-z0-9]{1,16}$/;
const STRICT_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const VERSIONED_CIPHERTEXT_PATTERN = /^([a-z0-9]{1,16}):([A-Za-z0-9+/]+={0,2})$/;
const ENCRYPTION_UNAVAILABLE = "AI configuration encryption is not available in this deployment";

export type AiCredentialScope = { userKey: string; provider: AiProvider; baseUrl: string };
export type StoredAiCredential = { encryptedApiKey: string; keyIv: string; encryptionVersion: number };
/** The subset of D1Database used to refresh a stored credential. */
export type AiConfigStatementRunner = {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

function assertScopedEncryptionVersion(version: number) {
  if (version !== 2 && version !== 3) throw new Error("AI credential must be reentered with an authenticated scope");
}

function encryptionContext(version: number, scope: AiCredentialScope, keyId?: string) {
  assertScopedEncryptionVersion(version);
  if (!scope || typeof scope.userKey !== "string" || !scope.userKey || !isAiProvider(scope.provider) || typeof scope.baseUrl !== "string" || !scope.baseUrl) {
    throw new Error("Unsupported AI credential encryption context");
  }
  // A ciphertext copied to another user or destination must fail authentication.
  if (version === 2) return new TextEncoder().encode(JSON.stringify(["pep-vocab-ai-config:v2", scope.userKey, scope.provider, scope.baseUrl]));
  if (version === 3 && keyId) {
    // The key id is authenticated too, so a ciphertext cannot be relabelled to another key.
    return new TextEncoder().encode(JSON.stringify(["pep-vocab-ai-config:v3", keyId, scope.userKey, scope.provider, scope.baseUrl]));
  }
  throw new Error("Unsupported AI credential encryption context");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

type MasterKeyring = { keys: Map<string, string>; activeKeyId: string; versioned: boolean };

function configuredString(name: string) {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(ENCRYPTION_UNAVAILABLE);
  return value;
}

/**
 * Without AI_CONFIG_ENCRYPTION_KEYS the single legacy key is `k1` and new
 * credentials stay on format v2. With it, new credentials are written as v3
 * under AI_CONFIG_ENCRYPTION_KEY_ACTIVE. Misconfiguration fails closed.
 */
function masterKeyring(): MasterKeyring {
  const legacy = configuredString("AI_CONFIG_ENCRYPTION_KEY");
  const keysJson = configuredString("AI_CONFIG_ENCRYPTION_KEYS");
  const active = configuredString("AI_CONFIG_ENCRYPTION_KEY_ACTIVE");
  const keys = new Map<string, string>();
  if (keysJson === undefined) {
    if (active !== undefined || legacy === undefined) throw new Error(ENCRYPTION_UNAVAILABLE);
    keys.set(LEGACY_KEY_ID, legacy);
    return { keys, activeKeyId: LEGACY_KEY_ID, versioned: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(keysJson); } catch { throw new Error(ENCRYPTION_UNAVAILABLE); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(ENCRYPTION_UNAVAILABLE);
  for (const [keyId, value] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof value !== "string" || !STRICT_KEY_PATTERN.test(value) || base64ToBytes(value).byteLength !== 32) {
      throw new Error(ENCRYPTION_UNAVAILABLE);
    }
    keys.set(keyId, value);
  }
  // Format v2 predates key ids and belongs to k1. Unscoped v1 is never read.
  if (!keys.has(LEGACY_KEY_ID) && legacy !== undefined) keys.set(LEGACY_KEY_ID, legacy);
  if (!keys.size || active === undefined || !KEY_ID_PATTERN.test(active) || !keys.has(active)) throw new Error(ENCRYPTION_UNAVAILABLE);
  return { keys, activeKeyId: active, versioned: true };
}

async function importMasterKey(value: string) {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) throw new Error("AI configuration encryption key has an invalid length");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function keyById(ring: MasterKeyring, keyId: string) {
  const value = ring.keys.get(keyId);
  if (value === undefined) throw new Error("AI configuration encryption key is unavailable");
  return importMasterKey(value);
}

function storedKeyId(encryptedApiKey: string) {
  return VERSIONED_CIPHERTEXT_PATTERN.exec(encryptedApiKey)?.[1];
}

export async function encryptApiKey(value: string, scope: AiCredentialScope) {
  if (!scope) throw new Error("AI credential must be reentered with an authenticated scope");
  const ring = masterKeyring();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionVersion = ring.versioned ? 3 : 2;
  const keyId = encryptionVersion === 3 ? ring.activeKeyId : LEGACY_KEY_ID;
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encryptionContext(encryptionVersion, scope, keyId) },
    await keyById(ring, keyId),
    new TextEncoder().encode(value),
  );
  const cipher = bytesToBase64(new Uint8Array(encrypted));
  return { encryptedApiKey: encryptionVersion === 3 ? `${keyId}:${cipher}` : cipher, keyIv: bytesToBase64(iv), encryptionVersion };
}

export async function decryptApiKey(encryptedApiKey: string, keyIv: string, encryptionVersion: number, scope: AiCredentialScope) {
  assertScopedEncryptionVersion(encryptionVersion);
  const ring = masterKeyring();
  let keyId = LEGACY_KEY_ID;
  let cipher = encryptedApiKey;
  if (encryptionVersion === 3) {
    const match = VERSIONED_CIPHERTEXT_PATTERN.exec(encryptedApiKey);
    if (!match) throw new Error("Unsupported AI credential encryption context");
    [, keyId, cipher] = match;
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(keyIv), additionalData: encryptionContext(encryptionVersion, scope, keyId) },
    await keyById(ring, keyId),
    base64ToBytes(cipher),
  );
  return new TextDecoder().decode(decrypted);
}

/** True when a stored credential is not in the current write format under the active key. */
export function needsReencryption(row: { encryptedApiKey: string; encryptionVersion: number }) {
  assertScopedEncryptionVersion(row.encryptionVersion);
  const ring = masterKeyring();
  if (!ring.versioned) return row.encryptionVersion !== 2;
  return row.encryptionVersion !== 3 || storedKeyId(row.encryptedApiKey) !== ring.activeKeyId;
}

/** Decrypts with the stored key and encrypts again with the active key and format. */
export async function reencryptApiKey(row: StoredAiCredential, scope: AiCredentialScope, plaintext?: string): Promise<StoredAiCredential> {
  // Even a caller with plaintext cannot launder an unbound legacy row into a
  // mutable row's ownership/destination. The owner must submit a fresh key.
  assertScopedEncryptionVersion(row.encryptionVersion);
  const value = plaintext ?? await decryptApiKey(row.encryptedApiKey, row.keyIv, row.encryptionVersion, scope);
  return encryptApiKey(value, scope);
}

/**
 * Best-effort lazy migration for the runtime: call after a successful decrypt.
 * Updates the row only if it still holds the ciphertext that was read, so a
 * concurrent settings save is never overwritten. Never throws; resolves true
 * only when this call changed the row.
 */
export async function refreshStoredCredential(
  db: AiConfigStatementRunner,
  row: StoredAiCredential,
  scope: AiCredentialScope,
  plaintext?: string,
) {
  try {
    if (!needsReencryption(row)) return false;
    const next = await reencryptApiKey(row, scope, plaintext);
    const result = await db.prepare(
      "UPDATE ai_configs SET encrypted_api_key = ?, key_iv = ?, encryption_version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? AND encrypted_api_key = ?",
    ).bind(next.encryptedApiKey, next.keyIv, next.encryptionVersion, scope.userKey, row.encryptedApiKey).run();
    const changes = (result as { meta?: { changes?: unknown } } | undefined)?.meta?.changes;
    return typeof changes === "number" ? changes > 0 : true;
  } catch {
    return false;
  }
}

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "deepseek" || value === "openai-compatible";
}

export function validModelName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
}

export function normalizeConfiguredModel(provider: AiProvider, value: unknown) {
  if (!validModelName(value)) throw new Error("模型名格式无效。");
  if (provider === "deepseek" && (value === "deepseek-chat" || value === "deepseek-reasoner")) {
    return "deepseek-v4-flash";
  }
  return value;
}

export function validApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 512 && /^[\x21-\x7E]+$/.test(value);
}

export function normalizeApiKey(value: unknown) {
  if (typeof value !== "string") throw new Error("API Key 格式无效。");
  const normalized = value.trim();
  if (!validApiKey(normalized)) throw new Error("API Key 只能包含可打印的 ASCII 字符，且不能包含空格或换行。");
  return normalized;
}

export function normalizeConfiguredBaseUrl(value: unknown, provider?: AiProvider) {
  if (typeof value !== "string") throw new Error("Base URL 格式无效。");
  const normalized = normalizeBaseUrl(value);
  assertApprovedProviderOrigin(new URL(normalized));
  if (provider === "deepseek") {
    const url = new URL(normalized);
    if (url.hostname === "api.deepseek.com" && (url.pathname === "/" || url.pathname === "")) {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
  }
  return normalized;
}

/** Compare DNS-equivalent origins without changing the URL bound to stored credentials. */
function providerOrigin(url: URL) {
  const origin = new URL(url.origin);
  origin.hostname = origin.hostname.replace(/\.$/, "");
  return origin.origin;
}

function assertApprovedProviderOrigin(url: URL) {
  const approved = new Set(Object.values(AI_PROVIDER_DEFAULTS).map(({ baseUrl }) => providerOrigin(new URL(baseUrl))));
  const configured = env.AI_ALLOWED_PROVIDER_ORIGINS;
  if (configured !== undefined && configured !== "") {
    try {
      for (const entry of configured.split(",")) {
        const origin = new URL(normalizeBaseUrl(entry.trim()));
        if (origin.pathname !== "/" || origin.hostname.includes("*")) throw new Error();
        approved.add(providerOrigin(origin));
      }
    } catch {
      throw new AiProviderOriginError("服务端 AI_ALLOWED_PROVIDER_ORIGINS 配置无效，请联系站点管理员。");
    }
  }
  if (!approved.has(providerOrigin(url))) {
    throw new AiProviderOriginError("该 AI 服务地址尚未获站点管理员批准；请先配置 AI_ALLOWED_PROVIDER_ORIGINS。");
  }
}

/** Every probe and credentialed request checks operator policy immediately before fetch. */
export const fetchAiProvider: typeof fetch = (input, init) => {
  assertApprovedProviderOrigin(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
  return fetch(input, init);
};

export function securityHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

export function sameOriginMutation(request: Request) {
  return sameOriginRequest(request) && request.headers.get("x-vocab-action") === "settings";
}
