import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

const MAX_EMAIL_LENGTH = 254;
const MAX_ENCODED_FULL_NAME_LENGTH = 1024;
const MAX_FULL_NAME_LENGTH = 200;
const TRUSTED_HOSTS_SETTING = "IDENTITY_TRUSTED_HOSTS";

/**
 * The identity headers are trusted only because the hosting gateway replaces
 * any client-supplied copies. These checks do not change who is admitted on
 * that gateway; they reject values the gateway would never send (repeated
 * headers joined by commas, whitespace, control characters, oversized input).
 */
export function gatewayEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  if (/[\s,;<>"\\\u0000-\u001f\u007f]/.test(email)) return null;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  return email;
}

/**
 * Optional deployment guard, off unless the owner sets `IDENTITY_TRUSTED_HOSTS`
 * (comma-separated host names). When set, identity headers arriving on any
 * other host — for example the same Worker reached without the gateway — are
 * ignored, so forged headers cannot authenticate there.
 */
export function identityHostTrusted(host: string | null, setting: unknown): boolean {
  if (typeof setting !== "string" || !setting.trim()) return true;
  if (!host) return false;
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "");
  return setting.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).includes(hostname);
}

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const email = gatewayEmail(requestHeaders.get(USER_EMAIL_HEADER));
  if (!email) return null;
  if (!identityHostTrusted(requestHeaders.get("host"), (env as unknown as Record<string, unknown>)[TRUSTED_HOSTS_SETTING])) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const decodedFullName =
    encodedFullName &&
    encodedFullName.length <= MAX_ENCODED_FULL_NAME_LENGTH &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;
  const fullName =
    decodedFullName &&
    decodedFullName.length <= MAX_FULL_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(decodedFullName)
      ? decodedFullName
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
