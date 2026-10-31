import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { decryptApiKey } from "../lib/ai-config";
import { AssistantUpstreamError } from "../lib/assistant/core";
import { closeOpenAISession } from "../lib/voice/openai";
import { voiceDeadlineScope, type VoiceDeadlineRecord } from "../lib/voice/deadline";

const RETRY_MS = 15_000;
type ActiveDeadline = VoiceDeadlineRecord & { closing?: true };
type DeadlineState = ActiveDeadline | { closed: true };

/** Namespace-only backend control. No public route forwards requests here. */
export class VoiceDeadline {
  constructor(private readonly state: DurableObjectState, private readonly bindings: { DB?: D1Database }) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const action = new URL(request.url).pathname;
        if (action === "/arm") {
          const record = await request.json() as VoiceDeadlineRecord;
          if (!record || typeof record.userKey !== "string" || !record.userKey ||
            typeof record.sessionId !== "string" || !/^[A-Za-z0-9_-]{4,200}$/.test(record.sessionId) ||
            !Number.isSafeInteger(record.until) || record.until <= Date.now() + 60_000 ||
            record.until > Date.now() + 1_260_000 || !record.credential ||
            typeof record.credential.encryptedApiKey !== "string" || typeof record.credential.keyIv !== "string" ||
            ![2, 3].includes(record.credential.encryptionVersion)) return new Response(null, { status: 400 });
          if (await this.state.storage.get("session")) return new Response(null, { status: 409 });
          // Persist the encrypted capability and wakeup together before returning SDP.
          await this.state.storage.transaction(async (transaction) => {
            await transaction.put("session", record);
            await transaction.setAlarm(record.until - 60_000);
          });
          return Response.json({ ok: true });
        }
        if (action !== "/close") return new Response(null, { status: 404 });
        const record = await this.state.storage.get<DeadlineState>("session");
        if (!record) return new Response(null, { status: 404 });
        if (!("closed" in record)) await this.finish(record);
        return Response.json({ ok: true });
      } catch {
        // No provider text, encrypted credentials, or account identifiers in logs.
        return new Response(null, { status: 503 });
      }
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const record = await this.state.storage.get<DeadlineState>("session");
      if (!record || "closed" in record) return;
      const deadline = record.until - 60_000;
      if (!record.closing && Date.now() < deadline) { await this.state.storage.setAlarm(deadline); return; }
      // Throw as well: Cloudflare's alarm retry covers failure to persist our
      // own retry alarm, while the saved alarm covers longer provider outages.
      await this.finish(record);
    });
  }

  private async finish(record: ActiveDeadline) {
    // The retry survives eviction, network failure and credential/config deletion.
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put("session", { ...record, closing: true });
      await transaction.setAlarm(Date.now() + RETRY_MS);
    });
    const key = await decryptApiKey(record.credential.encryptedApiKey, record.credential.keyIv,
      record.credential.encryptionVersion, voiceDeadlineScope(record.userKey, record.sessionId));
    try { await closeOpenAISession(new Request("https://voice-deadline/close"), key, record.sessionId, 8_000); }
    catch (error) { if (!(error instanceof AssistantUpstreamError) || error.providerStatus !== 404) throw error; }
    if (!this.bindings.DB) throw new Error("Voice database unavailable");
    // The finalized session row fences repeated cleanup even if a newer call
    // happens to have the same timestamp lease and the DO tombstone write fails.
    // Keep both writes atomic, releasing the active lease before finalizing ours.
    await this.bindings.DB.batch([
      this.bindings.DB.prepare(`UPDATE ai_rate_limits SET request_count=0, expires_at=?
        WHERE bucket_key=? AND request_count=? AND NOT EXISTS
          (SELECT 1 FROM ai_rate_limits WHERE bucket_key=? AND request_count!=?)`)
        .bind(Date.now() + 86_400_000, `voice-active:${record.userKey}`, record.until,
          `voice-session:${record.userKey}:${record.sessionId}`, record.until),
      this.bindings.DB.prepare(`INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, 0, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET request_count=0, expires_at=excluded.expires_at WHERE request_count=?`)
        .bind(`voice-session:${record.userKey}:${record.sessionId}`, Date.now() + 86_400_000, record.until),
    ]);
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put("session", { closed: true });
      await transaction.deleteAlarm();
    });
  }
}
