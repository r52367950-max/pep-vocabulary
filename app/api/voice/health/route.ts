import { env } from "cloudflare:workers";
import { privateJson, readBucket, sameOriginRequest } from "@/lib/http";

export const dynamic = "force-dynamic";

// Deployment readiness only: no visitor records, credentials, or paid API calls.
// The private Site gateway also protects service callers of this endpoint.
export async function GET(request: Request) {
  if (!sameOriginRequest(request)) return privateJson({ ok: false }, 403);
  let stage = "binding";
  try {
    if (!env.DB) throw new Error("Missing DB binding");
    stage = "usage-read";
    await readBucket(env.DB, "voice-health:nonexistent");
    stage = "active-session-read";
    const row = await env.DB.prepare("SELECT bucket_key, request_count FROM ai_rate_limits WHERE bucket_key LIKE ? AND request_count > 0 ORDER BY expires_at DESC LIMIT 1")
      .bind("voice-health:nonexistent:%").first<{ bucket_key: string; request_count: number }>();
    if (row && typeof row.bucket_key !== "string") throw new Error("Unexpected empty-row shape");
    return privateJson({ ok: true, storage: "ready", paidApiCalled: false });
  } catch (error) {
    console.error("voice-storage-health", { stage, message: error instanceof Error ? error.message : "unknown" });
    return privateJson({ ok: false, stage, code: "voice_storage_unavailable", paidApiCalled: false }, 503);
  }
}
