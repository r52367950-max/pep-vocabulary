import { sameOriginRequest } from "@/lib/http";
import { env } from "cloudflare:workers";
import { normalizeBaseUrl, type AiProvider } from "@/lib/assistant/core";

export const AI_PROVIDER_DEFAULTS: Record<AiProvider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

const ENCRYPTION_CONTEXT = new TextEncoder().encode("pep-vocab-ai-config:v1");

export type AiCredentialScope = { userKey: string; provider: AiProvider; baseUrl: string };

function encryptionContext(version: number, scope?: AiCredentialScope) {
  if (version === 1) return ENCRYPTION_CONTEXT;
  if (version !== 2 || !scope) throw new Error("Unsupported AI credential encryption context");
  // A ciphertext copied to another user or destination must fail authentication.
  return new TextEncoder().encode(JSON.stringify(["pep-vocab-ai-config:v2", scope.userKey, scope.provider, scope.baseUrl]));
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

function masterKeyValue() {
  const value = (env as unknown as Record<string, unknown>).AI_CONFIG_ENCRYPTION_KEY;
  if (typeof value !== "string" || !value) {
    throw new Error("AI configuration encryption is not available in this deployment");
  }
  return value;
}

async function masterKey() {
  const bytes = base64ToBytes(masterKeyValue());
  if (bytes.byteLength !== 32) throw new Error("AI configuration encryption key has an invalid length");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptApiKey(value: string, scope?: AiCredentialScope) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionVersion = scope ? 2 : 1;
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encryptionContext(encryptionVersion, scope) },
    await masterKey(),
    new TextEncoder().encode(value),
  );
  return { encryptedApiKey: bytesToBase64(new Uint8Array(encrypted)), keyIv: bytesToBase64(iv), encryptionVersion };
}

export async function decryptApiKey(encryptedApiKey: string, keyIv: string, encryptionVersion = 1, scope?: AiCredentialScope) {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(keyIv), additionalData: encryptionContext(encryptionVersion, scope) },
    await masterKey(),
    base64ToBytes(encryptedApiKey),
  );
  return new TextDecoder().decode(decrypted);
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
  const allowLocal = (env as unknown as Record<string, unknown>).AI_ALLOW_INSECURE_LOCAL_BASE_URL === "true";
  const normalized = normalizeBaseUrl(value, allowLocal);
  if (provider === "deepseek") {
    const url = new URL(normalized);
    if (url.hostname === "api.deepseek.com" && (url.pathname === "/" || url.pathname === "")) {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
  }
  return normalized;
}

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
