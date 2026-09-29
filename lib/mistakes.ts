import type { LexiconIndexEntry } from "./lexicon";
import { normalizeAnswer } from "./questions";
import type { ReviewEvent } from "./storage";

/**
 * Finer mistake kinds, derived from what was actually typed or chosen. Stored events keep their
 * original coarse `errorType`; this is recomputed on read, so no record changes.
 */
export type MistakeKind = "near-miss" | "confusion" | "spelling" | "recall" | "listening";

export const MISTAKE_LABELS: Record<MistakeKind, { title: string; detail: string }> = {
  "near-miss": { title: "拼写差一点", detail: "只错了一两个字母" },
  confusion: { title: "和别的词混了", detail: "写成或选成了另一个词" },
  spelling: { title: "拼写错误", detail: "拼写和答案相差较多" },
  recall: { title: "想不起来", detail: "看到词想不起意思，或留空" },
  listening: { title: "没听出来", detail: "听音题答错" },
};

export type HeadwordLookup = ReadonlyMap<string, string>;

/** Normalized headword → entry ID, for recognising answers that are other real words. */
export function headwordLookup(index: readonly LexiconIndexEntry[]): HeadwordLookup {
  const map = new Map<string, string>();
  for (const entry of index) {
    const key = normalizeAnswer(entry.headword);
    if (key && !map.has(key)) map.set(key, entry.id);
  }
  return map;
}

/** Levenshtein distance with an early exit once it exceeds `limit`. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

export function classifyMistake(event: ReviewEvent, lookup: HeadwordLookup): { kind: MistakeKind; confusedWith?: string } | null {
  if (event.correct || event.eventType === "undo") return null;
  const given = normalizeAnswer(event.answerGiven || "");
  const expected = normalizeAnswer(event.expectedAnswer || "");
  const other = given ? lookup.get(given) : undefined;
  if (other && other !== event.cardId) return { kind: "confusion", confusedWith: other };
  if (event.errorType === "listening" && event.questionType !== "dictation") return { kind: "listening" };
  if (!given || event.questionType === "meaning-recall") return { kind: event.errorType === "listening" ? "listening" : "recall" };
  if (expected && /[a-z]/.test(expected)) {
    const tolerance = expected.length <= 4 ? 1 : 2;
    return { kind: editDistance(given, expected, tolerance) <= tolerance ? "near-miss" : "spelling" };
  }
  return { kind: event.errorType === "listening" ? "listening" : "recall" };
}

export type MistakeSummary = {
  counts: Record<MistakeKind, number>;
  /** Card IDs per kind, most recent first, without duplicates. */
  words: Record<MistakeKind, string[]>;
  confusions: { cardId: string; withId: string; count: number; lastAt: string }[];
  recent: { event: ReviewEvent; kind: MistakeKind; confusedWith?: string }[];
};

/** Summarises active (not undone) reviews, oldest first, optionally since a UTC timestamp. */
export function summarizeMistakes(reviews: readonly ReviewEvent[], lookup: HeadwordLookup, since?: number): MistakeSummary {
  const kinds: MistakeKind[] = ["near-miss", "confusion", "spelling", "recall", "listening"];
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<MistakeKind, number>;
  const words = Object.fromEntries(kinds.map((kind) => [kind, [] as string[]])) as Record<MistakeKind, string[]>;
  const pairs = new Map<string, MistakeSummary["confusions"][number]>();
  const recent: MistakeSummary["recent"] = [];
  for (let i = reviews.length - 1; i >= 0; i--) {
    const event = reviews[i];
    if (since !== undefined && Date.parse(event.timestampUtc) < since) break;
    const mistake = classifyMistake(event, lookup);
    if (!mistake) continue;
    counts[mistake.kind]++;
    if (!words[mistake.kind].includes(event.cardId)) words[mistake.kind].push(event.cardId);
    if (recent.length < 40) recent.push({ event, ...mistake });
    if (mistake.confusedWith) {
      const key = [event.cardId, mistake.confusedWith].sort().join("|");
      const pair = pairs.get(key);
      if (pair) pair.count++;
      else pairs.set(key, { cardId: event.cardId, withId: mistake.confusedWith, count: 1, lastAt: event.timestampUtc });
    }
  }
  return { counts, words, confusions: [...pairs.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)), recent };
}
