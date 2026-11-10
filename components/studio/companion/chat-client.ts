import type { ChatRequest, ChatResult, ChatEffort, ChatStep } from "@/lib/assistant/chat-contract";
import { AssistantError, usageStore, type AssistantUsage } from "@/lib/ai-client";
import { contextStillCurrent, learningContextStore, refreshLearningContext } from "@/lib/learning-context-client";
import { localPracticeGeneration, practiceGenerationCurrent } from "@/lib/local-practice-generation";

export type CompanionResponse = { result: ChatResult; model: string; effort: ChatEffort | null; steps: ChatStep[] };
export async function requestCompanion(request: ChatRequest, signal: AbortSignal, expectedScope: string): Promise<CompanionResponse> {
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
      headers: { "Content-Type": "application/json", "x-vocab-action": "assistant" },
      body: JSON.stringify({ ...request, temporary: request.temporary || globalTemporary, accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion }),
    });
    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean; result?: ChatResult; model?: string; effort?: ChatEffort | null; steps?: unknown; accountScope?: string;
      contextRevision?: number; contextVersion?: string; usage?: AssistantUsage; error?: { message?: string; code?: string };
    };
    current();
    if (!response.ok || !payload.ok || !payload.result || typeof payload.result.text !== "string") throw new AssistantError(payload.error?.message || "发送失败，请重试。", payload.error?.code || `http_${response.status}`);
    if (payload.accountScope !== memory.accountScope || payload.contextRevision !== memory.revision || (payload.contextVersion && payload.contextVersion !== memory.contextVersion)) throw new AssistantError("账户设置已更新，请重新发送。", "context_changed");
    await refreshLearningContext(controller.signal);
    current();
    if (payload.usage) usageStore.set(payload.usage);
    const steps = Array.isArray(payload.steps) ? payload.steps.filter((step): step is ChatStep => typeof step?.label === "string" && typeof step?.tool === "string").slice(0, 16).map((step) => ({ tool: step.tool.slice(0, 40), label: step.label.slice(0, 20) })) : [];
    return { result: payload.result, model: payload.model || "", effort: payload.effort ?? null, steps };
  } finally { clearTimeout(timer); unsubscribe(); signal.removeEventListener("abort", abort); }
}
