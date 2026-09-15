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
