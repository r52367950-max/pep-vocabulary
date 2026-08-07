/**
 * A deterministic, persistence-friendly acquisition state machine.
 *
 * Acquisition is deliberately separate from FSRS review. Callers may create an
 * FSRS card only for entries returned by `getFsrsPromotionCandidates`, persist
 * it, and then acknowledge that write with `acknowledgeFsrsPromotion`.
 */

export const ACQUISITION_SCHEMA_VERSION = 1 as const;
export const ACQUISITION_LIMITS = Object.freeze({
  maxBatchSize: 8,
  maxHeadwordLength: 80,
  maxMeaningLength: 240,
  maxAnswerLength: 400,
  maxSerializedBytes: 96_000,
  maxQueueLength: 256,
  maxHistoryLength: 256,
  minDelayMs: 30_000,
  maxDelayMs: 10 * 60_000,
  defaultDelayMs: 2 * 60_000,
  minAttemptsPerStage: 2,
  maxAttemptsPerStage: 5,
  defaultAttemptsPerStage: 3,
});

export type AcquisitionStage = "preview" | "cue-recall" | "spelling" | "production" | "delayed-recall";
export type GradedAcquisitionStage = Exclude<AcquisitionStage, "preview">;
export type AcquisitionItemStatus = "acquiring" | "needs-support" | "graduated" | "promoted";
export type AcquisitionJudgment = "pass" | "fail";

export type AcquisitionSeedItem = {
  wordId: string;
  headword: string;
  meaning: string;
};

type StageCounter = Record<GradedAcquisitionStage, number>;
type CompletionFlags = Record<GradedAcquisitionStage, boolean>;

export type AcquisitionItemState = AcquisitionSeedItem & {
  status: AcquisitionItemStatus;
  previewed: boolean;
  completed: CompletionFlags;
  attempts: StageCounter;
  correct: StageCounter;
  graduatedAt: string | null;
  promotedAt: string | null;
};

export type AcquisitionAction = {
  id: string;
  sequence: number;
  wordId: string;
  stage: AcquisitionStage;
  availableAt: string;
  remediation: boolean;
};

export type AcquisitionHistoryEntry = {
  actionId: string;
  sequence: number;
  wordId: string;
  stage: AcquisitionStage;
  answeredAt: string;
  passed: boolean;
  responseLength: number;
  reason: AcquisitionOutcomeReason;
};

export type AcquisitionSession = {
  schemaVersion: typeof ACQUISITION_SCHEMA_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  delayMs: number;
  maxAttemptsPerStage: number;
  turn: number;
  nextActionSequence: number;
  items: AcquisitionItemState[];
  queue: AcquisitionAction[];
  history: AcquisitionHistoryEntry[];
};

export type AcquisitionResponse = {
  actionId: string;
  wordId: string;
  answer?: string;
  judgment?: AcquisitionJudgment;
};

export type AcquisitionOutcomeReason =
  | "previewed"
  | "self-recalled"
  | "self-missed"
  | "exact-spelling"
  | "spelling-mismatch"
  | "valid-production"
  | "production-too-short"
  | "production-missing-target"
  | "production-rejected"
  | "delayed-recall-passed"
  | "delayed-recall-missed";

export type AcquisitionOutcome = {
  wordId: string;
  stage: AcquisitionStage;
  passed: boolean;
  reason: AcquisitionOutcomeReason;
  graduated: boolean;
  needsSupport: boolean;
};

export type AcquisitionNext =
  | { kind: "action"; action: AcquisitionAction; item: AcquisitionSeedItem }
  | { kind: "waiting"; resumeAt: string }
  | { kind: "complete" };

export type AcquisitionStats = {
  total: number;
  acquiring: number;
  graduated: number;
  promoted: number;
  needsSupport: number;
  previewed: number;
  interactions: number;
  gradedAttempts: number;
  correctAttempts: number;
  accuracy: number | null;
  waitingUntil: string | null;
  fsrsReadyWordIds: string[];
};

export type FsrsPromotionCandidate = {
  wordId: string;
  acquiredAt: string;
};

type StartOptions = {
  sessionId?: string;
  now?: Date | string;
  delayMs?: number;
  maxAttemptsPerStage?: number;
};

const GRADED_STAGES: GradedAcquisitionStage[] = ["cue-recall", "spelling", "production", "delayed-recall"];
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,111}$/;
const WORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const REASON_CONTRACT: Record<AcquisitionOutcomeReason, { stage: AcquisitionStage; passed: boolean }> = {
  previewed: { stage: "preview", passed: true },
  "self-recalled": { stage: "cue-recall", passed: true },
  "self-missed": { stage: "cue-recall", passed: false },
  "exact-spelling": { stage: "spelling", passed: true },
  "spelling-mismatch": { stage: "spelling", passed: false },
  "valid-production": { stage: "production", passed: true },
  "production-too-short": { stage: "production", passed: false },
  "production-missing-target": { stage: "production", passed: false },
  "production-rejected": { stage: "production", passed: false },
  "delayed-recall-passed": { stage: "delayed-recall", passed: true },
  "delayed-recall-missed": { stage: "delayed-recall", passed: false },
};

function fail(message: string): never {
  throw new Error(`背诵进度无效：${message}`);
}

function boundedInteger(value: unknown, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) fail(`${label} 超出范围`);
  return Number(value);
}

function canonicalIso(value: Date | string, label: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} 不是有效时间`);
  return date.toISOString();
}

function cleanText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") fail(`${label} 必须是文本`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) fail(`${label} 长度或字符无效`);
  return normalized;
}

function safeId(value: unknown, label: string, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} 格式无效`);
  return value;
}

function counter(value = 0): StageCounter {
  return { "cue-recall": value, spelling: value, production: value, "delayed-recall": value };
}

function completion(value = false): CompletionFlags {
  return { "cue-recall": value, spelling: value, production: value, "delayed-recall": value };
}

function fingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function cloneSession(session: AcquisitionSession): AcquisitionSession {
  return {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    delayMs: session.delayMs,
    maxAttemptsPerStage: session.maxAttemptsPerStage,
    turn: session.turn,
    nextActionSequence: session.nextActionSequence,
    items: session.items.map((item) => ({
      ...item,
      completed: { ...item.completed },
      attempts: { ...item.attempts },
      correct: { ...item.correct },
    })),
    queue: session.queue.map((action) => ({ ...action })),
    history: session.history.map((entry) => ({ ...entry })),
  };
}

function actionId(session: AcquisitionSession, sequence: number) {
  return `${session.id}:a${sequence.toString(36)}`;
}

function appendAction(session: AcquisitionSession, wordId: string, stage: AcquisitionStage, availableAt: string, remediation = false) {
  if (session.queue.length >= ACQUISITION_LIMITS.maxQueueLength) fail("待办队列过长");
  const sequence = session.nextActionSequence;
  session.nextActionSequence += 1;
  session.queue.push({ id: actionId(session, sequence), sequence, wordId, stage, availableAt, remediation });
}

function normalizeSpelling(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function containsTarget(answer: string, headword: string) {
  const normalizedAnswer = normalizeSpelling(answer);
  const target = normalizeSpelling(headword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${target}(?:$|[^a-z0-9])`, "i").test(normalizedAnswer);
}

function responseLength(response: AcquisitionResponse) {
  return typeof response.answer === "string" ? response.answer.length : 0;
}

function gradeResponse(item: AcquisitionItemState, stage: AcquisitionStage, response: AcquisitionResponse): { passed: boolean; reason: AcquisitionOutcomeReason } {
  if (stage === "preview") return { passed: true, reason: "previewed" };
  if (stage === "cue-recall") {
    if (response.judgment !== "pass" && response.judgment !== "fail") fail("线索回忆必须明确记得或未记得");
    return response.judgment === "pass"
      ? { passed: true, reason: "self-recalled" }
      : { passed: false, reason: "self-missed" };
  }
  if (typeof response.answer !== "string") fail(`${stage} 缺少作答`);
  const maxLength = stage === "production" ? ACQUISITION_LIMITS.maxAnswerLength : ACQUISITION_LIMITS.maxHeadwordLength;
  if (!response.answer.trim() || response.answer.length > maxLength) fail(`${stage} 作答长度无效`);
  if (stage === "spelling") {
    return normalizeSpelling(response.answer) === normalizeSpelling(item.headword)
      ? { passed: true, reason: "exact-spelling" }
      : { passed: false, reason: "spelling-mismatch" };
  }
  if (stage === "delayed-recall") {
    return normalizeSpelling(response.answer) === normalizeSpelling(item.headword)
      ? { passed: true, reason: "delayed-recall-passed" }
      : { passed: false, reason: "delayed-recall-missed" };
  }
  if (!containsTarget(response.answer, item.headword)) return { passed: false, reason: "production-missing-target" };
  if (normalizeSpelling(response.answer).split(/\s+/).filter(Boolean).length < 5) return { passed: false, reason: "production-too-short" };
  if (response.judgment === "fail") return { passed: false, reason: "production-rejected" };
  return { passed: true, reason: "valid-production" };
}

function resetAfterDelayedMiss(item: AcquisitionItemState) {
  item.completed["cue-recall"] = false;
  item.completed.spelling = false;
  item.completed.production = false;
  item.completed["delayed-recall"] = false;
}

function removePendingWordActions(session: AcquisitionSession, wordId: string) {
  session.queue = session.queue.filter((queued) => queued.wordId !== wordId);
}

function assertRecordedReason(entry: AcquisitionHistoryEntry) {
  const contract = REASON_CONTRACT[entry.reason];
  if (!contract || contract.stage !== entry.stage || contract.passed !== entry.passed) fail("历史原因与阶段结果不一致");
}

function applyRecordedHistoryEntry(current: AcquisitionSession, entry: AcquisitionHistoryEntry): AcquisitionSession {
  assertRecordedReason(entry);
  const answeredAt = canonicalIso(entry.answeredAt, "历史时间");
  if (new Date(answeredAt).getTime() < new Date(current.updatedAt).getTime()) fail("历史时间倒序");
  const next = getNextAcquisitionAction(current, answeredAt);
  if (next.kind !== "action") fail("历史无法按队列重放");
  if (
    next.action.id !== entry.actionId
    || next.action.sequence !== entry.sequence
    || next.action.wordId !== entry.wordId
    || next.action.stage !== entry.stage
  ) {
    fail("历史任务与待办队列不一致");
  }

  const session = cloneSession(current);
  const actionIndex = session.queue.findIndex((action) => action.id === entry.actionId);
  if (actionIndex < 0) fail("历史任务已经不存在");
  const [action] = session.queue.splice(actionIndex, 1);
  const item = session.items.find((candidate) => candidate.wordId === action.wordId);
  if (!item || item.status !== "acquiring") fail("历史词条不在学习状态");

  session.turn += 1;
  session.updatedAt = answeredAt;
  if (action.stage === "preview") {
    item.previewed = true;
  } else {
    item.attempts[action.stage] += 1;
    if (entry.passed) item.correct[action.stage] += 1;
  }

  if (entry.passed) {
    if (action.stage === "cue-recall") {
      item.completed["cue-recall"] = true;
      appendAction(session, item.wordId, "spelling", answeredAt);
    } else if (action.stage === "spelling") {
      item.completed.spelling = true;
      appendAction(session, item.wordId, "production", answeredAt);
    } else if (action.stage === "production") {
      item.completed.production = true;
      const availableAt = new Date(new Date(answeredAt).getTime() + session.delayMs).toISOString();
      appendAction(session, item.wordId, "delayed-recall", availableAt);
    } else if (action.stage === "delayed-recall") {
      item.completed["delayed-recall"] = true;
      item.status = "graduated";
      item.graduatedAt = answeredAt;
      removePendingWordActions(session, item.wordId);
    }
  } else if (action.stage !== "preview") {
    if (item.attempts[action.stage] >= session.maxAttemptsPerStage) {
      item.status = "needs-support";
      removePendingWordActions(session, item.wordId);
    } else {
      if (action.stage === "delayed-recall") resetAfterDelayedMiss(item);
      appendAction(session, item.wordId, "preview", answeredAt, true);
      appendAction(session, item.wordId, action.stage === "delayed-recall" ? "cue-recall" : action.stage, answeredAt, true);
    }
  }

  if (session.history.length >= ACQUISITION_LIMITS.maxHistoryLength) fail("交互历史过长");
  session.history.push({ ...entry, answeredAt });
  return session;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function latestIso(values: string[]) {
  return values.reduce((latest, value) => new Date(value).getTime() > new Date(latest).getTime() ? value : latest);
}

function assertRestoredSessionReplays(session: AcquisitionSession) {
  let replay = startAcquisitionSession(
    session.items.map((item) => ({ wordId: item.wordId, headword: item.headword, meaning: item.meaning })),
    {
      sessionId: session.id,
      now: session.createdAt,
      delayMs: session.delayMs,
      maxAttemptsPerStage: session.maxAttemptsPerStage,
    },
  );
  for (const entry of session.history) replay = applyRecordedHistoryEntry(replay, entry);

  if (replay.turn !== session.turn) fail("交互轮次与历史重放不一致");
  if (replay.nextActionSequence !== session.nextActionSequence) fail("下一个任务序号与历史重放不一致");
  if (!sameJson(replay.queue, session.queue)) fail("待办队列与历史重放不一致");

  const promotedTimes = session.items.flatMap((item) => item.promotedAt ? [item.promotedAt] : []);
  const expectedUpdatedAt = latestIso([replay.updatedAt, ...promotedTimes]);
  if (session.updatedAt !== expectedUpdatedAt) fail("更新时间与历史或入队记录不一致");

  for (const item of session.items) {
    const replayItem = replay.items.find((candidate) => candidate.wordId === item.wordId);
    if (!replayItem) fail("历史重放缺少词条");
    if (item.headword !== replayItem.headword || item.meaning !== replayItem.meaning) fail("词条文本与历史重放不一致");
    if (item.previewed !== replayItem.previewed) fail("预习状态与历史重放不一致");
    if (!sameJson(item.completed, replayItem.completed)) fail("完成状态与历史重放不一致");
    if (!sameJson(item.attempts, replayItem.attempts) || !sameJson(item.correct, replayItem.correct)) fail("尝试次数与历史重放不一致");
    if (item.graduatedAt !== replayItem.graduatedAt) fail("毕业时间与历史重放不一致");
    if (item.status === "promoted") {
      if (replayItem.status !== "graduated" || !replayItem.graduatedAt || !item.promotedAt) fail("入队状态缺少毕业记录");
      if (new Date(item.promotedAt).getTime() < new Date(replayItem.graduatedAt).getTime()) fail("入队时间早于毕业时间");
    } else {
      if (item.status !== replayItem.status) fail("词条状态与历史重放不一致");
      if (item.promotedAt !== null) fail("未入队词条含有入队时间");
    }
  }
}

export function startAcquisitionSession(seedItems: AcquisitionSeedItem[], options: StartOptions = {}): AcquisitionSession {
  if (!Array.isArray(seedItems) || seedItems.length < 1 || seedItems.length > ACQUISITION_LIMITS.maxBatchSize) {
    fail(`每批必须为 1–${ACQUISITION_LIMITS.maxBatchSize} 个词`);
  }
  const now = canonicalIso(options.now ?? new Date(), "开始时间");
  const delayMs = options.delayMs === undefined
    ? ACQUISITION_LIMITS.defaultDelayMs
    : boundedInteger(options.delayMs, "延迟再测时间", ACQUISITION_LIMITS.minDelayMs, ACQUISITION_LIMITS.maxDelayMs);
  const maxAttemptsPerStage = options.maxAttemptsPerStage === undefined
    ? ACQUISITION_LIMITS.defaultAttemptsPerStage
    : boundedInteger(
      options.maxAttemptsPerStage,
      "每阶段尝试次数",
      ACQUISITION_LIMITS.minAttemptsPerStage,
      ACQUISITION_LIMITS.maxAttemptsPerStage,
    );
  const seen = new Set<string>();
  const items = seedItems.map((seed) => {
    const wordId = safeId(seed?.wordId, "词条 ID", WORD_ID_PATTERN);
    if (seen.has(wordId)) fail("同一批次不能包含重复词条");
    seen.add(wordId);
    return {
      wordId,
      headword: cleanText(seed.headword, "词头", ACQUISITION_LIMITS.maxHeadwordLength),
      meaning: cleanText(seed.meaning, "核心义", ACQUISITION_LIMITS.maxMeaningLength),
      status: "acquiring" as const,
      previewed: false,
      completed: completion(),
      attempts: counter(),
      correct: counter(),
      graduatedAt: null,
      promotedAt: null,
    };
  });
  const defaultId = `acq-${new Date(now).getTime().toString(36)}-${fingerprint(items.map((item) => item.wordId).join("|"))}`;
  const id = safeId(options.sessionId ?? defaultId, "会话 ID", SESSION_ID_PATTERN);
  const session: AcquisitionSession = {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    delayMs,
    maxAttemptsPerStage,
    turn: 0,
    nextActionSequence: 0,
    items,
    queue: [],
    history: [],
  };
  for (const item of items) appendAction(session, item.wordId, "preview", now);
  for (const item of items) appendAction(session, item.wordId, "cue-recall", now);
  return session;
}

export function getNextAcquisitionAction(session: AcquisitionSession, now: Date | string = new Date()): AcquisitionNext {
  const at = canonicalIso(now, "当前时间");
  const atMs = new Date(at).getTime();
  let resumeAt: string | null = null;
  for (const action of session.queue) {
    const item = session.items.find((candidate) => candidate.wordId === action.wordId);
    if (!item || item.status !== "acquiring") continue;
    if (new Date(action.availableAt).getTime() <= atMs) {
      return {
        kind: "action",
        action: { ...action },
        item: { wordId: item.wordId, headword: item.headword, meaning: item.meaning },
      };
    }
    if (resumeAt === null || action.availableAt < resumeAt) resumeAt = action.availableAt;
  }
  return resumeAt ? { kind: "waiting", resumeAt } : { kind: "complete" };
}

export function submitAcquisitionResponse(
  current: AcquisitionSession,
  response: AcquisitionResponse,
  now: Date | string = new Date(),
): { session: AcquisitionSession; outcome: AcquisitionOutcome } {
  const answeredAt = canonicalIso(now, "作答时间");
  if (new Date(answeredAt).getTime() < new Date(current.updatedAt).getTime()) fail("作答时间早于已有进度");
  const next = getNextAcquisitionAction(current, answeredAt);
  if (next.kind !== "action") fail(next.kind === "waiting" ? "延迟再测尚未到时间" : "本批次已经结束");
  if (response.actionId !== next.action.id || response.wordId !== next.action.wordId) fail("作答与当前任务不匹配");

  const session = cloneSession(current);
  const actionIndex = session.queue.findIndex((action) => action.id === response.actionId);
  if (actionIndex < 0) fail("任务不存在或已经提交");
  const [action] = session.queue.splice(actionIndex, 1);
  const item = session.items.find((candidate) => candidate.wordId === action.wordId);
  if (!item || item.status !== "acquiring") fail("词条不在学习状态");
  const result = gradeResponse(item, action.stage, response);

  session.turn += 1;
  session.updatedAt = answeredAt;
  if (action.stage === "preview") {
    item.previewed = true;
  } else {
    item.attempts[action.stage] += 1;
    if (result.passed) item.correct[action.stage] += 1;
  }

  let graduated = false;
  let needsSupport = false;
  if (result.passed) {
    if (action.stage === "cue-recall") {
      item.completed["cue-recall"] = true;
      appendAction(session, item.wordId, "spelling", answeredAt);
    } else if (action.stage === "spelling") {
      item.completed.spelling = true;
      appendAction(session, item.wordId, "production", answeredAt);
    } else if (action.stage === "production") {
      item.completed.production = true;
      const availableAt = new Date(new Date(answeredAt).getTime() + session.delayMs).toISOString();
      appendAction(session, item.wordId, "delayed-recall", availableAt);
    } else if (action.stage === "delayed-recall") {
      item.completed["delayed-recall"] = true;
      item.status = "graduated";
      item.graduatedAt = answeredAt;
      graduated = true;
      removePendingWordActions(session, item.wordId);
    }
  } else if (action.stage !== "preview") {
    if (item.attempts[action.stage] >= session.maxAttemptsPerStage) {
      item.status = "needs-support";
      needsSupport = true;
      removePendingWordActions(session, item.wordId);
    } else {
      if (action.stage === "delayed-recall") resetAfterDelayedMiss(item);
      appendAction(session, item.wordId, "preview", answeredAt, true);
      appendAction(session, item.wordId, action.stage === "delayed-recall" ? "cue-recall" : action.stage, answeredAt, true);
    }
  }

  if (session.history.length >= ACQUISITION_LIMITS.maxHistoryLength) fail("交互历史过长");
  session.history.push({
    actionId: action.id,
    sequence: action.sequence,
    wordId: action.wordId,
    stage: action.stage,
    answeredAt,
    passed: result.passed,
    responseLength: responseLength(response),
    reason: result.reason,
  });
  return {
    session,
    outcome: { wordId: item.wordId, stage: action.stage, passed: result.passed, reason: result.reason, graduated, needsSupport },
  };
}

export function getFsrsPromotionCandidates(session: AcquisitionSession): FsrsPromotionCandidate[] {
  return session.items
    .filter((item) => item.status === "graduated" && item.graduatedAt !== null && item.promotedAt === null)
    .map((item) => ({ wordId: item.wordId, acquiredAt: item.graduatedAt! }));
}

export function acknowledgeFsrsPromotion(current: AcquisitionSession, wordId: string, now: Date | string = new Date()) {
  const promotedAt = canonicalIso(now, "入队时间");
  if (new Date(promotedAt).getTime() < new Date(current.updatedAt).getTime()) fail("入队时间早于已有进度");
  const session = cloneSession(current);
  const item = session.items.find((candidate) => candidate.wordId === wordId);
  if (!item) fail("词条不在本批次");
  if (item.status === "promoted") return session;
  if (item.status !== "graduated" || !item.graduatedAt) fail("词条尚未完成背诵，不能进入复习");
  item.status = "promoted";
  item.promotedAt = promotedAt;
  session.updatedAt = promotedAt;
  return session;
}

export function getAcquisitionStats(session: AcquisitionSession, now: Date | string = new Date()): AcquisitionStats {
  const graded = session.history.filter((entry) => entry.stage !== "preview");
  const correctAttempts = graded.filter((entry) => entry.passed).length;
  const next = getNextAcquisitionAction(session, now);
  return {
    total: session.items.length,
    acquiring: session.items.filter((item) => item.status === "acquiring").length,
    graduated: session.items.filter((item) => item.status === "graduated").length,
    promoted: session.items.filter((item) => item.status === "promoted").length,
    needsSupport: session.items.filter((item) => item.status === "needs-support").length,
    previewed: session.items.filter((item) => item.previewed).length,
    interactions: session.history.length,
    gradedAttempts: graded.length,
    correctAttempts,
    accuracy: graded.length ? Number((correctAttempts / graded.length).toFixed(3)) : null,
    waitingUntil: next.kind === "waiting" ? next.resumeAt : null,
    fsrsReadyWordIds: getFsrsPromotionCandidates(session).map((item) => item.wordId),
  };
}

export function serializeAcquisitionSession(session: AcquisitionSession) {
  const serialized = JSON.stringify(session);
  if (new TextEncoder().encode(serialized).byteLength > ACQUISITION_LIMITS.maxSerializedBytes) fail("序列化进度过大");
  return serialized;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 结构无效`);
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") fail(`${label} 必须为布尔值`);
  return value;
}

function readNullableIso(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${label} 结构无效`);
  return canonicalIso(value, label);
}

function readStage(value: unknown): AcquisitionStage {
  if (value !== "preview" && !GRADED_STAGES.includes(value as GradedAcquisitionStage)) fail("阶段无效");
  return value as AcquisitionStage;
}

function readStatus(value: unknown): AcquisitionItemStatus {
  if (value !== "acquiring" && value !== "needs-support" && value !== "graduated" && value !== "promoted") fail("词条状态无效");
  return value;
}

function readCounter(value: unknown, label: string, max: number): StageCounter {
  const row = readRecord(value, label);
  return {
    "cue-recall": boundedInteger(row["cue-recall"], `${label}.cue-recall`, 0, max),
    spelling: boundedInteger(row.spelling, `${label}.spelling`, 0, max),
    production: boundedInteger(row.production, `${label}.production`, 0, max),
    "delayed-recall": boundedInteger(row["delayed-recall"], `${label}.delayed-recall`, 0, max),
  };
}

function readCompletion(value: unknown): CompletionFlags {
  const row = readRecord(value, "完成状态");
  return {
    "cue-recall": readBoolean(row["cue-recall"], "完成状态.cue-recall"),
    spelling: readBoolean(row.spelling, "完成状态.spelling"),
    production: readBoolean(row.production, "完成状态.production"),
    "delayed-recall": readBoolean(row["delayed-recall"], "完成状态.delayed-recall"),
  };
}

export function restoreAcquisitionSession(payload: string | unknown): AcquisitionSession {
  let decoded: unknown = payload;
  if (typeof payload === "string") {
    if (new TextEncoder().encode(payload).byteLength > ACQUISITION_LIMITS.maxSerializedBytes) fail("序列化进度过大");
    try {
      decoded = JSON.parse(payload);
    } catch {
      fail("JSON 无法解析");
    }
  }
  const row = readRecord(decoded, "会话");
  if (row.schemaVersion !== ACQUISITION_SCHEMA_VERSION) fail("版本不受支持");
  const id = safeId(row.id, "会话 ID", SESSION_ID_PATTERN);
  const createdAt = canonicalIso(String(row.createdAt), "开始时间");
  const updatedAt = canonicalIso(String(row.updatedAt), "更新时间");
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) fail("更新时间早于开始时间");
  const delayMs = boundedInteger(row.delayMs, "延迟再测时间", ACQUISITION_LIMITS.minDelayMs, ACQUISITION_LIMITS.maxDelayMs);
  const maxAttemptsPerStage = boundedInteger(
    row.maxAttemptsPerStage,
    "每阶段尝试次数",
    ACQUISITION_LIMITS.minAttemptsPerStage,
    ACQUISITION_LIMITS.maxAttemptsPerStage,
  );
  const turn = boundedInteger(row.turn, "交互轮次", 0, ACQUISITION_LIMITS.maxHistoryLength);
  const nextActionSequence = boundedInteger(row.nextActionSequence, "任务序号", 0, ACQUISITION_LIMITS.maxQueueLength * 4);
  if (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > ACQUISITION_LIMITS.maxBatchSize) fail("词条数量无效");
  const seenWordIds = new Set<string>();
  const items = row.items.map((rawItem) => {
    const item = readRecord(rawItem, "词条");
    const wordId = safeId(item.wordId, "词条 ID", WORD_ID_PATTERN);
    if (seenWordIds.has(wordId)) fail("词条 ID 重复");
    seenWordIds.add(wordId);
    const status = readStatus(item.status);
    const graduatedAt = readNullableIso(item.graduatedAt, "毕业时间");
    const promotedAt = readNullableIso(item.promotedAt, "入队时间");
    const completed = readCompletion(item.completed);
    if ((status === "graduated" || status === "promoted") && (!completed["delayed-recall"] || !graduatedAt)) fail("毕业状态缺少完成证据");
    if ((status === "acquiring" || status === "needs-support") && graduatedAt) fail("未毕业词条含有毕业时间");
    if (status === "promoted" && !promotedAt) fail("入队状态缺少时间");
    if (status !== "promoted" && promotedAt) fail("未入队词条含有入队时间");
    if (graduatedAt && promotedAt && new Date(promotedAt).getTime() < new Date(graduatedAt).getTime()) fail("入队时间早于毕业时间");
    const attempts = readCounter(item.attempts, "尝试次数", maxAttemptsPerStage);
    const correct = readCounter(item.correct, "正确次数", maxAttemptsPerStage);
    for (const stage of GRADED_STAGES) if (correct[stage] > attempts[stage]) fail("正确次数不能超过尝试次数");
    return {
      wordId,
      headword: cleanText(item.headword, "词头", ACQUISITION_LIMITS.maxHeadwordLength),
      meaning: cleanText(item.meaning, "核心义", ACQUISITION_LIMITS.maxMeaningLength),
      status,
      previewed: readBoolean(item.previewed, "预习状态"),
      completed,
      attempts,
      correct,
      graduatedAt,
      promotedAt,
    };
  });
  if (!Array.isArray(row.queue) || row.queue.length > ACQUISITION_LIMITS.maxQueueLength) fail("待办队列无效");
  const seenActions = new Set<string>();
  const queue = row.queue.map((rawAction) => {
    const action = readRecord(rawAction, "任务");
    const wordId = safeId(action.wordId, "任务词条 ID", WORD_ID_PATTERN);
    if (!seenWordIds.has(wordId)) fail("任务引用未知词条");
    const sequence = boundedInteger(action.sequence, "任务序号", 0, ACQUISITION_LIMITS.maxQueueLength * 4);
    const actionValue = safeId(action.id, "任务 ID", ACTION_ID_PATTERN);
    if (seenActions.has(actionValue)) fail("任务 ID 重复");
    seenActions.add(actionValue);
    if (actionValue !== `${id}:a${sequence.toString(36)}`) fail("任务 ID 与序号不一致");
    return {
      id: actionValue,
      sequence,
      wordId,
      stage: readStage(action.stage),
      availableAt: canonicalIso(String(action.availableAt), "任务可用时间"),
      remediation: readBoolean(action.remediation, "补救标记"),
    };
  });
  if (!Array.isArray(row.history) || row.history.length > ACQUISITION_LIMITS.maxHistoryLength) fail("交互历史无效");
  const history = row.history.map((rawEntry) => {
    const entry = readRecord(rawEntry, "历史记录");
    const stage = readStage(entry.stage);
    const reason = entry.reason;
    if (typeof reason !== "string" || !(reason in REASON_CONTRACT)) fail("历史原因无效");
    const wordId = safeId(entry.wordId, "历史词条 ID", WORD_ID_PATTERN);
    if (!seenWordIds.has(wordId)) fail("历史引用未知词条");
    const sequence = boundedInteger(entry.sequence, "历史序号", 0, ACQUISITION_LIMITS.maxQueueLength * 4);
    const historyActionId = safeId(entry.actionId, "历史任务 ID", ACTION_ID_PATTERN);
    if (historyActionId !== `${id}:a${sequence.toString(36)}`) fail("历史任务 ID 与序号不一致");
    if (seenActions.has(historyActionId)) fail("任务 ID 重复");
    seenActions.add(historyActionId);
    return {
      actionId: historyActionId,
      sequence,
      wordId,
      stage,
      answeredAt: canonicalIso(String(entry.answeredAt), "历史时间"),
      passed: readBoolean(entry.passed, "历史结果"),
      responseLength: boundedInteger(entry.responseLength, "作答长度", 0, ACQUISITION_LIMITS.maxAnswerLength),
      reason,
    };
  });
  if (history.length !== turn) fail("交互轮次与历史长度不一致");
  const highestSequence = [...queue, ...history].reduce((highest, entry) => Math.max(highest, entry.sequence), -1);
  if (nextActionSequence <= highestSequence) fail("下一个任务序号没有前进");
  const restored: AcquisitionSession = {
    schemaVersion: ACQUISITION_SCHEMA_VERSION,
    id,
    createdAt,
    updatedAt,
    delayMs,
    maxAttemptsPerStage,
    turn,
    nextActionSequence,
    items,
    queue,
    history,
  };
  assertRestoredSessionReplays(restored);
  return restored;
}
