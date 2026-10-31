import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { decryptApiKey } from "../lib/ai-config";
import { AssistantUpstreamError } from "../lib/assistant/core";
import { closeOpenAISession } from "../lib/voice/openai";
import { finalizeVoiceLease, irrecoverableVoiceClose, voiceDeadlineScope, voiceLeaseExpired, voicePendingExpiry, type VoiceDeadlineRecord, type VoiceCloseResult } from "../lib/voice/deadline";

const MAX_ATTEMPTS = 8;
const backoff = (attempt: number) => Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 300_000);
type ActiveDeadline = VoiceDeadlineRecord & { closing?: true; attempts?: number; nextAttemptAt?: number };
type FinalizingDeadline = Omit<VoiceDeadlineRecord, "credential"> & {
  finalizing: true; confirmed: boolean; reason: string; releaseAt: number;
  cleanupAttempts: number; nextCleanupAt?: number;
};
type ClosedDeadline = { closed: true; confirmed?: false; reason?: string };
type DeadlineState = ActiveDeadline | FinalizingDeadline | ClosedDeadline;

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
          await this.state.storage.transaction(async transaction => {
            await transaction.put("session", { userKey: record.userKey, sessionId: record.sessionId,
              until: record.until, credential: record.credential });
            await transaction.setAlarm(record.until - 60_000);
          });
          return Response.json({ ok: true });
        }
        if (action !== "/close") return new Response(null, { status: 404 });
        const record = await this.state.storage.get<DeadlineState>("session");
        if (!record) return new Response(null, { status: 404 });
        if (!("closed" in record)) await this.process(record);
        const result = await this.state.storage.get<DeadlineState>("session");
        if (!result || !("closed" in result)) return new Response(null, { status: 503 });
        return Response.json(this.result(result));
      } catch {
        // No provider text, ciphertext or account identifiers in logs.
        return new Response(null, { status: 503 });
      }
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const record = await this.state.storage.get<DeadlineState>("session");
      if (!record || "closed" in record) return;
      if (!("finalizing" in record) && !record.closing && Date.now() < record.until - 60_000) {
        await this.state.storage.setAlarm(record.until - 60_000); return;
      }
      // Throw when persistence fails so Cloudflare's own bounded retry can cover
      // failure to store our alarm. Stored backoff also gates those early retries.
      await this.process(record);
    });
  }

  private result(record: ClosedDeadline): VoiceCloseResult {
    return { ok: true, confirmed: record.confirmed !== false, terminal: record.confirmed === false,
      ...(record.reason ? { reason: record.reason } : {}) };
  }

  private async process(record: ActiveDeadline | FinalizingDeadline) {
    if ("finalizing" in record) { await this.cleanup(record); return; }
    if (voiceLeaseExpired(record.until)) { await this.finalize(record, false, "grace_expired"); return; }
    const attempts = Number.isSafeInteger(record.attempts) && record.attempts! >= 0 ? record.attempts! : 0;
    if (attempts >= MAX_ATTEMPTS) { await this.finalize(record, false, "retry_exhausted", voicePendingExpiry(record.until)); return; }
    if (record.nextAttemptAt && Date.now() < record.nextAttemptAt) {
      await this.state.storage.setAlarm(record.nextAttemptAt); return;
    }
    const next: ActiveDeadline = { ...record, closing: true, attempts: attempts + 1,
      nextAttemptAt: Math.min(Date.now() + backoff(attempts + 1), voicePendingExpiry(record.until)) };
    // Count before the paid provider control request, including eviction/restart.
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", next);
      await transaction.setAlarm(next.nextAttemptAt!);
    });
    let key: string;
    try { key = await decryptApiKey(record.credential.encryptedApiKey, record.credential.keyIv,
      record.credential.encryptionVersion, voiceDeadlineScope(record.userKey, record.sessionId)); }
    catch { await this.finalize(record, false, "credential_unavailable"); return; }
    try { await closeOpenAISession(new Request("https://voice-deadline/close"), key, record.sessionId, 8_000); }
    catch (error) {
      if (error instanceof AssistantUpstreamError && error.providerStatus === 404) {
        await this.finalize(record, true, "closed"); return;
      }
      if (irrecoverableVoiceClose(error)) { await this.finalize(record, false, "provider_rejected_close"); return; }
      if (next.attempts! >= MAX_ATTEMPTS) {
        await this.finalize(record, false, "retry_exhausted", voicePendingExpiry(record.until)); return;
      }
      throw error;
    }
    await this.finalize(record, true, "closed");
  }

  private async finalize(record: ActiveDeadline, confirmed: boolean, reason: string, releaseAt = Date.now()) {
    const pending: FinalizingDeadline = { userKey: record.userKey, sessionId: record.sessionId, until: record.until,
      finalizing: true, confirmed, reason, releaseAt, cleanupAttempts: 0 };
    // Strip credentials before any D1 cleanup. A failed database cannot retain a
    // revoked key or cause another request with that key after terminalization.
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", pending);
      await transaction.setAlarm(Math.max(releaseAt, Date.now() + backoff(1)));
    });
    if (Date.now() >= releaseAt) await this.cleanup(pending);
  }

  private async cleanup(record: FinalizingDeadline) {
    const now = Date.now();
    if (now < record.releaseAt) { await this.state.storage.setAlarm(record.releaseAt); return; }
    if (record.nextCleanupAt && now < record.nextCleanupAt) {
      await this.state.storage.setAlarm(record.nextCleanupAt); return;
    }
    if (record.cleanupAttempts >= MAX_ATTEMPTS) {
      // D1 recovery cannot run forever either. The admission CAS independently
      // reclaims the finite lease at the same grace boundary, even for old rows.
      if (!voiceLeaseExpired(record.until, now)) {
        await this.state.storage.transaction(async transaction => {
          await transaction.put("session", { ...record, nextCleanupAt: voicePendingExpiry(record.until) });
          await transaction.setAlarm(voicePendingExpiry(record.until));
        });
        return;
      }
      await this.storeClosed({ closed: true, confirmed: false, reason: "cleanup_unavailable" }); return;
    }
    const next: FinalizingDeadline = { ...record, cleanupAttempts: record.cleanupAttempts + 1,
      nextCleanupAt: now + backoff(record.cleanupAttempts + 1) };
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", next);
      await transaction.setAlarm(next.nextCleanupAt!);
    });
    if (!this.bindings.DB) throw new Error("Voice database unavailable");
    await finalizeVoiceLease(this.bindings.DB, record.userKey, record.sessionId, record.until, now);
    await this.storeClosed(record.confirmed ? { closed: true } : { closed: true, confirmed: false, reason: record.reason });
  }

  private async storeClosed(record: ClosedDeadline) {
    await this.state.storage.transaction(async transaction => {
      await transaction.put("session", record);
      await transaction.deleteAlarm();
    });
  }
}
