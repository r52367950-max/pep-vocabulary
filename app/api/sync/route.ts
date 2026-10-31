import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncStates } from "@/db/schema";
import { USER_DATA_SCHEMA_VERSION, validateBackup } from "@/lib/backup";
import { authenticatedUserKey } from "@/lib/server-user";
import { consumeRateLimit, privateJson, RateLimitStoreError, rateLimitWindow, readJsonObject, RequestBodyError, sameOriginRequest } from "@/lib/http";
import { MAX_SYNC_PAYLOAD_BYTES, MAX_SYNC_REQUEST_BYTES, SYNC_TOO_LARGE_MESSAGE } from "@/lib/sync-limits";

// Bound all persisted text as well as the payload. Leave 50 KB below D1's
// 2,000,000-byte row limit for integer fields, SQLite headers and future metadata.
const MAX_ROW_TEXT_BYTES = 1_950_000;
// A person syncs a few times a day; these bounds only stop runaway clients and
// repeated large writes from exhausting D1.
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

export async function GET(request?: Request) {
  try {
    const key = await authenticatedUserKey();
    if (!key) return unauthenticated();
    await enforceSyncRateLimit(key, false);
    const metadataOnly = request && new URL(request.url).searchParams.get("metadata") === "1";
    if (metadataOnly) {
      const [state] = await getDb().select({ schemaVersion: syncStates.schemaVersion, revision: syncStates.revision,
        clientUpdatedAt: syncStates.clientUpdatedAt, serverUpdatedAt: syncStates.serverUpdatedAt }).from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
      return privateJson({ identity: key, state: state ?? null });
    }
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
    const body = await readJsonObject(request, MAX_SYNC_REQUEST_BYTES);
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
    const utf8 = new TextEncoder();
    const payloadBytes = utf8.encode(payload).byteLength;
    // CURRENT_TIMESTAMP is generated by SQLite (19 ASCII bytes). Count it and
    // the entire client timestamp rather than assuming metadata is short.
    const rowTextBytes = payloadBytes + utf8.encode(key).byteLength + utf8.encode(body.schemaVersion).byteLength + utf8.encode(body.clientUpdatedAt).byteLength + 19;
    if (payloadBytes > MAX_SYNC_PAYLOAD_BYTES || rowTextBytes > MAX_ROW_TEXT_BYTES) return failure(413, "payload_too_large", SYNC_TOO_LARGE_MESSAGE);
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
    if (error instanceof RequestBodyError) return failure(error.status, BODY_ERROR_CODES[error.status] || "invalid_request", error.status === 413 ? SYNC_TOO_LARGE_MESSAGE : error.message);
    return unavailable();
  }
}
