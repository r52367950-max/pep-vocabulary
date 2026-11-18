import { parseChatProvenance, type ChatRequest, type ChatResult, type ChatEffort, type ChatProgress } from "@/lib/assistant/chat-contract";
import { AssistantError, usageStore, type AssistantUsage } from "@/lib/ai-client";
import { contextStillCurrent, learningContextStore, refreshLearningContext } from "@/lib/learning-context-client";
import { localPracticeGeneration, practiceGenerationCurrent } from "@/lib/local-practice-generation";
import { parseChatToolSteps, type ChatToolStep } from "@/lib/assistant/tool-trace";

export type CompanionResponse = { result: ChatResult; model: string; effort: ChatEffort | null; toolSteps: ChatToolStep[]; reasoningSummary?: string };
type ResponsePayload = {
  ok?: boolean; result?: ChatResult; model?: string; effort?: ChatEffort | null; accountScope?: string;
  contextRevision?: number; contextVersion?: string; usage?: AssistantUsage; error?: { message?: string; code?: string };
  harness?: { tools?: unknown }; reasoningSummary?: unknown;
};

async function readProgressStream(response: Response, signal: AbortSignal, current: () => void, progress?: (value: ChatProgress) => void): Promise<ResponsePayload> {
  if (!response.body) throw new AssistantError("回答连接已中断，请重试。", "stream_incomplete");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let buffer = "", bytes = 0, frames = 0;
  try {
    while (true) {
      current();
      const chunk = await reader.read();
      current();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256000) throw new AssistantError("回答内容过大，请缩短问题。", "response_too_large");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const frame = buffer.slice(0, boundary.index), end = boundary.index! + boundary[0].length;
        buffer = buffer.slice(end);
        if (!frame.trim() || frame.startsWith(":")) continue;
        if (++frames > 64) throw new AssistantError("回答进度格式无效，请重试。", "invalid_stream");
        const lines = frame.split(/\r?\n/);
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        let value: unknown;
        try { value = JSON.parse(lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")); }
        catch { throw new AssistantError("回答格式无效，请重试。", "invalid_stream"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantError("回答格式无效，请重试。", "invalid_stream");
        current();
        if (event === "result" || event === "error") return value as ResponsePayload;
        if (event !== "status") throw new AssistantError("回答进度格式无效，请重试。", "invalid_stream");
        const phase = (value as Record<string, unknown>).phase;
        if (phase !== "thinking" && phase !== "tool" && phase !== "verifying") throw new AssistantError("回答进度格式无效，请重试。", "invalid_stream");
        progress?.({ phase });
      }
    }
    throw new AssistantError("回答连接已中断，请重试。", "stream_incomplete");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestCompanion(request: ChatRequest, signal: AbortSignal, expectedScope: string, onProgress?: (value: ChatProgress) => void): Promise<CompanionResponse> {
  const generation = localPracticeGeneration();
  const memory = await refreshLearningContext(signal);
  const globalTemporary = learningContextStore.get().temporary;
  const epoch = learningContextStore.get().epoch;
  if (memory.accountScope !== expectedScope || signal.aborted || !practiceGenerationCurrent(generation)) throw new AssistantError("账户已切换，请重新发送。", "context_changed");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const unsubscribe = learningContextStore.subscribe(() => {
    if (!contextStillCurrent(memory, globalTemporary) || learningContextStore.get().epoch !== epoch) abort();
  });
  const timer = setTimeout(abort, 310_000);
  const current = () => {
    if (controller.signal.aborted || !practiceGenerationCurrent(generation) || !contextStillCurrent(memory, globalTemporary) || learningContextStore.get().epoch !== epoch) {
      throw new AssistantError("连接已中断，请重新发送。", "aborted");
    }
  };
  try {
    current();
    const response = await fetch("/api/assistant/chat", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-vocab-action": "assistant", Accept: "text/event-stream" },
      body: JSON.stringify({ ...request, temporary: request.temporary || globalTemporary, accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion }),
    });
    const payload: ResponsePayload = response.ok && /text\/event-stream/i.test(response.headers.get("content-type") || "")
      ? await readProgressStream(response, controller.signal, current, onProgress)
      : await response.json().catch(() => ({}));
    current();
    if (!response.ok || !payload?.ok || !payload.result || typeof payload.result.text !== "string") throw new AssistantError(payload?.error?.message || "发送失败，请重试。", payload?.error?.code || `http_${response.status}`);
    if (payload.result.text.length > 30000 || !Array.isArray(payload.result.actions) || (payload.reasoningSummary !== undefined && (typeof payload.reasoningSummary !== "string" || payload.reasoningSummary.length > 6000))) throw new AssistantError("回答格式无效，请重试。", "invalid_response");
    if (payload.accountScope !== memory.accountScope || payload.contextRevision !== memory.revision || (payload.contextVersion && payload.contextVersion !== memory.contextVersion)) throw new AssistantError("账户设置已更新，请重新发送。", "context_changed");
    await refreshLearningContext(controller.signal);
    current();
    if (payload.usage) usageStore.set(payload.usage);
    return { result: { ...payload.result, provenance: parseChatProvenance(payload.result.provenance) }, model: payload.model || "", effort: payload.effort ?? null, toolSteps: parseChatToolSteps(payload.harness?.tools), ...(typeof payload.reasoningSummary === "string" && payload.reasoningSummary ? { reasoningSummary: payload.reasoningSummary } : {}) };
  } finally { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); }
}
