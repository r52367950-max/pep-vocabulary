import { readJsonRequest, requireRequestUser } from "@/lib/assistant/request";
import { consumeRateLimit, privateJson, rateLimitWindow } from "@/lib/http";
import { AssistantInputError } from "@/lib/assistant/core";
import { assistantErrorResponse } from "@/lib/assistant/server";
import { memoryDatabase } from "@/lib/learning-memory/store";
import { accountScope } from "@/lib/learning-memory/context";
import { appendJournalEvent, journalDays, journalMetadata, mutateJournal } from "./store";
import { dateInZone, timezone } from "./input";

async function view(key: string, zone: string, metadataOnly = false, temporary = false) {
  const meta = await journalMetadata(key);
  return {
    accountScope: await accountScope(key),
    ...meta,
    ...(temporary ? { enabled: false } : {}),
    timezone: zone,
    today: dateInZone(new Date().toISOString(), zone),
    days: metadataOnly || temporary ? [] : await journalDays(key),
  };
}

export async function getJournal(request: Request) {
  try {
    const key = await requireRequestUser(request);
    const params = new URL(request.url).searchParams;
    const zone = timezone(params.get("timezone") ?? "UTC");
    return privateJson(await view(key, zone, params.get("metadata") === "1", params.get("temporary") === "1"));
  } catch (error) { return assistantErrorResponse(error); }
}

export async function writeJournal(request: Request, method: "POST" | "PUT" | "DELETE") {
  try {
    const key = await requireRequestUser(request);
    const body = await readJsonRequest(request);
    if (body.accountScope !== await accountScope(key)) throw new AssistantInputError("learning_account_changed", "登录账号已变化，请重新读取学习记录。", 409);
    if (body.temporary !== undefined && typeof body.temporary !== "boolean") throw new AssistantInputError("invalid_request", "临时会话参数无效。");
    if (body.temporary) throw new AssistantInputError("temporary_memory_write", "临时会话不保存学习记录。", 409);
    const window = rateLimitWindow(Date.now(), 60_000);
    const retry = await consumeRateLimit(memoryDatabase(), `learning-journal:${key}:${window.start}`, window.expiresAt, 120);
    if (retry !== null) throw new AssistantInputError("journal_rate_limited", "学习记录更新较频繁，请稍后重试。", 429);

    const zone = timezone(body.timezone ?? "UTC");
    if (method === "POST") {
      const result = await appendJournalEvent(key, body);
      return privateJson({ ...await view(key, zone), ...result });
    }
    await mutateJournal(key, body, method);
    return privateJson(await view(key, zone));
  } catch (error) { return assistantErrorResponse(error); }
}
