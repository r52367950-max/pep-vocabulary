import { getChatGPTUser } from "@/app/chatgpt-auth";

/**
 * SHA-256 of the trimmed, lower-cased gateway email. Existing cloud snapshots
 * and encrypted AI settings are stored under this key, so the derivation must
 * not change (no Unicode normalisation or alias folding) without a migration.
 */
export async function authenticatedUserKey() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const bytes = new TextEncoder().encode(user.email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
