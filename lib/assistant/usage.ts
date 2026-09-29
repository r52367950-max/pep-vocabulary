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
  maxOutputTokens: number;
};

/**
 * Reserve before contacting a paid provider. The conditional UPSERT, not the
 * preliminary read, decides admission across isolates. Prompt tokens are an
 * estimate (providers tokenize differently); this is not a provider billing cap.
 * Incomplete/failed calls retain their reservation until the budget day ends.
 */
export async function reserveTokens(userKey: string, budget: number, prompt: string, outputCap: number, now = Date.now()): Promise<TokenReservation> {
  const db = database();
  const keys = tokenKeys(userKey, now);
  const used = await readBucket(db, keys.total);
  const promptEstimate = Math.max(Math.ceil(new TextEncoder().encode(prompt).byteLength / 3), Math.ceil(prompt.length / 2)) + 256;
  const maxOutputTokens = Math.min(outputCap, budget - used - promptEstimate);
  const exhausted = () => new TokenBudgetError(Math.max(1, Math.ceil((keys.day.expiresAt - now) / 1000)));
  if (maxOutputTokens < Math.min(256, outputCap)) throw exhausted();
  const amount = promptEstimate + maxOutputTokens;
  const row = await db.prepare(
    `INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at)
     SELECT ?, ?, ? WHERE ? <= ?
     ON CONFLICT(bucket_key) DO UPDATE SET request_count = request_count + excluded.request_count
     WHERE request_count + excluded.request_count <= ?
     RETURNING request_count`,
  ).bind(keys.total, amount, keys.day.expiresAt, amount, budget, budget).first();
  if (!row) throw exhausted();
  return { keys, amount, maxOutputTokens };
}

/** All counters settle together, or the original conservative reservation stays. */
export async function settleTokens(reservation: TokenReservation, usage: CompletionUsage): Promise<number | null> {
  const db = database();
  const { keys, amount } = reservation;
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
    return total.results[0]?.request_count ?? null;
  } catch {
    // Never refund when accounting failed: later requests still see the reserve.
    return null;
  }
}
