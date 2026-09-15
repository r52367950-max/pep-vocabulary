import type { ReviewEvent } from "./storage";
import type { StudyMode } from "./study";
import { activeReviews } from "./progress";

export const SESSION_KEY = "vocab-session-v2";
const MAX_INITIAL_WORDS = 200;
const MAX_SESSION_STEPS = MAX_INITIAL_WORDS * 2;
export type SessionResult = {
  wordId: string;
  correct: boolean;
  answer: string;
  expected: string;
  retry: boolean;
};
export type StudySessionState = {
  id: string;
  mode: StudyMode;
  title: string;
  queue: string[];
  position: number;
  startedAt: number;
  revision?: number;
  finishedAt?: number;
  results: SessionResult[];
  retries: Record<string, number>;
};

// Each checkpoint has a stable event id. A committed event can repair a stale
// sessionStorage checkpoint after refresh without scheduling the word twice.
export function sessionEventId(session: StudySessionState) {
  return `${session.id}:${session.position}:${session.revision ?? 0}`;
}
export function advanceSession(
  session: StudySessionState,
  event: ReviewEvent,
): StudySessionState {
  const timestamp = Date.parse(event.timestampUtc);
  if (
    session.position >= session.queue.length ||
    session.queue[session.position] !== event.cardId ||
    event.eventType === "undo" ||
    !Number.isFinite(timestamp) ||
    timestamp < session.startedAt ||
    typeof event.correct !== "boolean" ||
    !Number.isFinite(event.hints) ||
    event.hints < 0
  ) {
    throw new Error("复习事件与当前学习位置不一致。");
  }
  const queue = [...session.queue];
  const retries = { ...session.retries };
  const retry = Object.hasOwn(retries, event.cardId);
  if ((!event.correct || event.hints > 0 || event.rating === 1) && !retry) {
    if (queue.length >= MAX_SESSION_STEPS)
      throw new Error("本轮学习已达到题量上限。");
    queue.splice(Math.min(session.position + 4, queue.length), 0, event.cardId);
    retries[event.cardId] = 1;
  }
  const position = session.position + 1;
  return {
    ...session,
    queue,
    retries,
    position,
    results: [
      ...session.results,
      {
        wordId: event.cardId,
        correct: event.correct,
        answer: event.answerGiven || "",
        expected: event.expectedAnswer || "",
        retry,
      },
    ],
    ...(position >= queue.length ? { finishedAt: timestamp } : {}),
  };
}

function validCheckpoint(
  value: StudySessionState,
  validIds: ReadonlySet<string>,
  now: number,
) {
  const modes = ["daily", "review", "mistakes", "dictation", "context", "new"];
  if (
    !value ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) ||
    !modes.includes(value.mode) ||
    typeof value.title !== "string" ||
    value.title.length > 100 ||
    !Array.isArray(value.queue) ||
    !value.queue.length ||
    value.queue.length > MAX_SESSION_STEPS ||
    value.queue.some((id) => typeof id !== "string" || !validIds.has(id)) ||
    !Number.isInteger(value.position) ||
    value.position < 0 ||
    value.position > value.queue.length ||
    !Number.isFinite(value.startedAt) ||
    value.startedAt > now ||
    now - value.startedAt > 86400_000 ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) || value.revision < 0)) ||
    (value.finishedAt !== undefined &&
      (!Number.isFinite(value.finishedAt) ||
        value.finishedAt < value.startedAt ||
        value.finishedAt > now ||
        value.position !== value.queue.length)) ||
    !Array.isArray(value.results) ||
    value.results.length !== value.position ||
    !value.retries ||
    typeof value.retries !== "object" ||
    Array.isArray(value.retries) ||
    Object.entries(value.retries).some(
      ([id, count]) => !validIds.has(id) || count !== 1,
    )
  )
    return false;
  const occurrences = new Map<string, number>();
  for (const id of value.queue)
    occurrences.set(id, (occurrences.get(id) || 0) + 1);
  // There is one original occurrence and, at most, one deliberately inserted retry.
  if (
    occurrences.size > MAX_INITIAL_WORDS ||
    [...occurrences].some(
      ([id, count]) => count !== (Object.hasOwn(value.retries, id) ? 2 : 1),
    )
  )
    return false;
  const answered = new Set<string>();
  for (let index = 0; index < value.results.length; index++) {
    const row = value.results[index];
    if (
      !row ||
      row.wordId !== value.queue[index] ||
      typeof row.correct !== "boolean" ||
      typeof row.answer !== "string" ||
      typeof row.expected !== "string" ||
      row.retry !== answered.has(row.wordId) ||
      (!row.correct && !Object.hasOwn(value.retries, row.wordId))
    )
      return false;
    answered.add(row.wordId);
  }
  return Object.keys(value.retries).every(
    (id) => answered.has(id) && occurrences.get(id) === 2,
  );
}

export function restoreSession(
  raw: string | null,
  validIds: ReadonlySet<string>,
  events: readonly ReviewEvent[],
  now = Date.now(),
): StudySessionState | null {
  if (!raw || raw.length > 150_000 || !Number.isFinite(now)) return null;
  try {
    const saved = JSON.parse(raw) as StudySessionState;
    if (!validCheckpoint(saved, validIds, now)) return null;
    const eventPosition = (id: string | undefined) => {
      if (!id?.startsWith(`${saved.id}:`)) return null;
      const suffix = id.slice(saved.id.length + 1);
      const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(suffix);
      if (!match) return null;
      const position = Number(match[1]),
        revision = Number(match[2]);
      return Number.isSafeInteger(position) &&
        position < MAX_SESSION_STEPS &&
        Number.isSafeInteger(revision)
        ? { position, revision }
        : null;
    };
    const byPosition = new Map<
      number,
      { event: ReviewEvent; revision: number }
    >();
    let revision = saved.revision || 0;
    for (const event of activeReviews(events)) {
      const coordinates = eventPosition(event.eventId);
      if (!coordinates) continue;
      revision = Math.max(revision, coordinates.revision);
      const previous = byPosition.get(coordinates.position);
      if (!previous || previous.revision < coordinates.revision)
        byPosition.set(coordinates.position, {
          event,
          revision: coordinates.revision,
        });
    }
    const undonePositions = new Set<number>();
    for (const event of events) {
      if (event.eventType !== "undo") continue;
      const coordinates = eventPosition(event.targetEventId);
      if (coordinates) {
        // The undo itself can commit before the checkpoint's revision is saved.
        // Move past its old id even when restoring that stale checkpoint.
        revision = Math.max(revision, coordinates.revision + 1);
        undonePositions.add(coordinates.position);
      }
    }
    if (!Number.isSafeInteger(revision)) return null;
    // Retries are inserted only after their first occurrence, so de-duplication
    // recovers the original order. Replay persisted reviews as the source of truth;
    // this repairs both an interrupted submit and an interrupted undo.
    let value: StudySessionState = {
      ...saved,
      queue: [...new Set(saved.queue)],
      position: 0,
      results: [],
      retries: {},
      revision,
    };
    delete value.finishedAt;
    while (value.position < value.queue.length) {
      const committed = byPosition.get(value.position)?.event;
      if (!committed) break;
      if (
        committed.cardId !== value.queue[value.position] ||
        Date.parse(committed.timestampUtc) > now
      )
        return null;
      value = advanceSession(value, committed);
    }
    // A checkpoint may be one step ahead after undo; other unexplained gaps mean
    // its history is missing or belongs to replaced data, so do not replay work.
    if (
      value.position < saved.position &&
      !(
        value.position === saved.position - 1 &&
        undonePositions.has(value.position)
      )
    )
      return null;
    return value.position < value.queue.length ? value : null;
  } catch {
    return null;
  }
}
