/**
 * Response hardening for every request the Worker renders.
 *
 * Static files in `dist/client` are answered by the Cloudflare asset layer
 * before this Worker runs, so these headers cover HTML documents, RSC payloads
 * and `/api/*` responses. See docs/SECURITY_PLAN.md for the static-asset part.
 */

type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void; passThroughOnException?(): void };
type WorkerHandler<Env> = { fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response> | Response };

export type SecurityOptions = {
  /** Vite's dev client injects inline scripts without a nonce, so development skips CSP. */
  enforceContentSecurityPolicy: boolean;
};

/**
 * Every private route and the methods it exports. `tests/security-hardening`
 * compares this list with `app/api/**\/route.ts`, so a new route cannot ship
 * without being reviewed here.
 */
export const PRIVATE_API_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "/api/sync": ["GET", "POST"],
  "/api/ai/config": ["GET", "POST", "DELETE"],
  "/api/ai/test": ["POST"],
  "/api/assistant/check-sentence": ["POST"],
  "/api/assistant/contrast-words": ["POST"],
  "/api/assistant/explain": ["POST"],
  "/api/assistant/generate-practice": ["POST"],
  "/api/reading/classify": ["POST"],
};

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

/**
 * Document policy. Inline scripts emitted by vinext/React carry the per-request
 * nonce; modules, workers, OCR/PDF vendors, images and data all load from the
 * same origin. `wasm-unsafe-eval` is required by the self-hosted OCR and PDF
 * engines and does not allow string evaluation. Styles still allow inline
 * attributes because server-rendered React `style` props are inline.
 */
export function documentContentSecurityPolicy(nonce: string, secureTransport: boolean) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secureTransport ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** JSON and other non-document responses never need to load anything. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function isApiPath(pathname: string) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function secureTransport(url: URL) {
  return url.protocol === "https:";
}

const API_ERROR_MESSAGES: Record<number, { code: string; message: string }> = {
  404: { code: "not_found", message: "接口不存在。" },
  405: { code: "method_not_allowed", message: "不支持此请求方法。" },
  500: { code: "internal_error", message: "服务暂时不可用，本地学习数据没有受到影响。" },
};

export function apiErrorResponse(status: number, extra?: HeadersInit) {
  const known = API_ERROR_MESSAGES[status] || API_ERROR_MESSAGES[500];
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: known.message, code: known.code }), { status, headers });
}

function isJson(response: Response) {
  return /^application\/json\b/i.test(response.headers.get("content-type") || "");
}

/**
 * Framework-generated API errors (unknown path, unsupported method, uncaught
 * exceptions) become the same JSON shape as route errors and never carry
 * framework text or stack traces.
 */
function normalizeApiResponse(response: Response, pathname: string): Response {
  if (response.status === 404 && !isJson(response)) {
    void response.body?.cancel().catch(() => undefined);
    return apiErrorResponse(404);
  }
  if (response.status === 405 && !isJson(response)) {
    void response.body?.cancel().catch(() => undefined);
    const methods = PRIVATE_API_ROUTES[pathname.replace(/\/$/, "")];
    return apiErrorResponse(405, methods ? { allow: [...methods, "OPTIONS"].join(", ") } : undefined);
  }
  if (response.status >= 500 && !isJson(response)) {
    void response.body?.cancel().catch(() => undefined);
    return apiErrorResponse(response.status === 503 ? 503 : 500);
  }
  return response;
}

/** Headers must be mutable; responses from fetch/ASSETS can be immutable. */
function mutable(response: Response) {
  try {
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch {
    return new Response(response.body, response);
  }
}

export function applySecurityHeaders(response: Response, url: URL, nonce: string | null): Response {
  const result = mutable(response);
  const headers = result.headers;
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  headers.set("cross-origin-opener-policy", "same-origin");
  if (secureTransport(url)) headers.set("strict-transport-security", "max-age=31536000");
  if (isApiPath(url.pathname)) {
    headers.set("content-security-policy", API_CONTENT_SECURITY_POLICY);
    headers.set("cross-origin-resource-policy", "same-origin");
    // Private responses are never stored by the browser, proxies or the service worker.
    if (!/\bno-store\b/i.test(headers.get("cache-control") || "")) headers.set("cache-control", "no-store, max-age=0");
  } else if (/^text\/html\b/i.test(headers.get("content-type") || "")) {
    if (nonce) {
      headers.set("content-security-policy", documentContentSecurityPolicy(nonce, secureTransport(url)));
      // vinext marks every nonced document `no-store`. The public app shell at
      // `/` must stay storable by the service worker for offline start, and
      // `private` keeps shared caches from ever reusing its nonce.
      if (url.pathname === "/" && result.ok && /\bno-store\b/i.test(headers.get("cache-control") || "")) {
        headers.set("cache-control", "private, no-cache");
      }
    } else headers.set("content-security-policy", "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  } else if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "frame-ancestors 'none'");
  }
  return result;
}

/**
 * Wraps the vinext handler. vinext reads the script nonce from the request's
 * `content-security-policy` header and stamps it on every inline script it
 * emits, so the same policy is placed on the request and the response.
 */
export function createSecureHandler<Env>(inner: WorkerHandler<Env>, options: SecurityOptions) {
  return {
    async fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response> {
      let url: URL;
      try { url = new URL(request.url); } catch { return new Response("Bad Request", { status: 400 }); }
      const api = isApiPath(url.pathname);
      const nonce = options.enforceContentSecurityPolicy && !api ? createNonce() : null;
      let forwarded = request;
      if (nonce) {
        const headers = new Headers(request.headers);
        headers.set("content-security-policy", documentContentSecurityPolicy(nonce, secureTransport(url)));
        headers.delete("content-security-policy-report-only");
        forwarded = new Request(request, { headers });
      } else if (request.headers.has("content-security-policy")) {
        // A client-supplied value must never choose the nonce for rendered HTML.
        const headers = new Headers(request.headers);
        headers.delete("content-security-policy");
        headers.delete("content-security-policy-report-only");
        forwarded = new Request(request, { headers });
      }
      let response: Response;
      try {
        response = await inner.fetch(forwarded, env, ctx);
      } catch {
        response = api
          ? apiErrorResponse(500)
          : new Response("服务暂时不可用。", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      }
      if (api) response = normalizeApiResponse(response, url.pathname);
      return applySecurityHeaders(response, url, nonce);
    },
  };
}
