/**
 * The agent loop behind the chat assistant.
 *
 * One turn is: ask the model, run the tools it asked for, hand the results back, and repeat
 * until it answers in text. The loop is deliberately small and provider-neutral:
 *
 *  - The transcript only grows. System prompt, tool list and earlier messages keep their
 *    bytes from one model call to the next, so a provider's prefix cache keeps hitting.
 *  - Tools are read-only, so a step runs every call it was given, in order, without approval.
 *  - Every bound is fixed here: model calls per turn, tool calls per step, the size of
 *    arguments and results, and one deadline for the whole turn. On the last allowed call
 *    the model is told to answer without tools, so a turn always ends in an answer or an error.
 *  - A tool never fails the turn. Bad arguments, unknown names and thrown errors all come
 *    back as a result the model can read and correct.
 *
 * Paying for and metering each model call is the caller's job (`callModel`).
 */
import type { ToolContext, ToolDefinition } from "./tools";

export type ToolCall = { id: string; name: string; arguments: string };
/** Chat Completions message shapes; the Responses adapter converts from these. */
export type HarnessMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ModelTurn = { content: string; toolCalls: ToolCall[]; finishReason: string | null };
export type ToolMode = "auto" | "none";
export type HarnessStep = { tool: string; label: string; ok: boolean };
export type HarnessResult = { content: string; finishReason: string | null; steps: HarnessStep[]; modelCalls: number };

export const HARNESS_LIMITS = { modelCalls: 4, toolCallsPerStep: 4, argumentChars: 6000, resultChars: 6000, turnMs: 300_000 } as const;

export class HarnessDeadlineError extends Error {}

export function toolSchemas(tools: readonly ToolDefinition[]) {
  return tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

function clip(text: string, maximum: number) {
  return text.length > maximum ? `${text.slice(0, maximum)}\n…（结果过长，已截断；请缩小范围后重试）` : text;
}

/** Runs one call and always returns text for the model. */
export function executeTool(call: ToolCall, tools: readonly ToolDefinition[], context: ToolContext): { step: HarnessStep; content: string } {
  const tool = tools.find((item) => item.name === call.name);
  const failed = (error: string) => ({ step: { tool: call.name.slice(0, 64), label: tool?.label ?? "", ok: false }, content: JSON.stringify({ error }) });
  if (!tool) return failed(`没有名为 ${call.name.slice(0, 64)} 的工具。可用的工具：${tools.map((item) => item.name).join("、")}`);
  if (call.arguments.length > HARNESS_LIMITS.argumentChars) return failed("参数过长");
  let args: unknown;
  try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch { return failed("参数不是有效的 JSON 对象"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) return failed("参数需要是 JSON 对象");
  try {
    const result = tool.run(args as Record<string, unknown>, context);
    const ok = !(result && typeof result === "object" && "error" in result);
    return { step: { tool: tool.name, label: tool.label, ok }, content: clip(JSON.stringify(result) ?? "null", HARNESS_LIMITS.resultChars) };
  } catch { return failed("工具运行失败"); }
}

export async function runHarness(options: {
  messages: HarnessMessage[];
  tools: readonly ToolDefinition[];
  context: ToolContext;
  /** One metered model call. `toolMode` "none" asks for a text answer; `remainingMs` is what is left of the turn. */
  callModel: (messages: HarnessMessage[], toolMode: ToolMode, remainingMs: number) => Promise<ModelTurn>;
  limits?: Partial<typeof HARNESS_LIMITS>;
  now?: () => number;
}): Promise<HarnessResult> {
  const limits = { ...HARNESS_LIMITS, ...options.limits }, now = options.now ?? Date.now, deadline = now() + limits.turnMs;
  const transcript = [...options.messages], steps: HarnessStep[] = [];
  for (let call = 1; ; call++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new HarnessDeadlineError("turn deadline reached");
    const last = call >= limits.modelCalls || !options.tools.length;
    const turn = await options.callModel(transcript, last ? "none" : "auto", remaining);
    if (last || !turn.toolCalls.length) return { content: turn.content, finishReason: turn.finishReason, steps, modelCalls: call };
    const calls = turn.toolCalls.map((item, index) => ({ ...item, id: item.id || `call_${call}_${index}` }));
    transcript.push({ role: "assistant", content: turn.content, tool_calls: calls.map((item) => ({ id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } })) });
    calls.forEach((item, index) => {
      if (index >= limits.toolCallsPerStep) { transcript.push({ role: "tool", tool_call_id: item.id, content: JSON.stringify({ error: `一次最多调用 ${limits.toolCallsPerStep} 个工具，这一个没有运行` }) }); return; }
      const { step, content } = executeTool(item, options.tools, options.context);
      steps.push(step);
      transcript.push({ role: "tool", tool_call_id: item.id, content });
    });
  }
}
