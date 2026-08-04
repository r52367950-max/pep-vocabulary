export type AssistantUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  reasoningTokens: number | null;
};

export type AssistantMeta = {
  durationMs: number;
  maxOutputTokens: number;
  usage: AssistantUsage;
  cache?: "hit" | "miss" | "bypass";
};

export type AssistantResponse<T> = {
  ok: true;
  task: string;
  provider: string;
  model: string;
  result: T;
  meta: AssistantMeta;
};

type AssistantErrorPayload = {
  ok?: false;
  error?: { message?: string; retryable?: boolean } | string;
};

export class AssistantClientError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "AssistantClientError";
    this.status = status;
    this.retryable = retryable;
  }
}

const TASK_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  explain: 285_000,
  search: 140_000,
  "analyze-learning": 190_000,
  "plan-study": 240_000,
});

export async function postAssistant<T>(task: string, body: Record<string, unknown>, timeoutMs = TASK_TIMEOUT_MS[task] ?? 35_000): Promise<AssistantResponse<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/assistant/${encodeURIComponent(task)}`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload: AssistantResponse<T> | AssistantErrorPayload;
    try {
      payload = await response.json() as AssistantResponse<T> | AssistantErrorPayload;
    } catch {
      throw new AssistantClientError("AI 服务返回了无法识别的数据。", response.status || 502, true);
    }
    if (!response.ok || payload.ok !== true) {
      const error = (payload as AssistantErrorPayload).error;
      const message = typeof error === "string" ? error : error?.message || "AI 服务暂时不可用。";
      throw new AssistantClientError(message, response.status, typeof error === "object" && error?.retryable === true);
    }
    return payload;
  } catch (error) {
    if (error instanceof AssistantClientError) throw error;
    if (controller.signal.aborted) throw new AssistantClientError("AI 请求已超时；本地学习不受影响。", 504, true);
    throw new AssistantClientError("无法连接词迹 AI 服务；本地学习不受影响。", 503, true);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function compactUsage(meta: AssistantMeta | null | undefined) {
  if (!meta) return "";
  const completion = meta.usage.completionTokens;
  const hit = meta.usage.promptCacheHitTokens;
  const miss = meta.usage.promptCacheMissTokens;
  const totalPrompt = (hit ?? 0) + (miss ?? 0);
  const cacheRate = hit !== null && totalPrompt > 0 ? Math.round(hit / totalPrompt * 100) : null;
  return [
    `${meta.durationMs} ms`,
    completion === null ? null : `输出 ${completion} tokens`,
    cacheRate === null ? null : `前缀缓存 ${cacheRate}%`,
  ].filter(Boolean).join(" · ");
}
