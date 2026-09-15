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
export async function readJsonObject(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError("请求必须使用 application/json。", 415);
  }
  if (Number(request.headers.get("content-length")) > maximumBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError("请求内容过大。", 413);
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", total = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
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
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("请求不是有效 JSON。");
  } finally {
    reader?.releaseLock();
  }
}
