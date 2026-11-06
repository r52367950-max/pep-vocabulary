import { validateBackup, type AppSettings, type BackupPayload, type ReviewEvent, type StoredCard, type WritingRecord } from "./backup";
import { scheduleReview } from "./scheduler";
import { stableJson } from "./stable-json";

/**
 * Combines this device's learning records with the account's cloud snapshot.
 *
 * Answers are append-only events with unique IDs, so both sides keep every
 * answer. The cloud snapshot is the server-confirmed history: when a word was
 * reviewed on both sides since they last agreed, this device's answers for that
 * word are rescheduled on top of the cloud state. Each rescheduled answer keeps
 * its event ID and recorded answer (time, question, response, rating, hints);
 * only its scheduling consequences change. The result passes the same backup
 * validation as a restore before anything is written.
 */

export class SyncMergeError extends Error {}

export type MergeSummary = {
  /** Answers present only on this device and now part of the merged history. */
  localAnswers: number;
  /** Answers present only in the cloud snapshot. */
  cloudAnswers: number;
  /** Words reviewed on both sides whose local answers were rescheduled. */
  rescheduledWords: number;
  /** Local undo records that targeted a synced answer the cloud kept building on. */
  droppedUndos: number;
};

// An answer's evidence. Scheduling fields (before/after, intervals, memory,
// scheduler log) may differ when the cloud already holds a rescheduled copy.
const evidenceKeys = ["eventType", "cardId", "timestampUtc", "localDate", "timezone", "questionType", "skill", "rating", "correct",
  "responseMs", "hints", "errorType", "prompt", "answerGiven", "expectedAnswer", "sourceLine", "targetEventId"] as const;
const evidence = (event: ReviewEvent) => stableJson(Object.fromEntries(evidenceKeys.map((key) => [key, event[key] ?? null])));

const time = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY);
const later = <T extends { updatedAt: string }>(local: T | undefined, remote: T | undefined) =>
  !local ? remote : !remote ? local : time(local.updatedAt) > time(remote.updatedAt) ? local : remote;

function undoneTargets(events: Iterable<ReviewEvent>) {
  const targets = new Set<string>();
  for (const event of events) if (event.eventType === "undo" && event.targetEventId) targets.add(event.targetEventId);
  return targets;
}

/** Reviews in the order they were answered on one device, each undo right after its target. */
function answerOrder(events: ReviewEvent[]) {
  const undone = undoneTargets(events);
  const undoFor = new Map(events.filter((event) => event.eventType === "undo").map((event) => [event.targetEventId!, event]));
  // An undo always follows the latest answer, and the next answer starts from
  // the same state, so an undone answer precedes the kept answer of its level.
  const reviews = events.filter((event) => event.eventType !== "undo").sort((a, b) =>
    (a.after.fsrs.reps as number) - (b.after.fsrs.reps as number) ||
    Number(!undone.has(a.eventId)) - Number(!undone.has(b.eventId)) ||
    time(a.timestampUtc) - time(b.timestampUtc));
  const ordered = reviews.flatMap((review) => (undoFor.has(review.eventId) ? [review, undoFor.get(review.eventId)!] : [review]));
  // Undo records whose answer was synced earlier come last; they cannot be replayed.
  const reviewIds = new Set(reviews.map((review) => review.eventId));
  return [...ordered, ...events.filter((event) => event.eventType === "undo" && !reviewIds.has(event.targetEventId!))];
}

function withMetadata(card: StoredCard, metadata: StoredCard | undefined, status: StoredCard["status"]): StoredCard {
  const merged: StoredCard = { ...card, status };
  delete merged.note; delete merged.tags; delete merged.favorite;
  const source = metadata ?? card;
  if (source.note !== undefined) merged.note = source.note;
  if (source.tags !== undefined) merged.tags = source.tags;
  if (source.favorite !== undefined) merged.favorite = source.favorite;
  if (metadata && time(metadata.updatedAt) > time(card.updatedAt)) merged.updatedAt = metadata.updatedAt;
  return merged;
}

function mergeWriting(local: WritingRecord, remote: WritingRecord): WritingRecord {
  const newer = time(local.updatedAt) > time(remote.updatedAt) ? local : remote;
  const versions = new Map<string, WritingRecord["versions"][number]>();
  for (const version of [...remote.versions, ...local.versions]) if (!versions.has(version.id)) versions.set(version.id, version);
  if (versions.size > 30) return newer;
  return { ...newer, versions: [...versions.values()].sort((a, b) => time(a.savedAt) - time(b.savedAt)) };
}

function mergeById<T extends Record<string, unknown>>(local: T[], remote: T[], key: string, choose: (local: T, remote: T) => T) {
  const merged = new Map<unknown, T>(remote.map((row) => [row[key], row]));
  for (const row of local) merged.set(row[key], merged.has(row[key]) ? choose(row, merged.get(row[key])!) : row);
  return [...merged.values()];
}

/**
 * `local` is this device's own export; the cloud snapshot is validated and
 * migrated like a restore. The merged result is validated as a whole.
 */
export function mergeBackups(local: BackupPayload, remoteInput: unknown): { payload: BackupPayload; summary: MergeSummary } {
  const remote = validateBackup(remoteInput);
  const summary: MergeSummary = { localAnswers: 0, cloudAnswers: 0, rescheduledWords: 0, droppedUndos: 0 };
  const settings = later(local.settings[0], remote.settings[0]);
  const retention = (settings as AppSettings | undefined)?.desiredRetention ?? 0.9;

  const localEvents = new Map(local.events.map((event) => [event.eventId, event]));
  const remoteEvents = new Map(remote.events.map((event) => [event.eventId, event]));
  const cardIds = new Set([...local.cards, ...remote.cards].map((card) => card.id));
  type CardHistory = { localOnly: ReviewEvent[]; remoteOnly: number; rebased: boolean };
  const histories = new Map<string, CardHistory>();
  const history = (cardId: string) => {
    cardIds.add(cardId);
    let entry = histories.get(cardId);
    if (!entry) histories.set(cardId, entry = { localOnly: [], remoteOnly: 0, rebased: false });
    return entry;
  };
  for (const [id, event] of localEvents) {
    const twin = remoteEvents.get(id);
    if (!twin) { history(event.cardId).localOnly.push(event); continue; }
    if (evidence(twin) !== evidence(event)) throw new SyncMergeError("本机与云端有编号相同但作答内容不同的记录，无法自动合并。请导出本机备份后再处理。");
    if (stableJson(twin) !== stableJson(event)) history(event.cardId).rebased = true;
  }
  for (const [id, event] of remoteEvents) if (!localEvents.has(id)) history(event.cardId).remoteOnly++;

  const byCard = (rows: ReviewEvent[]) => {
    const grouped = new Map<string, ReviewEvent[]>();
    for (const event of rows) {
      const list = grouped.get(event.cardId);
      if (list) list.push(event); else grouped.set(event.cardId, [event]);
    }
    return grouped;
  };
  const localByCard = byCard(local.events), remoteByCard = byCard(remote.events);
  const localCards = new Map(local.cards.map((card) => [card.id, card]));
  const remoteCards = new Map(remote.cards.map((card) => [card.id, card]));
  const events: ReviewEvent[] = [...remote.events];
  const cards: StoredCard[] = [];

  for (const cardId of cardIds) {
    const entry = histories.get(cardId) ?? { localOnly: [], remoteOnly: 0, rebased: false };
    const localCard = localCards.get(cardId), remoteCard = remoteCards.get(cardId);
    const metadata = later(localCard, remoteCard);
    const answered = (side: ReviewEvent[]) => side.filter((event) => event.eventType !== "undo").length;
    const remoteHistory = remoteByCard.get(cardId) ?? [];
    summary.cloudAnswers += entry.remoteOnly ? answered(remoteHistory.filter((event) => !localEvents.has(event.eventId))) : 0;
    summary.localAnswers += answered(entry.localOnly);

    let scheduled: StoredCard | null;
    let history: ReviewEvent[];
    if (!entry.localOnly.length) {
      scheduled = remoteCard ?? null;
      history = remoteHistory;
    } else if (!entry.remoteOnly && !entry.rebased) {
      // Only this device moved on: its history extends the cloud's.
      scheduled = localCard ?? null;
      history = localByCard.get(cardId) ?? [];
      events.push(...entry.localOnly);
    } else {
      // Both sides answered: reschedule this device's answers after the cloud history.
      summary.rescheduledWords++;
      let current = remoteCard ?? null;
      const replayed = new Map<string, ReviewEvent>();
      history = [...remoteHistory];
      for (const original of answerOrder(entry.localOnly)) {
        if (original.eventType === "undo") {
          const target = replayed.get(original.targetEventId!);
          if (!target) { summary.droppedUndos++; continue; }
          const undo: ReviewEvent = { ...target, eventId: original.eventId, eventType: "undo", targetEventId: target.eventId,
            timestampUtc: original.timestampUtc, localDate: original.localDate, timezone: original.timezone };
          events.push(undo); history.push(undo);
          current = target.before;
          continue;
        }
        const { event } = scheduleReview({
          stored: current, cardId, rating: original.rating, retention, skill: original.skill, questionType: original.questionType,
          correct: original.correct, responseMs: original.responseMs, hints: original.hints, errorType: original.errorType,
          prompt: original.prompt, answerGiven: original.answerGiven, expectedAnswer: original.expectedAnswer,
          sourceLine: original.sourceLine, now: new Date(original.timestampUtc),
        });
        const rescheduled: ReviewEvent = { ...event, eventId: original.eventId, localDate: original.localDate, timezone: original.timezone,
          ...(original.eventType === "review" ? { eventType: "review" as const } : {}) };
        replayed.set(original.eventId, rescheduled);
        events.push(rescheduled); history.push(rescheduled);
        current = rescheduled.after;
      }
      scheduled = current;
    }

    if (!scheduled) {
      // A word whose only answers were undone has no card; keep a note or favourite saved on the other side.
      const kept = metadata && metadata.lastReviewed === null && metadata.fsrs.reps === 0 ? metadata : null;
      if (kept) cards.push(kept);
      continue;
    }
    const undone = undoneTargets(history);
    const lastActive = history.filter((event) => event.eventType !== "undo" && !undone.has(event.eventId))
      .sort((a, b) => (a.after.fsrs.reps as number) - (b.after.fsrs.reps as number)).at(-1);
    // Paused is an independent marker; otherwise the status is the one recorded with the latest kept answer.
    const learned = lastActive?.after.status ?? scheduled.status;
    const status = metadata?.status === "paused" ? "paused" : learned;
    cards.push(withMetadata(scheduled, metadata, status));
  }

  const payload: BackupPayload = {
    schemaVersion: remote.schemaVersion,
    exportedAt: new Date().toISOString(),
    cards,
    events,
    lists: mergeById(local.lists, remote.lists, "id", (_local, cloud) => cloud),
    settings: settings ? [settings] : [],
    writings: mergeById(local.writings as unknown as Record<string, unknown>[], remote.writings as unknown as Record<string, unknown>[], "id",
      (a, b) => mergeWriting(a as unknown as WritingRecord, b as unknown as WritingRecord) as unknown as Record<string, unknown>) as unknown as WritingRecord[],
  };
  try {
    return { payload: validateBackup(payload), summary };
  } catch {
    throw new SyncMergeError("合并结果没有通过备份校验，未做任何修改。请导出本机备份后再处理。");
  }
}
