import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncStates } from "@/db/schema";
import { USER_DATA_SCHEMA_VERSION, validateBackup } from "@/lib/storage";
import { authenticatedUserKey } from "@/lib/server-user";
import { readJsonObject, RequestBodyError, sameOriginRequest } from "@/lib/http";

const MAX_PAYLOAD_BYTES = 5_000_000;
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" } });
}

export async function GET() {
  try {
    const key = await authenticatedUserKey();
    if (!key) return json({ error: "Private sync requires the authenticated site identity." }, 401);
    const [row] = await getDb().select().from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
    // Identity lets the client bind a revision to the account it actually read.
    const state = row ? { schemaVersion: row.schemaVersion, payload: row.payload, revision: row.revision,
      clientUpdatedAt: row.clientUpdatedAt, serverUpdatedAt: row.serverUpdatedAt } : null;
    return json({ identity: key, state });
  } catch { return json({ error: "Sync storage unavailable" }, 503); }
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return json({ error: "Invalid request origin" }, 403);
  try {
    const key = await authenticatedUserKey();
    if (!key) return json({ error: "Private sync requires the authenticated site identity." }, 401);
    const body = await readJsonObject(request, MAX_PAYLOAD_BYTES + 4096);
    if (body.expectedIdentity !== undefined && body.expectedIdentity !== key) return json({ error: "identity-conflict" }, 409);
    if (body.schemaVersion !== USER_DATA_SCHEMA_VERSION || typeof body.clientUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.clientUpdatedAt)) ||
      typeof body.baseRevision !== "number" || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0 || body.baseRevision >= Number.MAX_SAFE_INTEGER) {
      return json({ error: "Valid schemaVersion, clientUpdatedAt and baseRevision are required" }, 400);
    }
    let payload: string;
    try {
      if (!body.payload || (body.payload as { schemaVersion?: unknown }).schemaVersion !== body.schemaVersion) return json({ error: "payload schema does not match request schema" }, 400);
      payload = JSON.stringify(validateBackup(body.payload));
    } catch { return json({ error: "Invalid backup payload" }, 400); }
    if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return json({ error: "Backup exceeds the 5 MB private-sync limit; use file export instead." }, 413);
    const db = getDb();
    const values = { schemaVersion: body.schemaVersion, payload, clientUpdatedAt: body.clientUpdatedAt };
    // Compare and swap in ONE SQL statement, including the first-upload race.
    const rows = body.baseRevision === 0
      ? await db.insert(syncStates).values({ userKey: key, revision: 1, ...values }).onConflictDoNothing().returning({ revision: syncStates.revision, serverUpdatedAt: syncStates.serverUpdatedAt })
      : await db.update(syncStates).set({ ...values, revision: sql`${syncStates.revision} + 1`, serverUpdatedAt: sql`CURRENT_TIMESTAMP` })
        .where(sql`${syncStates.userKey} = ${key} AND ${syncStates.revision} = ${body.baseRevision}`)
        .returning({ revision: syncStates.revision, serverUpdatedAt: syncStates.serverUpdatedAt });
    if (!rows.length) return json({ error: "revision-conflict" }, 409);
    return json({ ...rows[0], identity: key });
  } catch (error) {
    if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
    return json({ error: "Sync storage unavailable" }, 503);
  }
}
