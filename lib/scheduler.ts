import { createEmptyCard, fsrs, generatorParameters, type Card } from "ts-fsrs";
import { createLocalId, emptySkills, type ReviewEvent, type SkillName, type StoredCard } from "./storage";

function hydrateCard(value: Record<string, unknown>): Card {
  return {
    ...(value as unknown as Card),
    due: new Date(String(value.due)),
    last_review: value.last_review ? new Date(String(value.last_review)) : undefined,
  };
}

function serializeCard(card: Card) {
  return { ...card, due: card.due.toISOString(), last_review: card.last_review?.toISOString() || null };
}

export function newStoredCard(id: string, now = new Date()): StoredCard {
  const fsrsCard = createEmptyCard(now);
  return {
    id,
    fsrs: serializeCard(fsrsCard),
    skills: emptySkills(),
    status: "unseen",
    due: fsrsCard.due.toISOString(),
    lastReviewed: null,
    updatedAt: now.toISOString(),
  };
}

export function scheduleReview({
  stored,
  cardId,
  rating,
  retention,
  skill,
  questionType,
  correct,
  responseMs,
  hints,
  errorType,
  prompt,
  answerGiven,
  expectedAnswer,
  sourceLine,
  now = new Date(),
}: {
  stored: StoredCard | null;
  cardId?: string;
  rating: 1 | 2 | 3 | 4;
  retention: number;
  skill: SkillName;
  questionType: string;
  correct: boolean;
  responseMs: number;
  hints: number;
  errorType: string | null;
  prompt?: string;
  answerGiven?: string | null;
  expectedAnswer?: string | null;
  sourceLine?: string | null;
  now?: Date;
}) {
  const before = stored ? structuredClone(stored) : null;
  const current = stored || newStoredCard(cardId || createLocalId(), now);
  const scheduler = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true }));
  const result = scheduler.next(hydrateCard(current.fsrs), now, rating);
  const nextSkill = Math.max(0, Math.min(1, current.skills[skill] * 0.78 + (correct ? 0.28 : -0.08)));
  const nextSkills = { ...current.skills, [skill]: Number(nextSkill.toFixed(3)) };
  const average = Object.values(nextSkills).reduce((sum, value) => sum + value, 0) / 6;
  const after: StoredCard = {
    ...current,
    fsrs: serializeCard(result.card),
    skills: nextSkills,
    status: rating === 1 ? "weak" : average > 0.78 && result.card.stability > 20 ? "mastered" : "learning",
    due: result.card.due.toISOString(),
    lastReviewed: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const event: ReviewEvent = {
    eventId: createLocalId(),
    cardId: after.id,
    timestampUtc: now.toISOString(),
    localDate: now.toLocaleDateString("sv-SE"),
    timezone,
    questionType,
    skill,
    rating,
    correct,
    responseMs,
    hints,
    errorType,
    prompt,
    answerGiven,
    expectedAnswer,
    sourceLine,
    intervalBeforeDays: current.lastReviewed ? Math.max(0, (new Date(current.due).getTime() - new Date(current.lastReviewed).getTime()) / 86400000) : null,
    intervalAfterDays: Math.max(0, (result.card.due.getTime() - now.getTime()) / 86400000),
    stabilityBefore: typeof current.fsrs.stability === "number" ? current.fsrs.stability : null,
    stabilityAfter: result.card.stability,
    difficultyBefore: typeof current.fsrs.difficulty === "number" ? current.fsrs.difficulty : null,
    difficultyAfter: result.card.difficulty,
    before,
    after,
    schedulerLog: { ...result.log, due: result.log.due.toISOString(), review: result.log.review.toISOString() },
  };
  return { after, event };
}

export type ReviewIntervalPreview = { rating: 1 | 2 | 3 | 4; due: string; days: number; label: string };

function intervalLabel(due: Date, now: Date) {
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60000));
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.max(1, Math.round(hours / 24));
  if (days < 30) return `+${days} 天`;
  return `+${Math.max(1, Math.round(days / 30))} 个月`;
}

export function previewReviewIntervals(stored: StoredCard | null | undefined, retention: number, now = new Date()): ReviewIntervalPreview[] {
  const current = stored || newStoredCard("preview", now);
  const scheduler = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: false, enable_short_term: true }));
  return ([1, 2, 3, 4] as const).map((rating) => {
    const due = scheduler.next(hydrateCard(current.fsrs), now, rating).card.due;
    return { rating, due: due.toISOString(), days: Math.max(0, (due.getTime() - now.getTime()) / 86400000), label: intervalLabel(due, now) };
  });
}

export type WorkloadDay = { date: string; count: number; minutes: number };
export function forecastDueLoad(cards: Iterable<StoredCard>, days = 14, now = new Date()): WorkloadDay[] {
  if (!Number.isInteger(days) || days <= 0) return [];
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const result = Array.from({ length: days }, (_, offset) => { const date = new Date(start); date.setDate(start.getDate() + offset); return { date: date.toLocaleDateString("sv-SE"), count: 0, minutes: 0 }; });
  const byDate = new Map(result.map((day) => [day.date, day]));
  for (const card of cards) {
    if (card.status === "paused" || card.status === "unseen") continue;
    const due = new Date(card.due);
    if (!Number.isFinite(due.getTime())) continue;
    const bucket = due < start ? result[0] : byDate.get(due.toLocaleDateString("sv-SE"));
    if (bucket) bucket.count += 1;
  }
  return result.map((day) => ({ ...day, minutes: Math.max(day.count ? 2 : 0, Math.round(day.count * .62)) }));
}

export function workloadEstimate(minutesAtNinety: number, retention: number) {
  const multiplier = Math.pow((1 - 0.9) / Math.max(0.015, 1 - retention), 0.48);
  return Math.max(8, Math.round(minutesAtNinety * multiplier));
}

export function isDue(card: StoredCard, now = new Date()) {
  return new Date(card.due).getTime() <= now.getTime() && card.status !== "paused" && card.status !== "unseen";
}
