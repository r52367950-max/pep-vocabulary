import type { MistakeKind } from "../mistakes";

/**
 * The learner profile sent with AI requests: bounded facts from the learner's own records
 * (mistakes, weak words, notes, confusions, writing). The client builds it (lib/learner-profile.ts);
 * the server re-validates every field and resolves word IDs to headwords itself.
 */
export type LearnerProfile = {
  date: string;
  totals: { reviews: number; words: number; accuracy7d: number | null; activeDays30: number };
  errorCounts: Record<MistakeKind, number>;
  weakWords: { id: string; errors: number; lapses: number; lastKind: MistakeKind | null }[];
  recentMistakes: { id: string; question: string; given: string | null; expected: string | null; kind: MistakeKind }[];
  notes: { id: string; text: string }[];
  confusions: { id: string; withId: string; count: number }[];
  writing: { count: number; averageScore: number | null; commonIssues: string[] } | null;
};

export const PROFILE_LIMITS = { weakWords: 24, recentMistakes: 16, notes: 12, noteLength: 400, answerLength: 120, confusions: 8, issues: 6 };
const KINDS: MistakeKind[] = ["near-miss", "confusion", "spelling", "recall", "listening"];
const WORD_ID = /^pep-[a-f0-9]{16}$/;
export const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export class ProfileInputError extends Error {}

type HeadwordSource = ReadonlyMap<string, { headword: string }>;
const count = (value: unknown, maximum = 1_000_000) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0);
function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return clean ? clip(clean, maximum) : null;
}
function list(value: unknown, maximum: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProfileInputError("profile list");
  return value.slice(0, maximum);
}
const kind = (value: unknown): MistakeKind | null => (KINDS.includes(value as MistakeKind) ? (value as MistakeKind) : null);

/**
 * Server-side validation. Unknown or non-release word IDs are dropped; every string is
 * length-bounded; headwords come from the release index, never from the client.
 */
export function parseLearnerProfile(value: unknown, words: HeadwordSource) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ProfileInputError("profile");
  const raw = value as Record<string, unknown>;
  const known = (id: unknown): id is string => typeof id === "string" && WORD_ID.test(id) && words.has(id);
  const headword = (id: string) => words.get(id)!.headword;
  const record = (item: unknown) => (item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {});
  const totals = record(raw.totals);
  const errors = record(raw.errorCounts);
  const writing = raw.writing && typeof raw.writing === "object" ? record(raw.writing) : null;
  const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  return {
    date,
    totals: {
      reviews: count(totals.reviews), words: count(totals.words),
      accuracy7d: totals.accuracy7d === null ? null : count(totals.accuracy7d, 100), activeDays30: count(totals.activeDays30, 31),
    },
    errorCounts: Object.fromEntries(KINDS.map((key) => [key, count(errors[key])])),
    weakWords: list(raw.weakWords, PROFILE_LIMITS.weakWords).map(record).filter((item) => known(item.id)).map((item) => ({
      id: item.id as string, word: headword(item.id as string), errors: count(item.errors, 100_000), lapses: count(item.lapses, 100_000), lastKind: kind(item.lastKind),
    })),
    recentMistakes: list(raw.recentMistakes, PROFILE_LIMITS.recentMistakes).map(record).filter((item) => known(item.id) && kind(item.kind)).map((item) => ({
      id: item.id as string, word: headword(item.id as string), kind: kind(item.kind)!,
      question: text(item.question, 40), given: text(item.given, PROFILE_LIMITS.answerLength), expected: text(item.expected, PROFILE_LIMITS.answerLength),
    })),
    notes: list(raw.notes, PROFILE_LIMITS.notes).map(record).filter((item) => known(item.id) && text(item.text, 1)).map((item) => ({
      id: item.id as string, word: headword(item.id as string), text: text(item.text, PROFILE_LIMITS.noteLength)!,
    })),
    confusions: list(raw.confusions, PROFILE_LIMITS.confusions).map(record).filter((item) => known(item.id) && known(item.withId) && item.id !== item.withId).map((item) => ({
      id: item.id as string, word: headword(item.id as string), withId: item.withId as string, withWord: headword(item.withId as string), count: count(item.count, 100_000),
    })),
    writing: writing ? {
      count: count(writing.count, 100_000),
      averageScore: writing.averageScore === null ? null : count(writing.averageScore, 25),
      commonIssues: list(writing.commonIssues, PROFILE_LIMITS.issues).map((item) => text(item, 60)).filter((item): item is string => Boolean(item)),
    } : null,
  };
}

export type ParsedLearnerProfile = NonNullable<ReturnType<typeof parseLearnerProfile>>;
