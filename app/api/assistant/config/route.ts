import { getChatGPTUser } from "@/app/chatgpt-auth";
import { AssistantInputError } from "@/lib/assistant/core";
import { safeAiConfig, saveAiConfig } from "@/lib/assistant/config";
import { assistantErrorResponse, assertSameOrigin, readJsonRequest } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export async function GET() {
  try {
    const user = await getChatGPTUser();
    if (!user) throw new AssistantInputError("authentication_required", "查看 AI 配置需要经过站点身份验证。", 401);
    return Response.json({ ok: true, config: await safeAiConfig(user.email) }, { headers: noStoreHeaders });
  } catch (error) {
    return assistantErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await getChatGPTUser();
    if (!user) throw new AssistantInputError("authentication_required", "修改 AI 配置需要经过站点身份验证。", 401);
    const body = await readJsonRequest(request);
    const config = await saveAiConfig(user.email, body);
    return Response.json({ ok: true, config }, { headers: noStoreHeaders });
  } catch (error) {
    return assistantErrorResponse(error);
  }
}
