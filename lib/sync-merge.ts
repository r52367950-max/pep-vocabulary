import { validateBackup, type AppSettings, type BackupPayload, type ReviewEvent, type StoredCard, type WritingRecord, type WritingVersion } from "./backup";
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
 * only its scheduling consequences change.
 *
 * Notes, tags, favourites, pauses and writing versions are merged field by
 * field against the values both sides last agreed on (`SyncBase`, recorded on
 * every successful sync). A side that still holds the agreed value takes the
 * other side's change; when both changed a field differently, both contents
 * are kept. Without a recorded base every difference counts as a conflict.
 * The result passes the same backup validation as a restore before anything
 * is written.
 */

export class SyncMergeError extends Error {}

export type MergeSummary = {
  /** Answers present only on this device and now part of the merged history. */
  localAnswers: number;
  /** Answers present only in the cloud snapshot. */
  cloudAnswers: number;
  /** Words reviewed on both sides whose local answers were rescheduled. */
  rescheduledWords: number;
  /** Words whose local undo targeted a synced answer the cloud kept building on; those undos are not applied. */
  droppedUndos: string[];
  /** Words whose note was changed differently on both sides; both texts are kept in the note. */
  combinedNotes: string[];
  /** Writing versions edited differently on both sides; this device's text is kept as an extra version. */
  keptVersions: number;
};

/** Per-field digests of the snapshot this device and the cloud last agreed on. */
export type SyncBase = {
  /** Words with a note, tags, favourite or pause; a word without any is absent. */
  cards: Record<string, Partial<Record<CardField, string>>>;
  /** Content digest of every writing version, by writing ID and version ID. */
  writings: Record<string, Record<string, string>>;
};
type CardField = "note" | "tags" | "favorite" | "paused";

// An answer's evidence. Scheduling fields (before/after, intervals, memory,
// scheduler log) may differ when the cloud already holds a rescheduled copy.
const evidenceKeys = ["eventType", "cardId", "timestampUtc", "localDate", "timezone", "questionType", "skill", "rating", "correct",
  "responseMs", "hints", "errorType", "prompt", "answerGiven", "expectedAnswer", "sourceLine", "targetEventId"] as const;
const evidence = (event: ReviewEvent) => stableJson(Object.fromEntries(evidenceKeys.map((key) => [key, event[key] ?? null])));

const time = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY);

/** 53-bit string digest (cyrb53); the base keeps digests so it stays small. */
function digest(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const fieldKey: Record<CardField, (card: StoredCard | undefined) => string | undefined> = {
  note: (card) => (card?.note ? digest(card.note) : undefined),
  tags: (card) => (card?.tags?.length ? digest(stableJson(card.tags)) : undefined),
  favorite: (card) => (card?.favorite ? "1" : undefined),
  paused: (card) => (card?.status === "paused" ? "1" : undefined),
};
const cardFields = Object.keys(fieldKey) as CardField[];
const versionKey = (version: WritingVersion) => digest(stableJson({ ...version, id: undefined }));

export function syncBase(payload: BackupPayload): SyncBase {
  const base: SyncBase = { cards: {}, writings: {} };
  for (const card of payload.cards) {
    const entry: Partial<Record<CardField, string>> = {};
    for (const field of cardFields) {
      const key = fieldKey[field](card);
      if (key !== undefined) entry[field] = key;
    }
    if (Object.keys(entry).length) base.cards[card.id] = entry;
  }
  for (const writing of payload.writings) base.writings[writing.id] = Object.fromEntries(writing.versions.map((version) => [version.id, versionKey(version)]));
  return base;
}

/** "local" or "remote" when one side kept the agreed value (or both match), otherwise "conflict". */
function choose(ours: string | undefined, theirs: string | undefined, agreed: string | undefined, known: boolean) {
  if (ours === theirs || (known && ours === agreed)) return "remote";
  if (known && theirs === agreed) return "local";
  return "conflict";
}
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

type CardMetadata = { note?: string; tags?: string[]; favorite?: boolean; paused: boolean };

function mergeMetadata(local: StoredCard | undefined, remote: StoredCard | undefined, agreed: SyncBase["cards"][string] | undefined, known: boolean) {
  const side = (field: CardField) => choose(fieldKey[field](local), fieldKey[field](remote), agreed?.[field], known);
  const metadata: CardMetadata = { paused: false };
  let combined = false;
  const note = side("note");
  if (note !== "conflict") metadata.note = (note === "local" ? local : remote)?.note;
  else {
    const cloud = remote?.note ?? "", mine = local?.note ?? "";
    // Keep both texts; one already containing the other loses nothing.
    if (!cloud || mine.includes(cloud)) metadata.note = mine;
    else if (!mine || cloud.includes(mine)) metadata.note = cloud;
    else {
      metadata.note = `${cloud}\n\n——另一版本——\n${mine}`;
      combined = true;
      if (metadata.note.length > 50_000)
        throw new SyncMergeError("有一个词的笔记在两台设备上改成了不同内容，合在一起超过 50,000 字，无法同时保留。本机和云端都没有变化；请先在一台设备上缩短该笔记再同步。");
    }
  }
  const tags = side("tags");
  metadata.tags = tags === "conflict" ? [...new Set([...(remote?.tags ?? []), ...(local?.tags ?? [])])] : (tags === "local" ? local : remote)?.tags;
  // A marker set on either side without an agreed value stays set.
  const favorite = side("favorite");
  metadata.favorite = favorite === "conflict" ? true : (favorite === "local" ? local : remote)?.favorite;
  const paused = side("paused");
  metadata.paused = paused === "conflict" || (paused === "local" ? local : remote)?.status === "paused";
  return { metadata, combined };
}

function withMetadata(card: StoredCard, metadata: CardMetadata, status: StoredCard["status"], updatedAt: string): StoredCard {
  const merged: StoredCard = { ...card, status, updatedAt };
  delete merged.note; delete merged.tags; delete merged.favorite;
  if (metadata.note !== undefined) merged.note = metadata.note;
  if (metadata.tags !== undefined) merged.tags = metadata.tags;
  if (metadata.favorite !== undefined) merged.favorite = metadata.favorite;
  return merged;
}

function mergeWriting(local: WritingRecord, remote: WritingRecord, agreed: Record<string, string> | undefined, known: boolean, summary: MergeSummary): WritingRecord {
  const newer = time(local.updatedAt) > time(remote.updatedAt) ? local : remote;
  const versions = new Map(remote.versions.map((version) => [version.id, version]));
  const cloudContents = new Set(remote.versions.map(versionKey));
  for (const version of local.versions) {
    const twin = versions.get(version.id);
    if (!twin) { versions.set(version.id, version); continue; }
    const mine = versionKey(version), side = choose(mine, versionKey(twin), agreed?.[version.id], known);
    if (side === "local") versions.set(version.id, version);
    // Both edited the same version (a draft keeps its ID while being edited):
    // this device's text becomes an extra version unless the cloud already holds it.
    else if (side === "conflict" && !cloudContents.has(mine)) {
      const id = `${version.id.slice(0, 180)}-${mine}`;
      if (!versions.has(id)) { versions.set(id, { ...version, id }); summary.keptVersions++; }
    }
  }
  if (versions.size > 30)
    throw new SyncMergeError(`作文“${newer.title || "未命名"}”合并后会有 ${versions.size} 个版本，超过 30 个的上限，无法保留两边全部内容。本机和云端都没有变化；请先导出本机备份，再在一台设备上移除这篇作文后同步。`);
  return { ...newer, updatedAt: time(local.updatedAt) > time(remote.updatedAt) ? local.updatedAt : remote.updatedAt,
    versions: [...versions.values()].sort((a, b) => time(a.savedAt) - time(b.savedAt)) };
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
export function mergeBackups(local: BackupPayload, remoteInput: unknown, base: SyncBase | null = null): { payload: BackupPayload; summary: MergeSummary } {
  const remote = validateBackup(remoteInput);
  const summary: MergeSummary = { localAnswers: 0, cloudAnswers: 0, rescheduledWords: 0, droppedUndos: [], combinedNotes: [], keptVersions: 0 };
  const known = base !== null;
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
    const { metadata, combined } = mergeMetadata(localCard, remoteCard, base?.cards[cardId], known);
    if (combined) summary.combinedNotes.push(cardId);
    const updatedAt = [localCard?.updatedAt, remoteCard?.updatedAt].reduce<string>((a, b) => (b && time(b) > time(a) ? b : a), "");
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
          if (!target) { if (!summary.droppedUndos.includes(cardId)) summary.droppedUndos.push(cardId); continue; }
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
      // A word whose only answers were undone has no card; keep a note or favourite saved on either side.
      const fresh = [later(localCard, remoteCard), localCard, remoteCard].find((card) => card && card.lastReviewed === null && card.fsrs.reps === 0);
      if (fresh) cards.push(withMetadata(fresh, metadata, metadata.paused ? "paused" : "unseen", updatedAt));
      continue;
    }
    const undone = undoneTargets(history);
    const lastActive = history.filter((event) => event.eventType !== "undo" && !undone.has(event.eventId))
      .sort((a, b) => (a.after.fsrs.reps as number) - (b.after.fsrs.reps as number)).at(-1);
    // Paused is an independent marker; otherwise the status is the one recorded with the latest kept answer.
    const learned = lastActive?.after.status ?? scheduled.status;
    const status = metadata.paused ? "paused" : learned;
    cards.push(withMetadata(scheduled, metadata, status, time(scheduled.updatedAt) > time(updatedAt) ? scheduled.updatedAt : updatedAt));
  }

  const payload: BackupPayload = {
    schemaVersion: remote.schemaVersion,
    exportedAt: new Date().toISOString(),
    cards,
    events,
    lists: mergeById(local.lists, remote.lists, "id", (_local, cloud) => cloud),
    settings: settings ? [settings] : [],
    writings: mergeById(local.writings as unknown as Record<string, unknown>[], remote.writings as unknown as Record<string, unknown>[], "id", (a, b) => {
      const mine = a as unknown as WritingRecord;
      return mergeWriting(mine, b as unknown as WritingRecord, base?.writings[mine.id], known, summary) as unknown as Record<string, unknown>;
    }) as unknown as WritingRecord[],
  };
  try {
    return { payload: validateBackup(payload), summary };
  } catch {
    throw new SyncMergeError("合并结果没有通过备份校验，未做任何修改。请导出本机备份后再处理。");
  }
}
