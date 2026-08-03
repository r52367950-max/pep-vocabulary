import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiConfigs } from "@/db/schema";
import { authenticatedUserKey } from "@/lib/server-user";
import { DEEPSEEK_BASE_URL, encryptApiKey, isDeepSeekModel, sameOriginMutation, securityHeaders, validApiKey } from "@/lib/ai-config";

const DEFAULT_CONFIG = { provider: "deepseek" as const, baseUrl: DEEPSEEK_BASE_URL, model: "deepseek-v4-flash" as const, dailyLimit: 30, timeoutSeconds: 25 };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: securityHeaders() }); }
function publicConfig(row?: typeof aiConfigs.$inferSelect) { return { provider: "deepseek", baseUrl: DEEPSEEK_BASE_URL, model: row?.model || DEFAULT_CONFIG.model, dailyLimit: row?.dailyLimit || DEFAULT_CONFIG.dailyLimit, timeoutSeconds: row?.timeoutSeconds || DEFAULT_CONFIG.timeoutSeconds, hasApiKey: Boolean(row?.encryptedApiKey), updatedAt: row?.updatedAt || null, secretStorage: "server-encrypted" }; }

export async function GET() {
  const userKey = await authenticatedUserKey(); if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  try { const [row] = await getDb().select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1); return json(publicConfig(row)); }
  catch { return json({ error: "暂时无法读取 API 配置。" }, 503); }
}

export async function POST(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey(); if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  if (Number(request.headers.get("content-length") || 0) > 4096) return json({ error: "配置请求过大。" }, 413);
  let body: { model?: unknown; dailyLimit?: unknown; timeoutSeconds?: unknown; apiKey?: unknown };
  try { body = await request.json(); } catch { return json({ error: "配置格式无效。" }, 400); }
  if (!isDeepSeekModel(body.model)) return json({ error: "请选择受支持的 DeepSeek 模型。" }, 400);
  const dailyLimit = Number(body.dailyLimit), timeoutSeconds = Number(body.timeoutSeconds);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 5 || dailyLimit > 200) return json({ error: "每日调用上限应为 5–200。" }, 400);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 60) return json({ error: "超时时间应为 10–60 秒。" }, 400);
  const db = getDb(); const [current] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1);
  let encrypted = current ? { encryptedApiKey: current.encryptedApiKey, keyIv: current.keyIv } : null;
  if (body.apiKey !== undefined && body.apiKey !== "") { if (!validApiKey(body.apiKey)) return json({ error: "API Key 格式无效。" }, 400); try { encrypted = await encryptApiKey(body.apiKey); } catch { return json({ error: "当前部署尚未启用安全密钥存储。" }, 503); } }
  if (!encrypted) return json({ error: "首次配置时需要填写 API Key。" }, 400);
  await db.insert(aiConfigs).values({ userKey, ...DEFAULT_CONFIG, model: body.model, dailyLimit, timeoutSeconds, ...encrypted }).onConflictDoUpdate({ target: aiConfigs.userKey, set: { provider: DEFAULT_CONFIG.provider, baseUrl: DEFAULT_CONFIG.baseUrl, model: body.model, dailyLimit, timeoutSeconds, ...encrypted, encryptionVersion: 1, updatedAt: sql`CURRENT_TIMESTAMP` } });
  const [saved] = await db.select().from(aiConfigs).where(eq(aiConfigs.userKey, userKey)).limit(1); return json(publicConfig(saved));
}

export async function DELETE(request: Request) {
  if (!sameOriginMutation(request)) return json({ error: "请求来源验证失败。" }, 403);
  const userKey = await authenticatedUserKey(); if (!userKey) return json({ error: "需要通过站点身份验证后管理 API 配置。" }, 401);
  await getDb().delete(aiConfigs).where(eq(aiConfigs.userKey, userKey)); return json({ ok: true, ...publicConfig() });
}
