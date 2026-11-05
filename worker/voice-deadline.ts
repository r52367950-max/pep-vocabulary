import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { decryptApiKey } from "../lib/ai-config";
import { AssistantUpstreamError } from "../lib/assistant/core";
import { closeOpenAISession } from "../lib/voice/openai";
import { voiceDeadlineScope, type VoiceDeadlineRecord } from "../lib/voice/deadline";

const MAX_ATTEMPTS = 8;
const backoff = (attempt: number) => Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 300_000);
type ActiveDeadline = VoiceDeadlineRecord & { closing?: true; attempts?: number; nextAttemptAt?: number };
type FinalizingDeadline = Omit<VoiceDeadlineRecord, "credential"> & { finalizing: true; attempts: number; nextAttemptAt?: number };
type TerminalDeadline = { terminal: true; reason: string };
type DeadlineState = ActiveDeadline | FinalizingDeadline | TerminalDeadline | { closed: true };

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
        if (!("closed" in record) && !("terminal" in record)) await this.finish(record);
        const result = await this.state.storage.get<DeadlineState>("session");
        if (result && "closed" in result) return Response.json({ ok: true });
        // Older clients also treat non-2xx as unconfirmed. Never release admission.
        return Response.json({ terminal: Boolean(result && "terminal" in result) }, { status: 503 });
      } catch {
        // No provider text, encrypted credentials, or account identifiers in logs.
        return new Response(null, { status: 503 });
      }
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const record = await this.state.storage.get<DeadlineState>("session");
      if (!record || "closed" in record || "terminal" in record) return;
      const deadline = record.until - 60_000;
      if (!("finalizing" in record) && !record.closing && Date.now() < deadline) { await this.state.storage.setAlarm(deadline); return; }
      // Throw as well: Cloudflare's alarm retry covers failure to persist our
      // own retry alarm, while the saved alarm covers longer provider outages.
      await this.finish(record);
    });
  }

  private async terminal(reason: string) {
    // No credential or automatic retry remains; D1 retains the unconfirmed lock.
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", { terminal: true, reason });
      await transaction.deleteAlarm();
    });
  }

  private async finish(record: ActiveDeadline | FinalizingDeadline) {
    if (record.nextAttemptAt && Date.now() < record.nextAttemptAt) {
      await this.state.storage.setAlarm(record.nextAttemptAt); return;
    }
    const attempts = record.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) { await this.terminal("retry_exhausted"); return; }
    const next = { ...record, attempts: attempts + 1, nextAttemptAt: Date.now() + backoff(attempts + 1) };
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", "finalizing" in next ? next : { ...next, closing: true });
      await transaction.setAlarm(next.nextAttemptAt);
    });
    if ("finalizing" in record) {
      try { await this.cleanup(record); }
      catch (error) {
        if (next.attempts >= MAX_ATTEMPTS) { await this.terminal("cleanup_unavailable"); return; }
        throw error;
      }
      return;
    }
    let key: string;
    try { key = await decryptApiKey(record.credential.encryptedApiKey, record.credential.keyIv,
      record.credential.encryptionVersion, voiceDeadlineScope(record.userKey, record.sessionId)); }
    catch { await this.terminal("credential_unavailable"); return; }
    try { await closeOpenAISession(new Request("https://voice-deadline/close"), key, record.sessionId, 8_000); }
    catch (error) {
      if (!(error instanceof AssistantUpstreamError && error.providerStatus === 404)) {
        if (error instanceof AssistantUpstreamError && !error.retryable && error.providerStatus !== null &&
          error.providerStatus >= 400 && error.providerStatus < 500 && ![408, 409, 425, 429].includes(error.providerStatus)) {
          await this.terminal("provider_rejected_close"); return;
        }
        if (next.attempts >= MAX_ATTEMPTS) { await this.terminal("retry_exhausted"); return; }
        throw error;
      }
    }
    // A confirmed close moves to a credential-free cleanup state BEFORE D1.
    // Retrying cleanup never repeats provider calls, and preserves the CAS fence.
    const pending: FinalizingDeadline = { userKey: record.userKey, sessionId: record.sessionId,
      until: record.until, finalizing: true, attempts: 0 };
    await this.state.storage.put("session", pending);
    await this.finish(pending);
  }

  private async cleanup(record: FinalizingDeadline) {
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
