import { env } from "cloudflare:workers";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

const ENCRYPTION_CONTEXT = new TextEncoder().encode("pep-vocab-ai-config:v1");

function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function masterKeyValue() { const value = (env as unknown as Record<string, unknown>).AI_CONFIG_ENCRYPTION_KEY; if (typeof value !== "string" || !value) throw new Error("AI configuration encryption is not available in this deployment"); return value; }
async function masterKey() { const bytes = base64ToBytes(masterKeyValue()); if (bytes.byteLength !== 32) throw new Error("AI configuration encryption key has an invalid length"); return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }

export async function encryptApiKey(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENCRYPTION_CONTEXT }, await masterKey(), new TextEncoder().encode(value));
  return { encryptedApiKey: bytesToBase64(new Uint8Array(encrypted)), keyIv: bytesToBase64(iv) };
}
export async function decryptApiKey(encryptedApiKey: string, keyIv: string) {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(keyIv), additionalData: ENCRYPTION_CONTEXT }, await masterKey(), base64ToBytes(encryptedApiKey));
  return new TextDecoder().decode(decrypted);
}
export function isDeepSeekModel(value: unknown): value is DeepSeekModel { return typeof value === "string" && DEEPSEEK_MODELS.includes(value as DeepSeekModel); }
export function validApiKey(value: unknown): value is string { return typeof value === "string" && value.length >= 20 && value.length <= 512 && !/[\r\n]/.test(value); }
export function securityHeaders() { return { "cache-control": "no-store, max-age=0", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" }; }
export function sameOriginMutation(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) return false; return request.headers.get("x-vocab-action") === "settings"; }
