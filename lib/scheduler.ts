import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
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
  rating,
  retention,
  skill,
  questionType,
  correct,
  responseMs,
  hints,
  errorType,
  now = new Date(),
}: {
  stored: StoredCard | null;
  rating: 1 | 2 | 3 | 4;
  retention: number;
  skill: SkillName;
  questionType: string;
  correct: boolean;
  responseMs: number;
  hints: number;
  errorType: string | null;
  now?: Date;
}) {
  const before = stored ? structuredClone(stored) : null;
  const current = stored || newStoredCard(createLocalId(), now);
  const scheduler = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true }));
  const result = scheduler.next(hydrateCard(current.fsrs), now, rating as Rating);
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
    before,
    after,
    schedulerLog: { ...result.log, due: result.log.due.toISOString(), review: result.log.review.toISOString() },
  };
  return { after, event };
}

export function workloadEstimate(minutesAtNinety: number, retention: number) {
  const multiplier = Math.pow((1 - 0.9) / Math.max(0.015, 1 - retention), 0.48);
  return Math.max(8, Math.round(minutesAtNinety * multiplier));
}

export function isDue(card: StoredCard, now = new Date()) {
  return new Date(card.due).getTime() <= now.getTime() && card.status !== "paused";
}
