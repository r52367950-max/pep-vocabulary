import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncStates } from "@/db/schema";
import { getChatGPTUser } from "@/app/chatgpt-auth";

const MAX_PAYLOAD_BYTES = 2_000_000;

async function userKey() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const bytes = new TextEncoder().encode(user.email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function GET() {
  const key = await userKey();
  if (!key) return Response.json({ error: "Private sync requires the authenticated site identity." }, { status: 401 });
  try {
    const [row] = await getDb().select().from(syncStates).where(eq(syncStates.userKey, key)).limit(1);
    return Response.json({ state: row || null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Sync storage unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const key = await userKey();
  if (!key) return Response.json({ error: "Private sync requires the authenticated site identity." }, { status: 401 });
  let body: { schemaVersion?: string; baseRevision?: number; clientUpdatedAt?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.schemaVersion !== "1.0.0" || !body.clientUpdatedAt || !body.payload) return Response.json({ error: "schemaVersion, clientUpdatedAt and payload are required" }, { status: 400 });
  const payload = JSON.stringify(body.payload);
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return Response.json({ error: "Backup exceeds the 2 MB private-sync limit; use file export instead." }, { status: 413 });
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
