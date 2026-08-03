import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiConfigs } from "@/db/schema";
import { authenticatedUserKey } from "@/lib/server-user";
import { decryptApiKey, sameOriginMutation, securityHeaders } from "@/lib/ai-config";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: securityHeaders() }); }
export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey(); if (!userKey) return json({ error: "需要通过站点身份验证后测试 API。" }, 401);
  const [config] = await getDb().select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1); if (!config) return json({ error: "请先保存 API 配置。" }, 400);
  let apiKey: string; try { apiKey = await decryptApiKey(config.encryptedApiKey, config.keyIv); } catch { return json({ error: "无法解密当前密钥，请重新保存 API Key。" }, 503); }
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Math.min(60, Math.max(10, config.timeoutSeconds)) * 1000); const startedAt = Date.now();
  try {
    const response = await fetch(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: controller.signal });
    if (!response.ok) { const message = response.status === 401 || response.status === 403 ? "API Key 无效或没有权限。" : `DeepSeek 返回 HTTP ${response.status}。`; return json({ error: message }, response.status === 429 ? 429 : 502); }
    const result = await response.json() as { data?: Array<{ id?: string }> }; const models = Array.isArray(result.data) ? result.data.map((item) => item.id).filter((id): id is string => Boolean(id)).slice(0, 20) : [];
    return json({ ok: true, latencyMs: Date.now() - startedAt, selectedModel: config.model, modelAvailable: models.includes(config.model) });
  } catch (error) { return json({ error: error instanceof Error && error.name === "AbortError" ? "连接超时，请稍后重试。" : "无法连接 DeepSeek 官方接口。" }, 502); }
  finally { clearTimeout(timeout); apiKey = ""; }
}
