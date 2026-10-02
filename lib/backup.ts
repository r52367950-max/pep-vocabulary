import { validWritingReview } from "./writing-review";
import { MAX_REVIEW_TIME_MS } from "./scheduler-limits";
import { stableJson } from "./stable-json";

export const USER_DATA_SCHEMA_VERSION = "1.2.0";
export type SkillName = "meaning" | "listening" | "spelling" | "context" | "collocation" | "output";
export type SkillVector = Record<SkillName, number>;

export type StoredCard = {
  id: string;
  fsrs: Record<string, unknown>;
  skills: SkillVector;
  status: "unseen" | "learning" | "weak" | "mastered" | "paused";
  due: string;
  lastReviewed: string | null;
  updatedAt: string;
  note?: string;
  tags?: string[];
  favorite?: boolean;
};

export type ReviewEvent = {
  eventType?: "review" | "undo";
  eventId: string;
  cardId: string;
  timestampUtc: string;
  localDate: string;
  timezone: string;
  questionType: string;
  skill: SkillName;
  rating: 1 | 2 | 3 | 4;
  correct: boolean;
  responseMs: number;
  hints: number;
  errorType: string | null;
  prompt?: string;
  answerGiven?: string | null;
  expectedAnswer?: string | null;
  sourceLine?: string | null;
  intervalBeforeDays?: number | null;
  intervalAfterDays?: number;
  stabilityBefore?: number | null;
  stabilityAfter?: number;
  difficultyBefore?: number | null;
  difficultyAfter?: number;
  before: StoredCard | null;
  after: StoredCard;
  schedulerLog: Record<string, unknown>;
  undoneBy?: string;
  targetEventId?: string;
};

export type AppSettings = {
  key: "app";
  dailyMinutes: number;
  desiredRetention: number;
  selectedBooks: string[];
  mode: "normal" | "unit" | "review-only" | "exam" | "browse";
  theme: "light" | "dark" | "system";
  aiEnabled: boolean;
  diagnosisComplete: boolean;
  examDate: string | null;
  updatedAt: string;
};

export type WritingGenre = "practical" | "continuation" | "free";
export type WritingVersion = {
  id: string;
  text: string;
  savedAt: string;
  /** The validated AI review of this version, when one was requested. */
  review?: { reviewedAt: string; model: string; result: Record<string, unknown> } | null;
};
export type WritingRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  genre: WritingGenre;
  title: string;
  prompt: string;
  targetIds: string[];
  wordRange: [number, number];
  versions: WritingVersion[];
};

export const defaultSettings: AppSettings = {
  key: "app",
  dailyMinutes: 45,
  desiredRetention: 0.9,
  selectedBooks: ["HS-R1", "HS-R2", "HS-R3", "HS-S1", "HS-S2", "HS-S3", "HS-S4"],
  mode: "normal",
  theme: "system",
  aiEnabled: false,
  diagnosisComplete: false,
  examDate: null,
  updatedAt: new Date(0).toISOString(),
};

const backupStores = ["cards", "events", "lists", "settings", "writings"] as const;

export type BackupPayload = {
  schemaVersion: string;
  exportedAt?: string;
  cards: StoredCard[];
  events: ReviewEvent[];
  lists: Record<string, unknown>[];
  settings: AppSettings[];
  writings: WritingRecord[];
};

function migrateBackup(payload: BackupPayload): BackupPayload {
  if (payload.schemaVersion === USER_DATA_SCHEMA_VERSION) return payload;
  // 1.1.0 → 1.2.0 only adds writings; older backups simply have none.
  if (payload.schemaVersion === "1.1.0") return { ...payload, schemaVersion: USER_DATA_SCHEMA_VERSION, writings: [] };
  if (payload.schemaVersion !== "1.0.0") throw new Error(`不支持的 schema 版本：${payload.schemaVersion || "缺失"}`);
  return {
    ...payload,
    writings: [],
    schemaVersion: USER_DATA_SCHEMA_VERSION,
    events: payload.events.map((event) => ({ ...event, prompt: event.prompt || "", answerGiven: event.answerGiven ?? null, expectedAnswer: event.expectedAnswer ?? null, sourceLine: event.sourceLine ?? null })),
    settings: payload.settings.map((settings) => ({ ...defaultSettings, ...settings, key: "app" })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalises dates such as February 31 instead of rejecting them.
  // Check the written calendar date without changing valid timezone encodings.
  const date = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(value);
  if (!date) return true;
  const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
};
const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const finiteRange = (value: unknown, low: number, high = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const stringArray = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string" && item.length <= 500);
const skills = ["meaning", "listening", "spelling", "context", "collocation", "output"] as const;

export function validUndoTarget(target: ReviewEvent | undefined, undo: ReviewEvent) {
  return target && target.eventType !== "undo" && target.eventId === undo.targetEventId && target.cardId === undo.cardId &&
    stableJson(target.before) === stableJson(undo.before) && stableJson(target.after) === stableJson(undo.after);
}

function validCalendarDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && validDate(value) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validCard(value: unknown): value is StoredCard {
  if (!isRecord(value) || !textId(value.id) || !validDate(value.due) || !validDate(value.updatedAt) || (value.lastReviewed !== null && !validDate(value.lastReviewed))) return false;
  if (!["unseen", "learning", "weak", "mastered", "paused"].includes(String(value.status)) || !isRecord(value.skills) || !isRecord(value.fsrs)) return false;
  const vector = value.skills, fsrs = value.fsrs;
  // These are discrete FSRS counters; fractional values corrupt future state, and
  // reps needs room for the scheduler's next increment. Zero memory is valid only
  // for New cards: other states divide by stability and require prior review time.
  if (!["elapsed_days", "scheduled_days", "reps", "lapses"].every((key) =>
    Number.isSafeInteger(fsrs[key]) && finiteRange(fsrs[key], 0, ["reps", "lapses"].includes(key) ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER))) return false;
  if (fsrs.learning_steps !== undefined && (!Number.isSafeInteger(fsrs.learning_steps) || !finiteRange(fsrs.learning_steps, 0, Number.MAX_SAFE_INTEGER - 1))) return false;
  if (fsrs.last_review != null && !validDate(fsrs.last_review)) return false;
  if (typeof fsrs.last_review === "string" && Date.parse(fsrs.last_review) > MAX_REVIEW_TIME_MS) return false;
  if (!validDate(fsrs.due) || Date.parse(fsrs.due) !== Date.parse(value.due as string)) return false;
  if (fsrs.state !== 0 && (!finiteRange(fsrs.stability, Number.MIN_VALUE) || !validDate(fsrs.last_review) ||
    !validDate(value.lastReviewed) || Date.parse(fsrs.last_review) !== Date.parse(value.lastReviewed))) return false;
  return Object.keys(vector).length === skills.length && skills.every((skill) => finiteRange(vector[skill], 0, 1)) && validDate(fsrs.due) &&
    ["stability", "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses", "state"].every((key) => finiteRange(fsrs[key], 0)) &&
    finiteRange(fsrs.difficulty, 0, 10) && finiteRange(fsrs.state, 0, 3) && Number.isInteger(fsrs.state) &&
    (value.note === undefined || (typeof value.note === "string" && value.note.length <= 50_000)) &&
    (value.favorite === undefined || typeof value.favorite === "boolean") && (value.tags === undefined || stringArray(value.tags));
}

export function validWriting(value: unknown): value is WritingRecord {
  if (!isRecord(value) || !textId(value.id) || !validDate(value.createdAt) || !validDate(value.updatedAt)) return false;
  if (!["practical", "continuation", "free"].includes(String(value.genre)) || typeof value.title !== "string" || value.title.length > 200 ||
    typeof value.prompt !== "string" || value.prompt.length > 4_000) return false;
  if (!Array.isArray(value.targetIds) || value.targetIds.length > 20 || !value.targetIds.every(textId)) return false;
  const range = value.wordRange;
  if (!Array.isArray(range) || range.length !== 2 || !finiteRange(range[0], 0, 5_000) || !finiteRange(range[1], range[0] as number, 5_000)) return false;
  if (!Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > 30) return false;
  const ids = new Set<string>();
  return value.versions.every((version) => {
    if (!isRecord(version) || !textId(version.id) || ids.has(version.id) || typeof version.text !== "string" || version.text.length > 20_000 || !validDate(version.savedAt)) return false;
    ids.add(version.id);
    const review = version.review;
    return review === undefined || review === null || (isRecord(review) && validDate(review.reviewedAt) && typeof review.model === "string" &&
      review.model.length <= 200 && validWritingReview(review.result) && JSON.stringify(review.result).length <= 200_000);
  });
}

/** Scheduling values stay fixed outside review/undo; statuses are checked separately. */
function reviewState(card: StoredCard | null): string {
  const vector = card?.skills ?? Object.fromEntries(skills.map((skill) => [skill, 0]));
  const memory = card?.fsrs ?? { stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0 };
  const fresh = (card?.lastReviewed ?? null) === null && (memory.last_review ?? null) === null &&
    ["stability", "difficulty", "elapsed_days", "scheduled_days", "reps", "lapses", "state"].every((key) => memory[key] === 0) &&
    (memory.learning_steps ?? 0) === 0 && skills.every((skill) => vector[skill] === 0);
  // Undoing an originally absent card can be followed by a note/favorite edit,
  // which creates another empty card with a new initial due date. No reviewed
  // state or unknown scheduler field is discarded by this normalization.
  const due = fresh ? null : Date.parse(String(memory.due));
  return stableJson({
    fsrs: { ...memory, due, last_review: memory.last_review == null ? null : Date.parse(String(memory.last_review)),
      learning_steps: memory.learning_steps ?? 0 },
    skills: vector, due: fresh ? null : Date.parse(card!.due),
    lastReviewed: card?.lastReviewed == null ? null : Date.parse(card.lastReviewed),
  });
}

function validateReviewChains(data: BackupPayload, undoneTargets: ReadonlySet<string>) {
  const cards = new Map(data.cards.map((card) => [card.id, card]));
  type ChainState = { incoming: boolean; status?: StoredCard["status"] };
  const groups = new Map<string, { states: Map<string, ChainState>; active: ReviewEvent[]; absentBaseline: boolean }>();
  const invalid = () => { throw new Error("备份的复习链与词卡调度状态不一致"); };
  for (const event of data.events) {
    if (event.eventType === "undo") continue;
    // Every scheduler version produces a learned classification on review;
    // unseen and paused can only be baselines or independent card markers.
    if (!["learning", "weak", "mastered"].includes(event.after.status)) invalid();
    if (event.after.fsrs.reps !== (event.before ? event.before.fsrs.reps as number : 0) + 1) invalid();
    let group = groups.get(event.cardId);
    if (!group) {
      group = { states: new Map(), active: [], absentBaseline: false };
      groups.set(event.cardId, group);
    }
    const before = reviewState(event.before), after = reviewState(event.after);
    for (const [key, status, incoming] of [
      [before, event.before?.status ?? "unseen", false], [after, event.after.status, true],
    ] as const) {
      const state: ChainState = group.states.get(key) ?? { incoming: false };
      // Paused is an independent suppression marker supported by study/forecast
      // and legacy backups. Other classifications affect learning and statistics,
      // and cannot silently change for the same recorded scheduling state.
      if (status !== "paused") {
        if (state.status !== undefined && state.status !== status) invalid();
        state.status = status;
      }
      state.incoming ||= incoming;
      group.states.set(key, state);
    }
    if (event.before === null) group.absentBaseline = true;
    if (!undoneTargets.has(event.eventId)) group.active.push(event);
  }
  for (const [id, group] of groups) {
    // Each forward edge increments reps, so this graph is acyclic. A single
    // root also requires discarded undo/redo branches to share one baseline.
    // The baseline may already be reviewed: legacy exports need not start at New.
    const roots = [...group.states].filter(([, state]) => !state.incoming);
    if (roots.length !== 1) invalid();
    let terminal = roots[0][0];
    // Timestamps can tie or move backwards and getAll() exports key order.
    // Repetitions, unlike those orderings, advance on every committed review.
    group.active.sort((a, b) => (a.after.fsrs.reps as number) - (b.after.fsrs.reps as number));
    for (const event of group.active) {
      if (reviewState(event.before) !== terminal) invalid();
      terminal = reviewState(event.after);
    }
    const current = cards.get(id);
    if (current ? reviewState(current) !== terminal : group.active.length > 0 || !group.absentBaseline) invalid();
    const terminalStatus = group.states.get(terminal)!.status ?? "paused";
    if (current && current.status !== terminalStatus && current.status !== "paused") invalid();
  }
}

export function validateBackup(payload: unknown): BackupPayload {
  if (!isRecord(payload) || !["cards", "events", "lists", "settings"].every((key) => Array.isArray(payload[key]))) throw new Error("备份结构损坏或字段缺失");
  if (payload.writings !== undefined && !Array.isArray(payload.writings)) throw new Error("备份结构损坏或字段缺失");
  if (payload.schemaVersion === USER_DATA_SCHEMA_VERSION && !Array.isArray(payload.writings)) throw new Error("备份结构损坏或字段缺失");
  for (const name of backupStores) {
    const rows = (payload[name] ?? []) as unknown[];
    if (rows.length > (name === "events" ? 100_000 : name === "settings" ? 1 : name === "writings" ? 2_000 : 20_000)) throw new Error("备份记录数量超过限制");
    const ids = new Set<string>();
    for (const row of rows) {
      const key = name === "events" ? "eventId" : name === "settings" ? "key" : "id";
      if (!isRecord(row) || !textId(row[key]) || ids.has(row[key])) throw new Error("备份包含无效或重复的记录 ID");
      ids.add(row[key]);
    }
  }
  const data = migrateBackup(payload as unknown as BackupPayload);
  if (!data.cards.every(validCard)) throw new Error("备份的词卡或调度数据无效");
  if (!data.writings.every(validWriting)) throw new Error("备份的写作记录无效");
  const eventById = new Map(data.events.map((event) => [event.eventId, event]));
  const undoneTargets = new Set<string>();
  for (const event of data.events) {
    if (!textId(event.cardId) || !validDate(event.timestampUtc) || !validCalendarDate(event.localDate) ||
      !textId(event.timezone) || !textId(event.questionType) || !skills.includes(event.skill) ||
      ![1, 2, 3, 4].includes(event.rating) || typeof event.correct !== "boolean" ||
      !finiteRange(event.responseMs, 0) || !finiteRange(event.hints, 0) || !Number.isInteger(event.hints) || !isRecord(event.schedulerLog) ||
      !validCard(event.after) || event.after.id !== event.cardId || (event.before !== null && (!validCard(event.before) || event.before.id !== event.cardId)) ||
      (event.eventType !== undefined && !["review", "undo"].includes(event.eventType)) || (event.eventType === "undo" && !textId(event.targetEventId)) ||
      [event.prompt, event.answerGiven, event.expectedAnswer, event.sourceLine, event.errorType].some((value) => value != null && (typeof value !== "string" || value.length > 50_000)) ||
      [event.intervalBeforeDays, event.intervalAfterDays, event.stabilityBefore, event.stabilityAfter].some((value) => value != null && !finiteRange(value, 0)) ||
      [event.difficultyBefore, event.difficultyAfter].some((value) => value != null && !finiteRange(value, 0, 10))) throw new Error("备份的复习事件无效");
    if (event.eventType === "undo") {
      if (!validUndoTarget(eventById.get(event.targetEventId!), event) || undoneTargets.has(event.targetEventId!)) throw new Error("备份的撤销记录与原复习事件不一致");
      undoneTargets.add(event.targetEventId!);
    }
  }
  validateReviewChains(data, undoneTargets);
  for (const settings of data.settings) {
    if (settings.key !== "app" || !finiteRange(settings.dailyMinutes, 1, 1440) || !finiteRange(settings.desiredRetention, 0.7, 0.99) ||
      !stringArray(settings.selectedBooks) || !["normal", "unit", "review-only", "exam", "browse"].includes(settings.mode) ||
      !["light", "dark", "system"].includes(settings.theme) || typeof settings.aiEnabled !== "boolean" ||
      typeof settings.diagnosisComplete !== "boolean" || !validDate(settings.updatedAt) ||
      (settings.examDate !== null && !validDate(settings.examDate))) throw new Error("备份的学习设置无效");
  }
  return data;
}
