import { getChatGPTUser } from "@/app/chatgpt-auth";

export async function authenticatedUserKey() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const bytes = new TextEncoder().encode(user.email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
