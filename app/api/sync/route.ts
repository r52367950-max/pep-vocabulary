import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncStates } from "@/db/schema";
import { USER_DATA_SCHEMA_VERSION } from "@/lib/storage";
import { authenticatedUserKey } from "@/lib/server-user";

const MAX_PAYLOAD_BYTES = 5_000_000;

export async function GET() {
  const key = await authenticatedUserKey();
  if (!key) return Response.json({ error: "Private sync requires the authenticated site identity." }, { status: 401 });
  try {
    const [row] = await getDb().select().from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
    return Response.json({ state: row || null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Sync storage unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const key = await authenticatedUserKey();
  if (!key) return Response.json({ error: "Private sync requires the authenticated site identity." }, { status: 401 });
  let body: { schemaVersion?: string; baseRevision?: number; clientUpdatedAt?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.schemaVersion !== USER_DATA_SCHEMA_VERSION || !body.clientUpdatedAt || !body.payload) return Response.json({ error: "schemaVersion, clientUpdatedAt and payload are required" }, { status: 400 });
  if (typeof body.payload !== "object" || (body.payload as { schemaVersion?: string }).schemaVersion !== USER_DATA_SCHEMA_VERSION) return Response.json({ error: "payload schema does not match request schema" }, { status: 400 });
  const payload = JSON.stringify(body.payload);
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return Response.json({ error: "Backup exceeds the 5 MB private-sync limit; use file export instead." }, { status: 413 });
  const db = getDb();
  const [current] = await db.select().from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
  if (current && typeof body.baseRevision === "number" && current.revision !== body.baseRevision) {
    return Response.json({ error: "revision-conflict", state: current }, { status: 409 });
  }
  const nextRevision = (current?.revision || 0) + 1;
  await db.insert(syncStates).values({ userKey: key, revision: nextRevision, schemaVersion: body.schemaVersion, payload, clientUpdatedAt: body.clientUpdatedAt })
    .onConflictDoUpdate({
      target: syncStates.userKey,
      set: { revision: nextRevision, schemaVersion: body.schemaVersion, payload, clientUpdatedAt: body.clientUpdatedAt, serverUpdatedAt: sql`CURRENT_TIMESTAMP` },
    });
  return Response.json({ revision: nextRevision, serverUpdatedAt: new Date().toISOString() });
}
