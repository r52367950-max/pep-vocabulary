import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncStates } from "@/db/schema";
import { USER_DATA_SCHEMA_VERSION, validateBackup } from "@/lib/storage";
import { authenticatedUserKey } from "@/lib/server-user";
import { consumeRateLimit, privateJson, RateLimitStoreError, rateLimitWindow, readJsonObject, RequestBodyError, sameOriginRequest } from "@/lib/http";

const MAX_PAYLOAD_BYTES = 5_000_000;
// A person syncs a few times a day; these bounds only stop runaway clients and
// repeated 5 MB writes from exhausting D1.
const SYNC_REQUESTS_PER_MINUTE = 30;
const SYNC_WRITES_PER_DAY = 200;

const BODY_ERROR_CODES: Record<number, string> = { 408: "request_timeout", 413: "payload_too_large", 415: "unsupported_media_type" };

// `error` stays a string because the backup screen shows it directly; conflict
// codes keep their historical values so older clients still recognise them.
function failure(status: number, code: string, message: string, extra?: HeadersInit) {
  return privateJson({ error: message, code }, status, extra);
}
const conflict = (code: "identity-conflict" | "revision-conflict") => failure(409, code, code);
const unauthenticated = () => failure(401, "authentication_required", "Private sync requires the authenticated site identity.");
const unavailable = () => failure(503, "storage_unavailable", "Sync storage unavailable");

class SyncRateLimited extends Error {
  constructor(readonly retryAfter: number) { super("rate limited"); }
}

async function enforceSyncRateLimit(userKey: string, write: boolean) {
  const db = env.DB;
  const now = Date.now();
  const minute = rateLimitWindow(now, 60_000);
  let retryAfter: number | null;
  try {
    retryAfter = await consumeRateLimit(db, `sync:minute:${userKey}:${minute.start}`, minute.expiresAt, SYNC_REQUESTS_PER_MINUTE, now);
    if (retryAfter === null && write) {
      const day = rateLimitWindow(now, 86_400_000);
      retryAfter = await consumeRateLimit(db, `sync:write-day:${userKey}:${day.start}`, day.expiresAt, SYNC_WRITES_PER_DAY, now);
    }
  } catch (error) {
    // Only guards against runaway clients: a deployment without the limiter
    // table keeps syncing as before. Any other store failure still answers 503.
    if (error instanceof RateLimitStoreError && error.migrationRequired) return;
    throw error;
  }
  if (retryAfter !== null) throw new SyncRateLimited(retryAfter);
  if (crypto.getRandomValues(new Uint8Array(1))[0] < 2) {
    // Awaited: a promise left pending after the response may be dropped by the runtime.
    await db?.prepare("DELETE FROM ai_rate_limits WHERE expires_at < ?").bind(now - 86_400_000).run().catch(() => undefined);
  }
}

function rateLimited(error: SyncRateLimited) {
  return failure(429, "rate_limited", `云端同步请求过于频繁，请在 ${error.retryAfter} 秒后重试。本地学习不受影响。`, { "retry-after": String(error.retryAfter) });
}

export async function GET() {
  try {
    const key = await authenticatedUserKey();
    if (!key) return unauthenticated();
    await enforceSyncRateLimit(key, false);
    const [row] = await getDb().select().from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
    // Identity lets the client bind a revision to the account it actually read.
    const state = row ? { schemaVersion: row.schemaVersion, payload: row.payload, revision: row.revision,
      clientUpdatedAt: row.clientUpdatedAt, serverUpdatedAt: row.serverUpdatedAt } : null;
    return privateJson({ identity: key, state });
  } catch (error) {
    if (error instanceof SyncRateLimited) return rateLimited(error);
    return unavailable();
  }
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return failure(403, "invalid_origin", "Invalid request origin");
  try {
    const key = await authenticatedUserKey();
    if (!key) return unauthenticated();
    await enforceSyncRateLimit(key, true);
    const body = await readJsonObject(request, MAX_PAYLOAD_BYTES + 4096);
    if (body.expectedIdentity !== undefined && body.expectedIdentity !== key) return conflict("identity-conflict");
    if (body.schemaVersion !== USER_DATA_SCHEMA_VERSION || typeof body.clientUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.clientUpdatedAt)) ||
      typeof body.baseRevision !== "number" || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || body.baseRevision >= Number.MAX_SAFE_INTEGER) {
      return failure(400, "invalid_request", "Valid schemaVersion, clientUpdatedAt and baseRevision are required");
    }
    let payload: string;
    try {
      if (!body.payload || (body.payload as { schemaVersion?: unknown }).schemaVersion !== body.schemaVersion) return failure(400, "invalid_payload", "payload schema does not match request schema");
      payload = JSON.stringify(validateBackup(body.payload));
    } catch { return failure(400, "invalid_payload", "Invalid backup payload"); }
    if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return failure(413, "payload_too_large", "Backup exceeds the 5 MB private-sync limit; use file export instead.");
    const db = getDb();
    const values = { schemaVersion: body.schemaVersion, payload, clientUpdatedAt: body.clientUpdatedAt };
    // Compare and swap in ONE SQL statement, including the first-upload race.
    const rows = body.baseRevision === 0
      ? await db.insert(syncStates).values({ userKey: key, revision: 1, ...values }).onConflictDoNothing().returning({ revision: syncStates.revision, serverUpdatedAt: syncStates.serverUpdatedAt })
      : await db.update(syncStates).set({ ...values, revision: sql`${syncStates.revision} + 1`, serverUpdatedAt: sql`CURRENT_TIMESTAMP` })
        .where(sql`${syncStates.userKey} = ${key} AND ${syncStates.revision} = ${body.baseRevision}`)
        .returning({ revision: syncStates.revision, serverUpdatedAt: syncStates.serverUpdatedAt });
    if (!rows.length) return conflict("revision-conflict");
    return privateJson({ ...rows[0], identity: key });
  } catch (error) {
    if (error instanceof SyncRateLimited) return rateLimited(error);
    if (error instanceof RequestBodyError) return failure(error.status, BODY_ERROR_CODES[error.status] || "invalid_request", error.message);
    return unavailable();
  }
}
