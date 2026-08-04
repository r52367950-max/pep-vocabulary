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

function schedulerFor(retention: number, fuzz = true) {
  return fsrs(generatorParameters({ request_retention: retention, enable_fuzz: fuzz, enable_short_term: true }));
}

export function formatInterval(from: Date, to: Date) {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return "现在";
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.round(ms / 86400000);
  if (days < 60) return `+${days} 天`;
  const months = Math.round(days / 30);
  if (months < 18) return `+${months} 个月`;
  return `+${(days / 365).toFixed(1)} 年`;
}

/** 四档评分各自的下一次间隔；键帽上直接写出，用户不必猜。 */
export function previewIntervals(stored: StoredCard | null | undefined, retention: number, now = new Date()) {
  const card = hydrateCard((stored || newStoredCard("preview", now)).fsrs);
  const log = schedulerFor(retention, false).repeat(card, now);
  return {
    1: formatInterval(now, log[Rating.Again].card.due),
    2: formatInterval(now, log[Rating.Hard].card.due),
    3: formatInterval(now, log[Rating.Good].card.due),
    4: formatInterval(now, log[Rating.Easy].card.due),
  } as Record<1 | 2 | 3 | 4, string>;
}

/** 当前可提取性；没有复习记录时为 0，不编造。 */
export function retrievabilityOf(stored: StoredCard | null | undefined, now = new Date()) {
  if (!stored || !stored.lastReviewed) return 0;
  const value = schedulerFor(0.9, false).get_retrievability(hydrateCard(stored.fsrs), now, false);
  return typeof value === "number" ? value : 0;
}

/** 词库「下次」列：未学显示破折号，不假装有排程。 */
export function dueLabel(stored: StoredCard | null | undefined, now = new Date()) {
  if (!stored || !stored.lastReviewed) return "—";
  const days = Math.round((new Date(stored.due).getTime() - now.getTime()) / 86400000);
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天";
  return `+${days} 天`;
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
  const scheduler = schedulerFor(retention);
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
