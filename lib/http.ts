export class RequestBodyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export function sameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  return (!origin || origin === new URL(request.url).origin) &&
    request.headers.get("sec-fetch-site") !== "cross-site";
}

// Enforce the limit while reading, including chunked requests without Content-Length.
export async function readJsonObject(request: Request, maximumBytes: number, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError("请求必须使用 application/json。", 415);
  }
  if (Number(request.headers.get("content-length")) > maximumBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError("请求内容过大。", 413);
  }
  if (request.signal.aborted) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError("请求读取已取消，请重试。", 408);
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", total = 0;
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RequestBodyError("请求读取已取消，请重试。", 408));
    request.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(new RequestBodyError("请求读取超时，请重试。", 408)), timeoutMs);
  });
  try {
    if (reader) {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), interrupted]);
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          void reader.cancel().catch(() => undefined);
          throw new RequestBodyError("请求内容过大。", 413);
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestBodyError("请求必须是 JSON 对象。");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    // Cancellation itself can stall on a broken producer, so never await it.
    void reader?.cancel().catch(() => undefined);
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("请求不是有效 JSON。");
  } finally {
    clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

/** Private JSON responses: never cached, never sniffed. */
export function privateJson(body: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

type RateLimitStatement = { bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> } };
export type RateLimitStore = { prepare(query: string): RateLimitStatement };

export class RateLimitStoreError extends Error {
  constructor(readonly migrationRequired: boolean) {
    super(migrationRequired ? "rate limit table missing" : "rate limit store unavailable");
    this.name = "RateLimitStoreError";
  }
}

/** Fixed windows aligned to UTC so every isolate counts in the same bucket. */
export function rateLimitWindow(now: number, lengthMs: number) {
  const start = Math.floor(now / lengthMs) * lengthMs;
  return { start, expiresAt: start + lengthMs };
}

/**
 * Atomically counts one request in a D1 bucket. Every private limiter shares
 * the `ai_rate_limits` table through key prefixes, so no new migration is
 * needed. Returns the seconds to wait when the bucket is over its limit, or
 * `null` when the request may proceed.
 */
export async function consumeRateLimit(db: RateLimitStore | undefined, bucketKey: string, expiresAt: number, limit: number, now = Date.now()): Promise<number | null> {
  if (!db) throw new RateLimitStoreError(false);
  let row: { request_count: number } | null;
  try {
    row = await db.prepare(
      `INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`,
    ).bind(bucketKey, expiresAt).first<{ request_count: number }>();
  } catch (error) {
    throw new RateLimitStoreError(error instanceof Error && /no such table|SQLITE_ERROR.*ai_rate_limits/i.test(error.message));
  }
  if (Number(row?.request_count || 0) > limit) return Math.max(1, Math.ceil((expiresAt - now) / 1000));
  return null;
}
