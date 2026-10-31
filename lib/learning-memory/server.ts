import { authenticatedUserKey } from "@/lib/server-user";
import { consumeRateLimit, privateJson } from "@/lib/http";
import { AssistantInputError } from "@/lib/assistant/core";
import { assistantErrorResponse, assertSameOrigin, readJsonRequest } from "@/lib/assistant/server";
import { memoryDatabase, readLearningMemory, saveLearningMemory } from "./store";
import { memoryMetadata } from "./context";

async function identity(request: Request) {
  assertSameOrigin(request);
  const key = await authenticatedUserKey();
  if (!key) throw new AssistantInputError("authentication_required", "请先登录站点。", 401);
  return key;
}
export async function getLearningMemory(request: Request) {
  try {
    const key = await identity(request), params = new URL(request.url).searchParams;
    const metadata = await memoryMetadata(key);
    if (params.get("temporary") === "1" || params.get("metadata") === "1") return privateJson({ ...metadata, ...(params.get("temporary") === "1" ? { enabled: false } : {}), notes: [], recentTopics: [] });
    return privateJson({ ...metadata, ...await readLearningMemory(key) });
  } catch (error) { return assistantErrorResponse(error); }
}
export async function putLearningMemory(request: Request) {
  try {
    const key = await identity(request), start = Math.floor(Date.now() / 60_000) * 60_000;
    const retry = await consumeRateLimit(memoryDatabase(), `voice-coach:memory:${key}:${start}`, start + 60_000, 30);
    if (retry !== null) throw new AssistantInputError("voice_rate_limited", "操作过于频繁，请稍后再试。", 429);
    const body = await readJsonRequest(request) as Record<string, unknown>;
    const metadata = await memoryMetadata(key);
    const requireScope = new URL(request.url).pathname === "/api/learning-memory";
    if ((requireScope || body?.accountScope !== undefined) && body?.accountScope !== metadata.accountScope) throw new AssistantInputError("learning_account_changed", "登录账号已变化，请重新读取学习记忆。", 409);
    const memory = await saveLearningMemory(key, body);
    return privateJson({ ...metadata, ...memory });
  } catch (error) { return assistantErrorResponse(error); }
}
