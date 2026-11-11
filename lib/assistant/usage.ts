import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { budgetDay, readBucket } from "../http";
import type { CompletionUsage } from "./core";

export const DEFAULT_TOKEN_BUDGET = 200_000;

export class TokenBudgetError extends Error {
  constructor(readonly retryAfter: number) {
    super("今天剩余的 AI token 预算不足。北京时间 0 点重置，也可以在设置中调整预算。");
  }
}

function database(): D1Database {
  if (!env.DB) throw new Error("Usage storage unavailable");
  return env.DB;
}

function tokenKeys(userKey: string, now = Date.now()) {
  const day = budgetDay(now);
  return { day, total: `tokens:day:${userKey}:${day.start}`, cacheHit: `tokens-hit:day:${userKey}:${day.start}`, output: `tokens-out:day:${userKey}:${day.start}` };
}

/** One round trip for the three counters. Total includes unsettled reservations. */
export async function readTokenUsage(userKey: string) {
  const keys = tokenKeys(userKey);
  const { results } = await database().prepare(
    "SELECT bucket_key, request_count FROM ai_rate_limits WHERE bucket_key IN (?, ?, ?)",
  ).bind(keys.total, keys.cacheHit, keys.output).all<{ bucket_key: string; request_count: number }>();
  const counts = new Map(results.map((row) => [row.bucket_key, row.request_count]));
  return { date: keys.day.label, total: counts.get(keys.total) || 0, cacheHit: counts.get(keys.cacheHit) || 0,
    output: counts.get(keys.output) || 0, resetsAt: new Date(keys.day.expiresAt).toISOString() };
}

export type TokenReservation = {
  keys: ReturnType<typeof tokenKeys>;
  amount: number;
  promptEstimate: number;
  maxOutputTokens: number;
};

function tokenEstimate(text: string) {
  return Math.max(Math.ceil(new TextEncoder().encode(text).byteLength / 3), Math.ceil(text.length / 2));
}

/**
 * Reserve before contacting a paid provider. The conditional UPSERT, not the
 * preliminary read, decides admission across isolates. Prompt tokens are an
 * estimate (providers tokenize differently); this is not a provider billing cap.
 * Incomplete/failed calls retain their reservation until the budget day ends,
 * except the output part of a request the provider rejected before generating.
 */
export async function reserveTokens(userKey: string, budget: number, prompt: string, outputCap: number, now = Date.now(), minimumOutputTokens = Math.min(256, outputCap)): Promise<TokenReservation> {
  const db = database();
  const keys = tokenKeys(userKey, now);
  const used = await readBucket(db, keys.total);
  const promptEstimate = tokenEstimate(prompt) + 256;
  const maxOutputTokens = Math.min(outputCap, budget - used - promptEstimate);
  const exhausted = () => new TokenBudgetError(Math.max(1, Math.ceil((keys.day.expiresAt - now) / 1000)));
  if (maxOutputTokens < minimumOutputTokens) throw exhausted();
  const amount = promptEstimate + maxOutputTokens;
  const row = await db.prepare(
    `INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at)
     SELECT ?, ?, ? WHERE ? <= ?
     ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + excluded.request_count
     WHERE request_count + excluded.request_count <= ?
     RETURNING request_count`,
  ).bind(keys.total, amount, keys.day.expiresAt, amount, budget, budget).first();
  if (!row) throw exhausted();
  return { keys, amount, promptEstimate, maxOutputTokens };
}

/**
 * A redirect or client-error status (other than 408) arrives before any output
 * is generated. Server errors, timeouts and broken streams stay ambiguous.
 */
export function providerRejectedBeforeGeneration(status: number | null) {
  return status !== null && status >= 300 && status < 500 && status !== 408;
}

async function releaseReservedTokens(reservation: TokenReservation, amount: number) {
  try {
    await database().prepare("UPDATE ai_rate_limits SET request_count = MAX(0, request_count - ?) WHERE bucket_key = ?")
      .bind(amount, reservation.keys.total).run();
  } catch {
    // Accounting failure keeps the whole reservation, as for any other failed call.
  }
}

/** Returns the reserved output tokens; the prompt estimate stays charged. Never throws. */
export function releaseOutputReservation(reservation: TokenReservation) {
  return releaseReservedTokens(reservation, reservation.maxOutputTokens);
}

/** Only for a failed local preflight: no request reached the provider. Never throws. */
export function releaseUnusedReservation(reservation: TokenReservation) {
  return releaseReservedTokens(reservation, reservation.amount);
}

/** Provider reports cannot refund below independently estimated prompt and actual output. */
export async function settleTokens(reservation: TokenReservation, reported: CompletionUsage, content: string): Promise<{ today: number | null; usage: CompletionUsage }> {
  const db = database();
  const { keys, amount } = reservation;
  const floor = reservation.promptEstimate + tokenEstimate(content);
  // A bounded margin accommodates tokenizer differences and audio counters.
  // Untrusted telemetry outside this per-call envelope retains the reservation.
  const ceiling = Math.max(amount * 4, floor);
  const valid = [reported.prompt, reported.completion, reported.cacheHit, reported.total].every(value => Number.isSafeInteger(value) && value >= 0 && value <= ceiling)
    && reported.total === reported.prompt + reported.completion && reported.cacheHit <= reported.prompt;
  const usage = valid
    ? { ...reported, total: Math.max(reported.total, floor), estimated: reported.estimated || reported.total < floor }
    : { prompt: reservation.promptEstimate, completion: tokenEstimate(content), cacheHit: 0, total: Math.max(amount, floor), estimated: true };
  const increment = (key: string, delta: number) => db.prepare(
    `INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + excluded.request_count
     RETURNING request_count`,
  ).bind(key, delta, keys.day.expiresAt);
  try {
    const [total] = await db.batch<{ request_count: number }>([
      increment(keys.total, usage.total - amount),
      increment(keys.cacheHit, usage.cacheHit),
      increment(keys.output, usage.completion),
    ]);
    return { today: total.results[0]?.request_count ?? null, usage };
  } catch {
    // Never refund when accounting failed: later requests still see the reserve.
    return { today: null, usage };
  }
}
