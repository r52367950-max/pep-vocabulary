"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { AssistantTask } from "@/lib/assistant/prompt";
import type { LearnerProfile } from "@/lib/assistant/profile";
import { AssistantError, profileSnapshot, readCached, runAssistant, usageStore, type AssistantResult } from "@/lib/ai-client";
import { buildLearnerProfile } from "@/lib/learner-profile";
import { headwordLookup } from "@/lib/mistakes";
import { listWritings } from "@/lib/storage";

/** Writing summary for the profile: count, average score and the most frequent issue types. */
async function writingSummary(): Promise<LearnerProfile["writing"]> {
  try {
    const records = await listWritings();
    const reviews = records.flatMap((record) => record.versions.flatMap((version) => (version.review ? [version.review.result] : [])));
    if (!records.length) return null;
    const scores = reviews.map((review) => Number(review.estimatedScore)).filter(Number.isFinite);
    const types = new Map<string, number>();
    for (const review of reviews) for (const issue of (review.issues as { type?: string }[] | undefined) || []) if (issue.type) types.set(issue.type, (types.get(issue.type) || 0) + 1);
    return {
      count: records.length,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      commonIssues: [...types].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([type]) => type),
    };
  } catch {
    return null;
  }
}

/** Returns a function that yields the learner profile, rebuilt only when it meaningfully changes. */
export function useLearnerProfile(data: Vocabulary) {
  const lookup = useMemo(() => headwordLookup(data.index), [data.index]);
  const latest = useRef({ data, lookup });
  useEffect(() => { latest.current = { data, lookup }; });
  return useCallback(async () => {
    const writing = await writingSummary();
    const { data: current, lookup: words } = latest.current;
    return profileSnapshot(current.history.active.length, `w${writing?.count || 0}`, () =>
      buildLearnerProfile({ reviews: current.history.active, cards: current.cards, lookup: words, writing }));
  }, []);
}

export type AssistantState<T> =
  | { status: "idle" }
  | { status: "loading"; startedAt: number }
  | { status: "done"; value: AssistantResult<T> }
  | { status: "error"; message: string; code: string };

/**
 * One assistant task in a component. `peek` shows a cached answer without a request; `run`
 * requests (or reuses the cache); leaving the component cancels a pending request.
 */
export function useAssistant<T = Record<string, unknown>>(task: AssistantTask, data: Vocabulary) {
  const profile = useLearnerProfile(data);
  const [state, setState] = useState<AssistantState<T>>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const run = useCallback(async (input: Record<string, unknown>, options: { refresh?: boolean; personal?: boolean } = {}) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ status: "loading", startedAt: Date.now() });
    try {
      const value = await runAssistant<T>(task, input, {
        refresh: options.refresh, signal: current.signal,
        profile: options.personal === false ? null : await profile(),
      });
      if (!current.signal.aborted) setState({ status: "done", value });
      return value;
    } catch (error) {
      if (current.signal.aborted) return null;
      setState({ status: "error", message: error instanceof Error ? error.message : "AI 暂时不可用。", code: error instanceof AssistantError ? error.code : "error" });
      return null;
    }
  }, [task, profile]);
  const peek = useCallback(async (input: Record<string, unknown>) => {
    const cached = await readCached<T>(task, input);
    if (cached) setState({ status: "done", value: cached });
    else setState({ status: "idle" });
    return cached;
  }, [task]);
  const cancel = useCallback(() => { controller.current?.abort(); setState({ status: "idle" }); }, []);
  return { state, run, peek, cancel };
}

export const useAssistantUsage = () => useSyncExternalStore(usageStore.subscribe, usageStore.get, () => null);

/** Seconds since a request started, for the waiting line. */
export function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}
