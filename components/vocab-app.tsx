"use client";

import {
  BarChart3,
  BookOpen,
  Bookmark,
  CalendarDays,
  Check,
  ChevronRight,
  Database,
  Download,
  FileText,
  Flame,
  Info,
  MoveHorizontal,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  Undo2,
  Upload,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { loadDetails, loadLexicon, speakSystem, type LexiconDetail, type LexiconIndexEntry, type LexiconManifest, type Scope } from "@/lib/lexicon";
import { buildQuestion, gradeQuestion, localSentenceCheck, QUESTION_CATALOG, type Question, type QuestionType } from "@/lib/questions";
import { dueLabel, isDue, newStoredCard, previewIntervals, retrievabilityOf, scheduleReview, workloadEstimate } from "@/lib/scheduler";
import {
  clearUserData,
  createLocalId,
  defaultSettings,
  deleteOne,
  exportBackup,
  getAll,
  loadSettings,
  putOne,
  restoreBackup,
  saveSettings,
  type AppSettings,
  type ReviewEvent,
  type SkillName,
  type StoredCard,
} from "@/lib/storage";

type View = "today" | "lexicon" | "plan" | "analysis" | "data";
type SessionKind = "daily" | "diagnostic" | "free";
type SessionState = {
  kind: SessionKind;
  queue: LexiconIndexEntry[];
  details: Map<string, LexiconDetail>;
  position: number;
  startedAt: number;
  reviewed: number;
  correct: number;
  streak: number;
  endedAt?: number;
};

const scopeLabels: Record<string, string> = {
  "middle-core": "初中核心",
  "high-required": "高中必修",
  "high-selective": "选择性必修",
  "curriculum-not-textbook": "课标差集",
  "gaokao-supplement": "高考补充",
  "common-supplement": "常用课外",
};

const scopeOrder: Scope[] = ["high-required", "high-selective", "middle-core", "curriculum-not-textbook", "gaokao-supplement", "common-supplement"];

const bookOptions = [
  ["HS-R1", "必修一"], ["HS-R2", "必修二"], ["HS-R3", "必修三"],
  ["HS-S1", "选必一"], ["HS-S2", "选必二"], ["HS-S3", "选必三"], ["HS-S4", "选必四"],
  ["JH-7A", "七上"], ["JH-7B", "七下"], ["JH-8A", "八上"], ["JH-8B", "八下"], ["JH-9", "九年级"],
] as const;

const statusOptions = [
  ["weak", "薄弱"], ["unseen", "未学"], ["learning", "学习中"], ["mastered", "已掌握"], ["favorite", "已收藏"],
] as const;

const skillLabels: Record<SkillName, string> = {
  meaning: "识义", listening: "听辨", spelling: "拼写", context: "语境", collocation: "搭配", output: "输出",
};

const modeLabels: Record<AppSettings["mode"], string> = {
  normal: "普通学习", unit: "单元同步", "review-only": "只复习", exam: "考前强化", browse: "自由浏览",
};

const ratingLabels: Record<number, string> = { 1: "忘记", 2: "困难", 3: "记得", 4: "轻松" };

const navItems: Array<{ id: View; label: string; icon: typeof BookOpen; group: "学习" | "证据" }> = [
  { id: "today", label: "今日", icon: Target, group: "学习" },
  { id: "lexicon", label: "词库", icon: BookOpen, group: "学习" },
  { id: "plan", label: "计划", icon: CalendarDays, group: "学习" },
  { id: "analysis", label: "分析", icon: BarChart3, group: "证据" },
  { id: "data", label: "数据", icon: SlidersHorizontal, group: "证据" },
];

const skillTypeMap: Record<SkillName, QuestionType[]> = {
  meaning: ["meaning-recall", "natural-expression"],
  listening: ["listening-choice", "dictation"],
  spelling: ["spelling", "word-form"],
  context: ["context-choice", "confusable"],
  collocation: ["collocation-gap", "family-conversion"],
  output: ["sentence-output", "paragraph-retell"],
};

/** 题型选择是纯函数，今日队列预览与学习流共用同一套判断。 */
function pickQuestionType(kind: SessionKind, position: number, card: StoredCard | undefined): QuestionType {
  if (kind === "diagnostic") return (["meaning-recall", "listening-choice", "spelling"] as QuestionType[])[position % 3];
  if (card?.skills) {
    const weakest = (Object.entries(card.skills) as Array<[SkillName, number]>).sort((a, b) => a[1] - b[1])[0]?.[0];
    if (weakest) return skillTypeMap[weakest][position % skillTypeMap[weakest].length];
  }
  return QUESTION_CATALOG[position % QUESTION_CATALOG.length].id;
}

function typeShort(type: QuestionType) {
  return QUESTION_CATALOG.find((item) => item.id === type)?.short || "识义";
}

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatMinutes(value: number) {
  return value < 60 ? `${Math.round(value)} 分钟` : `${Math.floor(value / 60)} 小时 ${Math.round(value % 60)} 分`;
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function statusLabel(status?: StoredCard["status"]) {
  return ({ unseen: "未学", learning: "学习中", weak: "薄弱", mastered: "已掌握", paused: "暂停" } as const)[status || "unseen"];
}

/** 位置要压进一行：册次用「选必二」这类短名，Unit 缩成 U。 */
function shortSource(entry: LexiconIndexEntry) {
  const source = entry.sources[0];
  if (!source) return "来源待核";
  const volume = bookOptions.find(([id]) => id === source.bookId)?.[1] || source.volume;
  const unit = source.unit.replace(/^Unit\s*/i, "U");
  return `${volume} · ${unit}${source.printedPage ? ` · p.${source.printedPage}` : ""}`;
}

function fullSource(entry: LexiconIndexEntry) {
  const source = entry.sources[0];
  if (!source) return "来源待核";
  return `${source.volume} · ${source.unit}${source.printedPage ? ` · p.${source.printedPage}` : ""}`;
}

function overdueLabel(card: StoredCard | undefined, now: number | null) {
  if (!card || !card.lastReviewed) return "新词";
  if (now === null) return "—";
  const days = Math.round((now - new Date(card.due).getTime()) / 86400000);
  if (days > 0) return `+${days} 天`;
  if (days === 0) return "今天";
  return `${Math.abs(days)} 天后`;
}

/**
 * 时钟当作外部数据源订阅：快照被缓存，所以同一次渲染里「逾期几天」不会自己变；
 * 服务端快照为 null，避免注水时两边算出不同的天数。
 */
let clockSnapshot = 0;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    clockTimer = window.setInterval(() => {
      clockSnapshot = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 60000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

let clockTimer: number | null = null;

function readClock() {
  if (!clockSnapshot) clockSnapshot = Date.now();
  return clockSnapshot;
}

function useMountedClock() {
  return useSyncExternalStore(subscribeClock, readClock, () => null);
}

function Marks() {
  return <><i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" /></>;
}

function RuleLabel({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="rule-label">
      <span className="label">{children}</span>
      <span className="fill" />
      {note && <span className="note">{note}</span>}
    </div>
  );
}

function Meter({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <span className={strong ? "meter strong" : "meter"} aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </span>
  );
}

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className="metric"><span className="label">{label}</span><strong className="num">{value}</strong>{note && <small>{note}</small>}</div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><Info size={20} aria-hidden="true" /><strong>{title}</strong><p>{text}</p></div>;
}

export default function VocabApp() {
  const [view, setView] = useState<View>("today");
  const [index, setIndex] = useState<LexiconIndexEntry[]>([]);
  const [manifest, setManifest] = useState<LexiconManifest | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [cards, setCards] = useState<Map<string, StoredCard>>(new Map());
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [forcedType, setForcedType] = useState<QuestionType | null>(null);
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [objectiveResult, setObjectiveResult] = useState<boolean | null>(null);
  const [questionStartedAt, setQuestionStartedAt] = useState(() => Date.now());
  const [lastReview, setLastReview] = useState<{ event: ReviewEvent; entry: LexiconIndexEntry } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<LexiconIndexEntry | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<LexiconDetail | null>(null);
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<Scope[]>([]);
  const [bookFilter, setBookFilter] = useState<string[]>([]);
  const [unitFilter, setUnitFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [articleText, setArticleText] = useState("");
  const [articleMatches, setArticleMatches] = useState<LexiconIndexEntry[]>([]);
  const [detailOpenMobile, setDetailOpenMobile] = useState(false);
  const [listDetails, setListDetails] = useState<Map<string, LexiconDetail>>(new Map());
  const importRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([loadLexicon(), loadSettings(), getAll<StoredCard>("cards").catch(() => []), getAll<ReviewEvent>("events").catch(() => [])])
      .then(([lexicon, storedSettings, storedCards, storedEvents]) => {
        if (!active) return;
        setIndex(lexicon.index);
        setManifest(lexicon.manifest);
        setSettings(storedSettings);
        setCards(new Map(storedCards.map((card) => [card.id, card])));
        setEvents(storedEvents);
        setSelectedEntry(lexicon.index.find((entry) => entry.sources.some((source) => source.bookId === "HS-R1" && source.unit === "Unit 1")) || lexicon.index[0]);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "应用初始化失败"))
      .finally(() => setLoading(false));
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!selectedEntry) return;
    loadDetails([selectedEntry.id]).then((rows) => setSelectedDetail(rows[0] || null)).catch(() => undefined);
  }, [selectedEntry]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);

  const activeEvents = useMemo(() => {
    const undone = new Set(events.filter((event) => event.eventType === "undo" && event.targetEventId).map((event) => event.targetEventId));
    return events.filter((event) => event.eventType !== "undo" && !undone.has(event.eventId));
  }, [events]);

  const entryById = useMemo(() => new Map(index.map((entry) => [entry.id, entry])), [index]);

  const dueCards = useMemo(() => [...cards.values()].filter((card) => isDue(card)), [cards]);
  const backlog = dueCards.length;
  const newBudget = Math.max(0, Math.min(14, Math.floor((settings.dailyMinutes - Math.min(settings.dailyMinutes, backlog * 0.55)) / 1.5)));
  const todayNew = settings.mode === "review-only" || backlog > 28 ? 0 : newBudget;
  const todayReviews = Math.min(backlog, Math.max(8, Math.floor(settings.dailyMinutes / 0.6)));

  const eligibleNew = useMemo(
    () => index.filter((entry) => !cards.has(entry.id) && entry.sources.some((source) => settings.selectedBooks.includes(source.bookId)) && !entry.flags.properName),
    [index, cards, settings.selectedBooks],
  );

  /** 今日队列在开始学习之前就成形，队列预览与题型分布读的是同一份。 */
  const dailyQueue = useMemo(() => {
    const due = dueCards
      .slice()
      .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime())
      .map((card) => entryById.get(card.id))
      .filter(Boolean) as LexiconIndexEntry[];
    const queue = [...due.slice(0, todayReviews), ...eligibleNew.slice(0, todayNew)];
    if (queue.length) return queue;
    return index.filter((entry) => entry.scopes.includes("high-required") && !entry.flags.properName).slice(0, 12);
  }, [dueCards, entryById, todayReviews, eligibleNew, todayNew, index]);

  const queuePlan = useMemo(
    () => dailyQueue.map((entry, position) => ({ entry, type: pickQuestionType("daily", position, cards.get(entry.id)) })),
    [dailyQueue, cards],
  );

  const typeMix = useMemo(() => {
    const counts = new Map<string, number>();
    queuePlan.forEach(({ type }) => counts.set(typeShort(type), (counts.get(typeShort(type)) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [queuePlan]);

  const unitDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    dueCards.forEach((card) => {
      const entry = entryById.get(card.id);
      const source = entry?.sources[0];
      if (!source) return;
      const key = `${source.volume} · ${source.unit}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = rows.reduce((sum, [, count]) => sum + count, 0) || 1;
    return rows.map(([key, count]) => ({ key, count, share: count / total, minutes: Math.max(1, Math.round(count * 0.55)) }));
  }, [dueCards, entryById]);

  const forecast = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 14 }, (_, offset) => {
      const from = today.getTime() + offset * 86400000;
      const count = [...cards.values()].filter((card) => {
        const due = new Date(card.due).getTime();
        return offset === 0 ? due < from + 86400000 : due >= from && due < from + 86400000;
      }).length;
      return Math.round(count * 0.55);
    });
  }, [cards]);

  const skillScores = useMemo(() => {
    const reviewed = [...cards.values()].filter((card) => card.lastReviewed);
    return (Object.keys(skillLabels) as SkillName[]).map((skill) => ({
      skill,
      value: reviewed.length ? reviewed.reduce((sum, card) => sum + card.skills[skill], 0) / reviewed.length : 0,
    })).sort((a, b) => b.value - a.value);
  }, [cards]);

  const weakestSkill = skillScores.length ? skillScores[skillScores.length - 1].skill : "meaning";

  const streak = useMemo(() => {
    const days = new Set(activeEvents.map((event) => event.localDate));
    let count = 0;
    const cursor = new Date();
    if (!days.has(cursor.toLocaleDateString("sv-SE"))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(cursor.toLocaleDateString("sv-SE"))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }, [activeEvents]);

  const weekMarks = useMemo(() => {
    const days = new Set(activeEvents.map((event) => event.localDate));
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - offset));
      return { hit: days.has(date.toLocaleDateString("sv-SE")), today: offset === 6 };
    });
  }, [activeEvents]);

  const bookProgress = useMemo(() => {
    return settings.selectedBooks.slice(0, 3).map((bookId) => {
      const label = bookOptions.find(([id]) => id === bookId)?.[1] || bookId;
      const total = index.filter((entry) => entry.sources.some((source) => source.bookId === bookId)).length;
      const learned = index.filter((entry) => entry.sources.some((source) => source.bookId === bookId) && cards.has(entry.id)).length;
      return { label, share: total ? learned / total : 0 };
    });
  }, [settings.selectedBooks, index, cards]);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return index.filter((entry) => {
      const card = cards.get(entry.id);
      const queryHit = !normalized
        || `${entry.headword} ${entry.lookup} ${entry.chineseCore} ${entry.britishIpa}`.toLowerCase().includes(normalized)
        || entry.headword.toLowerCase().startsWith(normalized.replace(/[^a-z]/g, ""));
      const scopeHit = !scopeFilter.length || scopeFilter.some((scope) => entry.scopes.includes(scope));
      const bookHit = !bookFilter.length || entry.sources.some((source) => bookFilter.includes(source.bookId));
      const unitHit = !unitFilter.length || entry.sources.some((source) => unitFilter.includes(source.unit) && (!bookFilter.length || bookFilter.includes(source.bookId)));
      const statusHit = !statusFilter.length || statusFilter.some((value) => value === "favorite" ? card?.favorite : (card?.status || "unseen") === value);
      return queryHit && scopeHit && bookHit && unitHit && statusHit;
    });
  }, [index, query, scopeFilter, bookFilter, unitFilter, statusFilter, cards]);

  const scopeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    index.forEach((entry) => entry.scopes.forEach((scope) => counts.set(scope, (counts.get(scope) || 0) + 1)));
    return counts;
  }, [index]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    cards.forEach((card) => {
      counts.set(card.status, (counts.get(card.status) || 0) + 1);
      if (card.favorite) counts.set("favorite", (counts.get("favorite") || 0) + 1);
    });
    counts.set("unseen", index.length - cards.size);
    return counts;
  }, [cards, index.length]);

  const availableUnits = useMemo(
    () => [...new Set(index.flatMap((entry) => entry.sources.filter((source) => !bookFilter.length || bookFilter.includes(source.bookId)).map((source) => source.unit)))]
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(0, 12),
    [index, bookFilter],
  );

  const activeFilterCount = scopeFilter.length + bookFilter.length + unitFilter.length + statusFilter.length;

  const visibleEntries = useMemo(() => filteredEntries.slice(0, 160), [filteredEntries]);

  /** 列表里的「开放简义」来自详情分片；没取到就不显示，不用词头凑数。 */
  useEffect(() => {
    if (view !== "lexicon") return;
    const missing = visibleEntries.slice(0, 60).map((entry) => entry.id).filter((id) => !listDetails.has(id));
    if (!missing.length) return;
    let active = true;
    loadDetails(missing)
      .then((rows) => {
        if (!active || !rows.length) return;
        setListDetails((previous) => {
          const next = new Map(previous);
          rows.forEach((row) => next.set(row.id, row));
          return next;
        });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [view, visibleEntries, listDetails]);

  const currentEntry = session?.queue[session.position] || null;
  const currentDetail = currentEntry ? session?.details.get(currentEntry.id) : undefined;
  const currentCard = currentEntry ? cards.get(currentEntry.id) : undefined;
  const suggestedType = useMemo<QuestionType>(() => {
    if (!currentEntry || !session) return "meaning-recall";
    return forcedType || pickQuestionType(session.kind, session.position, currentCard);
  }, [currentEntry, currentCard, session, forcedType]);

  const question = useMemo<Question | null>(
    () => currentEntry ? buildQuestion(currentEntry, currentDetail, suggestedType, index) : null,
    [currentEntry, currentDetail, suggestedType, index],
  );

  const intervals = useMemo(() => previewIntervals(currentCard, settings.desiredRetention), [currentCard, settings.desiredRetention]);

  const resetQuestion = useCallback(() => {
    setAnswer("");
    setRevealed(false);
    setObjectiveResult(null);
    setQuestionStartedAt(Date.now());
  }, []);

  const startSession = useCallback(async (kind: SessionKind, custom?: LexiconIndexEntry[]) => {
    setLoading(true);
    try {
      const queue = custom?.length ? custom : kind === "diagnostic"
        ? [
          ...index.filter((entry) => entry.scopes.includes("middle-core") && !entry.flags.properName).slice(0, 12),
          ...index.filter((entry) => entry.scopes.includes("high-required") && !entry.flags.properName).slice(30, 54),
        ]
        : dailyQueue;
      if (!queue.length) {
        setToast("当前范围里没有可学的词条；先在「计划」里勾选教材册次。");
        return;
      }
      const details = await loadDetails(queue.map((entry) => entry.id));
      setSession({ kind, queue, details: new Map(details.map((detail) => [detail.id, detail])), position: 0, startedAt: Date.now(), reviewed: 0, correct: 0, streak: 0 });
      setSessionComplete(false);
      setForcedType(null);
      resetQuestion();
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "学习队列无法建立");
    } finally {
      setLoading(false);
    }
  }, [index, dailyQueue, resetQuestion]);

  const checkAnswer = useCallback(() => {
    if (!question) return;
    if (question.inputMode === "reveal") {
      setRevealed(true);
      return;
    }
    if (!answer.trim()) {
      setToast("先作答，再核对");
      return;
    }
    setObjectiveResult(gradeQuestion(question, answer));
    setRevealed(true);
  }, [question, answer]);

  const rate = useCallback(async (rating: 1 | 2 | 3 | 4) => {
    if (!session || !currentEntry || !question) return;
    const stored = cards.get(currentEntry.id) || newStoredCard(currentEntry.id, new Date(questionStartedAt));
    const correct = objectiveResult ?? rating > 1;
    const { after, event } = scheduleReview({
      stored,
      rating,
      retention: settings.desiredRetention,
      skill: question.skill,
      questionType: question.type,
      correct,
      responseMs: Date.now() - questionStartedAt,
      hints: 0,
      errorType: correct ? null : question.skill === "spelling" ? "spelling" : question.skill === "listening" ? "listening" : "recall",
    });
    await Promise.all([putOne("cards", after), putOne("events", { ...event, eventType: "review" as const })]);
    setCards((previous) => new Map(previous).set(after.id, after));
    setEvents((previous) => [...previous, { ...event, eventType: "review" }]);
    setLastReview({ event, entry: currentEntry });
    const nextStreak = correct ? session.streak + 1 : 0;
    if (session.position + 1 >= session.queue.length) {
      setSession((previous) => previous ? { ...previous, reviewed: previous.reviewed + 1, correct: previous.correct + (correct ? 1 : 0), streak: nextStreak, endedAt: Date.now() } : previous);
      setSessionComplete(true);
      if (session.kind === "diagnostic") setSettings(await saveSettings({ ...settings, diagnosisComplete: true }));
      return;
    }
    setSession((previous) => previous
      ? { ...previous, position: previous.position + 1, reviewed: previous.reviewed + 1, correct: previous.correct + (correct ? 1 : 0), streak: nextStreak }
      : previous);
    resetQuestion();
  }, [session, currentEntry, question, cards, questionStartedAt, objectiveResult, settings, resetQuestion]);

  const undoLast = useCallback(async () => {
    if (!lastReview) return;
    const { event, entry } = lastReview;
    const undoId = createLocalId();
    if (event.before) await putOne("cards", event.before);
    else await deleteOne("cards", event.cardId);
    const undoEvent: ReviewEvent = { ...event, eventType: "undo", eventId: undoId, targetEventId: event.eventId, timestampUtc: new Date().toISOString(), localDate: new Date().toLocaleDateString("sv-SE") };
    await putOne("events", undoEvent);
    setCards((previous) => {
      const next = new Map(previous);
      if (event.before) next.set(event.before.id, event.before);
      else next.delete(event.cardId);
      return next;
    });
    setEvents((previous) => [...previous, undoEvent]);
    setToast(`已撤销 ${entry.headword} 的上一次评分`);
    setSession((previous) => {
      if (!previous) return previous;
      const position = previous.queue.findIndex((candidate) => candidate.id === entry.id);
      return {
        ...previous,
        position: position >= 0 ? position : previous.position,
        reviewed: Math.max(0, previous.reviewed - 1),
        correct: Math.max(0, previous.correct - (event.correct ? 1 : 0)),
        streak: 0,
        endedAt: undefined,
      };
    });
    setSessionComplete(false);
    resetQuestion();
    setLastReview(null);
  }, [lastReview, resetQuestion]);

  const toggleFavorite = useCallback(async (entry: LexiconIndexEntry) => {
    const stored = cards.get(entry.id) || newStoredCard(entry.id);
    const next = { ...stored, favorite: !stored.favorite, updatedAt: new Date().toISOString() };
    await putOne("cards", next);
    setCards((previous) => new Map(previous).set(entry.id, next));
    setToast(next.favorite ? `已收藏 ${entry.headword}` : `已取消收藏 ${entry.headword}`);
  }, [cards]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (session && !sessionComplete) {
        if (event.code === "Space" && !typing) { event.preventDefault(); checkAnswer(); }
        if (event.key === "Enter" && !typing) checkAnswer();
        if (revealed && ["1", "2", "3", "4"].includes(event.key) && !typing) rate(Number(event.key) as 1 | 2 | 3 | 4);
        if (event.key === "Escape") { setSession(null); setSessionComplete(false); setView("today"); return; }
        if (typing) return;
        const key = event.key.toLowerCase();
        if (key === "r" && currentEntry) speakSystem(currentEntry.headword);
        if (key === "z") undoLast();
        if (key === "b" && currentEntry) toggleFavorite(currentEntry);
        if (key === "t") setForcedType((previous) => {
          const list = QUESTION_CATALOG.map((item) => item.id);
          const at = previous ? list.indexOf(previous) : -1;
          return list[(at + 1) % list.length];
        });
        return;
      }
      if (typing) return;
      if (event.key === "/") { event.preventDefault(); setView("lexicon"); window.setTimeout(() => searchRef.current?.focus(), 0); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setView("lexicon"); window.setTimeout(() => searchRef.current?.focus(), 0); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, sessionComplete, checkAnswer, revealed, rate, currentEntry, undoLast, toggleFavorite]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const updateSettings = async (patch: Partial<AppSettings>) => setSettings(await saveSettings({ ...settings, ...patch }));

  const saveNote = async (entry: LexiconIndexEntry, note: string) => {
    const stored = cards.get(entry.id) || newStoredCard(entry.id);
    const next = { ...stored, note, updatedAt: new Date().toISOString() };
    await putOne("cards", next);
    setCards((previous) => new Map(previous).set(entry.id, next));
    setToast("注释已保存在本机");
  };

  const handleBackup = async () => {
    try {
      const payload = await exportBackup();
      downloadFile(`词迹备份-${new Date().toLocaleDateString("sv-SE")}.json`, JSON.stringify(payload, null, 2), "application/json");
    } catch {
      setToast("浏览器未开放本地数据存储，暂时无法导出");
    }
  };

  const handleImport = async (file: File) => {
    try {
      await restoreBackup(JSON.parse(await file.text()));
      const [storedCards, storedEvents, storedSettings] = await Promise.all([getAll<StoredCard>("cards"), getAll<ReviewEvent>("events"), loadSettings()]);
      setCards(new Map(storedCards.map((card) => [card.id, card])));
      setEvents(storedEvents);
      setSettings(storedSettings);
      setToast("备份已验证并恢复");
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "文件损坏，未写入任何数据");
    }
  };

  const handleSync = async (direction: "push" | "pull") => {
    try {
      if (direction === "push") {
        const payload = await exportBackup();
        const baseRevision = Number(localStorage.getItem("pep-vocab-sync-revision") || 0);
        const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0.0", baseRevision, clientUpdatedAt: new Date().toISOString(), payload }) });
        const result = await response.json() as { revision?: number; error?: string };
        if (!response.ok) throw new Error(result.error === "revision-conflict" ? "云端已有更新：请先拉取，或导出本机备份后再处理冲突。" : result.error || "私有同步不可用");
        localStorage.setItem("pep-vocab-sync-revision", String(result.revision || 0));
        setToast("个人状态已同步；正式词库没有重复上传");
      } else {
        const response = await fetch("/api/sync");
        const result = await response.json() as { state?: { payload: string; revision: number } | null; error?: string };
        if (!response.ok) throw new Error(result.error || "私有同步不可用");
        if (!result.state) throw new Error("云端还没有个人状态备份");
        if (!window.confirm("将用私有同步状态替换本机个人数据。建议先导出本机 JSON 备份。继续？")) return;
        await restoreBackup(JSON.parse(result.state.payload));
        localStorage.setItem("pep-vocab-sync-revision", String(result.state.revision));
        const [storedCards, storedEvents, storedSettings] = await Promise.all([getAll<StoredCard>("cards"), getAll<ReviewEvent>("events"), loadSettings()]);
        setCards(new Map(storedCards.map((card) => [card.id, card]))); setEvents(storedEvents); setSettings(storedSettings);
        setToast("已从私有同步状态恢复");
      }
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "私有同步暂不可用；本地学习不受影响");
    }
  };

  const exportLexicon = (format: "csv" | "tsv") => {
    const separator = format === "csv" ? "," : "\t";
    const escape = (value: string) => format === "csv" ? `"${value.replaceAll('"', '""')}"` : value.replaceAll("\t", " ");
    const rows = filteredEntries.slice(0, 2000).map((entry) => [entry.id, entry.headword, entry.britishIpa, entry.chineseCore, entry.scopes.join("|"), fullSource(entry)].map((value) => escape(String(value))).join(separator));
    downloadFile(`词迹词表.${format}`, [["id", "word", "ipa_uk", "meaning_zh", "scopes", "source"].join(separator), ...rows].join("\n"), format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8");
  };

  const alignArticle = () => {
    const tokens = new Set((articleText.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []));
    setArticleMatches(index.filter((entry) => !entry.headword.includes(" ") && tokens.has(entry.lookup)).slice(0, 80));
  };

  const startFromSkill = (skill: SkillName) => {
    const candidates = index.filter((entry) => (cards.get(entry.id)?.skills[skill] ?? 0) < 0.5 && !entry.flags.properName).slice(0, 15);
    setForcedType(skillTypeMap[skill][0]);
    startSession("free", candidates);
  };

  if (loading && !index.length) {
    return (
      <main className="boot">
        <div className="mark">词迹</div>
        <div className="sub">PEP VOCABULARY</div>
        <div className="boot-line" />
        <p>正在校验词库版本与本地学习状态…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="boot">
        <div className="mark">词迹</div>
        <h1>暂时无法启动</h1>
        <p>{error}</p>
        <button className="btn primary" onClick={() => location.reload()}>重新加载</button>
      </main>
    );
  }

  /* 提示与朗读区在学习流里同样要出现，否则撤销、收藏都会静默。 */
  const feedback = (
    <>
      <div className="sr-live" aria-live="polite">{toast}</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );

  if (session) {
    return (
      <>
      <StudySession
        session={session}
        complete={sessionComplete}
        entry={currentEntry}
        detail={currentDetail}
        card={currentCard}
        question={question}
        intervals={intervals}
        budgetMinutes={settings.dailyMinutes}
        answer={answer}
        setAnswer={setAnswer}
        revealed={revealed}
        objectiveResult={objectiveResult}
        events={activeEvents}
        index={index}
        cards={cards}
        favorite={Boolean(currentEntry && cards.get(currentEntry.id)?.favorite)}
        onCheck={checkAnswer}
        onRate={rate}
        onExit={() => { setSession(null); setSessionComplete(false); setView("today"); }}
        onRestart={() => startSession(session.kind, session.queue)}
        onSpeak={() => currentEntry && speakSystem(currentEntry.headword)}
        onUndo={undoLast}
        canUndo={Boolean(lastReview)}
        onFavorite={() => currentEntry && toggleFavorite(currentEntry)}
        forcedType={forcedType}
        setForcedType={(type) => { setForcedType(type); resetQuestion(); }}
      />
      {feedback}
      </>
    );
  }

  const openSearch = () => { setView("lexicon"); window.setTimeout(() => searchRef.current?.focus(), 0); };
  const stampDate = new Date();
  const dateStamp = `${stampDate.getFullYear()} · ${String(stampDate.getMonth() + 1).padStart(2, "0")} · ${String(stampDate.getDate()).padStart(2, "0")} ${stampDate.toLocaleDateString("zh-CN", { weekday: "long" })}`;

  return (
    <div className="console">
      <aside className="rail">
        <button className="rail-brand" onClick={() => setView("today")} aria-label="词迹首页">
          <span className="mark">词迹</span>
          <span className="sub">PEP VOCABULARY</span>
        </button>
        {(["学习", "证据"] as const).map((group, groupIndex) => (
          <div key={group}>
            <div className={groupIndex ? "rail-group gap" : "rail-group"}>{group}</div>
            {navItems.filter((item) => item.group === group).map((item) => (
              <button key={item.id} className={view === item.id ? "rail-item on" : "rail-item"} onClick={() => setView(item.id)} aria-current={view === item.id ? "page" : undefined}>
                <item.icon size={17} strokeWidth={1.5} aria-hidden="true" />
                {item.label}
                {item.id === "today" && <span className="count">{dailyQueue.length}</span>}
                {item.id === "lexicon" && <span className="count">{index.length.toLocaleString()}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="rail-foot">
          <div className="inner">
            <div className="streak">
              <Flame size={15} strokeWidth={1.5} aria-hidden="true" />
              <span className="num">{streak}</span>
              <span>天连续</span>
            </div>
            <div className="streak-week" aria-label={`最近七天有 ${weekMarks.filter((mark) => mark.hit).length} 天学习记录`}>
              {weekMarks.map((mark, position) => <i key={position} className={mark.hit ? (mark.today ? "hit today" : "hit") : ""} />)}
            </div>
            <div className={online ? "rail-status" : "rail-status offline"}>
              <ShieldCheck size={13} strokeWidth={1.5} aria-hidden="true" />
              {online ? "本地已就绪 · 离线可复习" : "离线中 · 本地学习不受影响"}
            </div>
          </div>
        </div>
      </aside>

      <div className="work">
        <header className="workbar">
          <div className="workbar-brand">
            <span className="mark">词迹</span>
            <span className="stamp">{dateStamp} · {modeLabels[settings.mode]}</span>
          </div>
          <span className="stamp desk">{dateStamp}</span>
          <span className="sep" />
          <span className="mode">{modeLabels[settings.mode]} · {settings.dailyMinutes} 分钟预算 · 目标保持率 {settings.desiredRetention.toFixed(2)}</span>
          <div className="spacer" />
          <span className="workbar-streak">
            <Flame size={15} strokeWidth={1.5} aria-hidden="true" />
            <span className="num">{streak}</span>
            <small>天</small>
          </span>
          {lastReview && (
            <button className="undo" onClick={undoLast}>
              <Undo2 size={15} strokeWidth={1.5} aria-hidden="true" />撤销上一次<kbd>Z</kbd>
            </button>
          )}
          <button className="cmdk" onClick={openSearch}>
            <Search size={15} strokeWidth={1.5} aria-hidden="true" />
            <span className="cmdk-label">搜索词条或命令</span>
            <kbd>⌘</kbd><kbd>K</kbd>
          </button>
        </header>

        <div className="view">
          {view === "today" && (
            <TodayView
              settings={settings}
              queuePlan={queuePlan}
              queueTotal={dailyQueue.length}
              backlog={backlog}
              todayNew={todayNew}
              todayReviews={todayReviews}
              cards={cards}
              events={activeEvents}
              entryById={entryById}
              unitDistribution={unitDistribution}
              forecast={forecast}
              skillScores={skillScores}
              weakestSkill={weakestSkill}
              typeMix={typeMix}
              bookProgress={bookProgress}
              onStart={() => startSession("daily")}
              onDiagnostic={() => startSession("diagnostic")}
              onRetention={(value) => updateSettings({ desiredRetention: value })}
              onSkill={startFromSkill}
              onQuick={(skill, count) => {
                const candidates = index
                  .filter((entry) => !entry.flags.properName && (cards.get(entry.id)?.skills[skill] ?? 0) < 0.55)
                  .slice(0, count);
                setForcedType(skillTypeMap[skill][0]);
                startSession("free", candidates);
              }}
            />
          )}

          {view === "lexicon" && (
            <LexiconView
              entries={visibleEntries}
              matched={filteredEntries.length}
              listDetails={listDetails}
              total={index.length}
              selected={selectedEntry}
              detail={selectedDetail}
              cards={cards}
              query={query}
              setQuery={setQuery}
              searchRef={searchRef}
              scopeFilter={scopeFilter}
              setScopeFilter={setScopeFilter}
              bookFilter={bookFilter}
              setBookFilter={(next) => { setBookFilter(next); setUnitFilter([]); }}
              unitFilter={unitFilter}
              setUnitFilter={setUnitFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              availableUnits={availableUnits}
              scopeCounts={scopeCounts}
              statusCounts={statusCounts}
              activeFilterCount={activeFilterCount}
              onClear={() => { setScopeFilter([]); setBookFilter([]); setUnitFilter([]); setStatusFilter([]); }}
              detailOpenMobile={detailOpenMobile}
              onSelect={(entry) => { setSelectedEntry(entry); setDetailOpenMobile(true); }}
              onCloseDetail={() => setDetailOpenMobile(false)}
              onFavorite={toggleFavorite}
              onNote={saveNote}
              onStudy={(entry) => startSession("free", [entry, ...filteredEntries.filter((candidate) => candidate.id !== entry.id).slice(0, 9)])}
              onJump={(headword) => {
                const target = index.find((entry) => entry.headword.toLowerCase() === headword.toLowerCase());
                if (target) setSelectedEntry(target);
                else setToast(`正式词库里没有「${headword}」，不做补写`);
              }}
            />
          )}

          {view === "plan" && <PlanView settings={settings} backlog={backlog} cards={cards} forecast={forecast} onUpdate={updateSettings} />}

          {view === "analysis" && (
            <AnalysisView
              manifest={manifest}
              cards={cards}
              events={activeEvents}
              index={index}
              skillScores={skillScores}
              weakestSkill={weakestSkill}
              onTask={startFromSkill}
            />
          )}

          {view === "data" && (
            <DataView
              settings={settings}
              manifest={manifest}
              articleText={articleText}
              setArticleText={setArticleText}
              articleMatches={articleMatches}
              onAlign={alignArticle}
              onBackup={handleBackup}
              onImport={() => importRef.current?.click()}
              onSync={handleSync}
              onExportLexicon={exportLexicon}
              onUpdate={updateSettings}
              onClear={async () => {
                if (!window.confirm("将清空本机的学习记录、词单、注释和设置。此操作只能通过已有备份恢复。确定继续？")) return;
                await clearUserData();
                setCards(new Map()); setEvents([]); setSettings(defaultSettings); setToast("本机个人数据已清空");
              }}
            />
          )}
        </div>
      </div>

      <nav className="tabbar" aria-label="移动端主导航">
        {navItems.slice(0, 4).map((item) => (
          <button key={item.id} className={view === item.id ? "on" : ""} onClick={() => setView(item.id)} aria-current={view === item.id ? "page" : undefined}>
            <item.icon size={21} strokeWidth={1.5} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <input ref={importRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && handleImport(event.target.files[0])} />
      {feedback}
    </div>
  );
}

/* ── 今日 ──────────────────────────────────────────────── */

function TodayView({
  settings, queuePlan, queueTotal, backlog, todayNew, todayReviews, cards, events, entryById,
  unitDistribution, forecast, skillScores, weakestSkill, typeMix, bookProgress,
  onStart, onDiagnostic, onRetention, onSkill, onQuick,
}: {
  settings: AppSettings;
  queuePlan: Array<{ entry: LexiconIndexEntry; type: QuestionType }>;
  queueTotal: number; backlog: number; todayNew: number; todayReviews: number;
  cards: Map<string, StoredCard>; events: ReviewEvent[]; entryById: Map<string, LexiconIndexEntry>;
  unitDistribution: Array<{ key: string; count: number; share: number; minutes: number }>;
  forecast: number[]; skillScores: Array<{ skill: SkillName; value: number }>; weakestSkill: SkillName;
  typeMix: Array<[string, number]>; bookProgress: Array<{ label: string; share: number }>;
  onStart: () => void; onDiagnostic: () => void; onRetention: (value: number) => void;
  onSkill: (skill: SkillName) => void; onQuick: (skill: SkillName, count: number) => void;
}) {
  const now = useMountedClock();
  const estimated = Math.round(todayReviews * 0.55 + todayNew * 1.5);
  const busiest = Math.max(...forecast, 0);
  const peak = Math.max(busiest, 1);
  const peakDay = busiest > 0 ? forecast.indexOf(busiest) + 1 : 0;
  const recent = events.slice(-5).reverse();
  const shortTasks = skillScores.slice().reverse().slice(0, 3);

  return (
    <div className="today">
      <div className="today-main">
        {!settings.diagnosisComplete && (
          <div className="blueprint diagnostic">
            <Marks />
            <div className="stamp num">36</div>
            <div>
              <span className="label accent">可跳过的冷启动</span>
              <h2>用 36 词分层快筛，避免从头机械背。</h2>
              <p>12 个初中基础词 + 24 个高一教材词，交替检查识义、听辨与拼写；结果直接写进计划。</p>
            </div>
            <button className="btn" onClick={onDiagnostic}>开始诊断</button>
          </div>
        )}

        <div className="blueprint queue-head">
          <Marks />
          <div>
            <span className="label accent">今日队列</span>
            <div className="queue-figures">
              <div>
                <div className="big">{Math.min(backlog, todayReviews)}</div>
                <div className="cap">到期 / 薄弱</div>
              </div>
              <div className="plus">+</div>
              <div>
                <div className="big">{todayNew}</div>
                <div className="cap">新词上限</div>
              </div>
              <div className="vr" />
              <div>
                <div className="mid">{Math.min(settings.dailyMinutes, estimated)}<small> 分钟</small></div>
                <div className="cap">预计用时 · 预算 {settings.dailyMinutes}</div>
              </div>
            </div>
          </div>
          <button className="btn primary large" onClick={onStart}>
            <Play size={18} strokeWidth={1.5} aria-hidden="true" />开始今日学习<kbd>⏎</kbd>
          </button>
        </div>

        <div>
          <RuleLabel note="题型由六项能力自适应决定">
            队列预览 · 前 {Math.min(10, queuePlan.length)} 条 / 共 {queueTotal}
          </RuleLabel>
          {/* iPad 横屏是五列表格；手机收成两行一条，两套布局各自成立，不靠挤压同一张表。 */}
          <table className="grid-table queue-table" style={{ marginTop: 7 }}>
            <thead>
              <tr><th>词头</th><th>核心义</th><th>题型</th><th>教材位置</th><th>逾期</th></tr>
            </thead>
            <tbody>
              {queuePlan.slice(0, 10).map(({ entry, type }) => {
                const card = cards.get(entry.id);
                const overdue = overdueLabel(card, now);
                return (
                  <tr key={entry.id}>
                    <td className="word">{entry.headword}</td>
                    <td className="mean">{entry.chineseCore || "核心义待核"}</td>
                    <td><em className={card ? "tag skill" : "tag"}>{typeShort(type)}</em></td>
                    <td className="place">{shortSource(entry)}</td>
                    <td><span className="next-cell" data-none={overdue === "新词"}>{overdue}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="queue-list">
            {queuePlan.slice(0, 10).map(({ entry, type }) => {
              const card = cards.get(entry.id);
              const overdue = overdueLabel(card, now);
              return (
                <div className="queue-item" key={entry.id}>
                  <span className="lead"><b>{entry.headword}</b><span> · {entry.chineseCore || "核心义待核"}</span></span>
                  <span className="next-cell" data-none={overdue === "新词"}>{overdue}</span>
                  <span className="foot">
                    <em className={card ? "tag skill" : "tag"}>{typeShort(type)}</em>
                    {shortSource(entry)}
                  </span>
                </div>
              );
            })}
          </div>
          {!queuePlan.length && <EmptyState title="今天没有排进队列的词" text="到「计划」勾选正在学的教材册次，或降低目标保持率。" />}
        </div>

        <div>
          <RuleLabel>短任务 · 按薄弱能力</RuleLabel>
          <div className="task-grid" style={{ marginTop: 8 }}>
            {shortTasks.map(({ skill }, position) => (
              <button key={skill} className="task-card" onClick={() => onQuick(skill, [12, 15, 9][position])}>
                <strong>{skillLabels[skill]}专项 · {[12, 15, 9][position]} 词</strong>
                <kbd>{position + 1}</kbd>
                <small>从最低能力向量取词 · 约 {[10, 12, 7][position]} 分钟</small>
              </button>
            ))}
          </div>
        </div>

        <div className="split-2">
          <div>
            <RuleLabel note="词数 / 占比 / 预计">到期分布 · 按单元</RuleLabel>
            {unitDistribution.length ? (
              <table className="dist-table" style={{ marginTop: 6 }}>
                <tbody>
                  {unitDistribution.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className="n">{row.count}</td>
                      <td className="bar"><Meter value={row.share} /></td>
                      <td>{row.minutes} 分</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="skill-note">还没有到期词；分布会在第一轮复习之后出现。</p>}
          </div>
          <div>
            <RuleLabel note="评分 / 反应">最近答题</RuleLabel>
            <div style={{ marginTop: 6 }}>
              {recent.length ? recent.map((event) => (
                <div className="recent-row" key={event.eventId}>
                  <span>
                    <b>{entryById.get(event.cardId)?.headword || "已删除词条"}</b>
                    <span className="kind"> · {skillLabels[event.skill]}</span>
                  </span>
                  <span className="rating" data-hard={event.rating === 1}>{ratingLabels[event.rating]}</span>
                  <span className="ms">{(event.responseMs / 1000).toFixed(1)}s</span>
                </div>
              )) : <p className="skill-note">还没有答题记录。第一轮之后这里会显示评分与反应时间。</p>}
            </div>
          </div>
        </div>
      </div>

      <aside className="gauges" aria-label="今日仪表">
        <div>
          <span className="label">保持率与负担</span>
          <div className="retention-value">
            <span className="num">{settings.desiredRetention.toFixed(2)}</span>
            <p>FSRS v6 主状态<br />每词一个，跨册共用</p>
          </div>
          <div className="retention-track">
            <i style={{ width: `${(settings.desiredRetention - 0.8) / 0.17 * 100}%` }} />
            <b style={{ left: `${(settings.desiredRetention - 0.8) / 0.17 * 100}%` }} />
          </div>
          <div className="retention-scale"><span>0.80 省力</span><span>当前</span><span>0.97 不建议</span></div>
          <input
            className="retention-range" type="range" min="0.8" max="0.97" step="0.01"
            value={settings.desiredRetention} aria-label="目标保持率"
            onChange={(event) => onRetention(Number(event.target.value))}
          />
        </div>

        <div>
          <div className="gauge-head"><span className="label">未来 14 天负担</span><span className="note label" style={{ letterSpacing: 0 }}>分钟 / 日</span></div>
          <div className="bar-chart" role="img" aria-label="未来十四天预计复习负担">
            {forecast.map((value, offset) => (
              <i key={offset} className={offset > 4 ? "far" : ""} style={{ height: `${Math.max(3, value / peak * 100)}%` }} />
            ))}
          </div>
          <div className="chart-axis"><span>今天</span><span>{peakDay ? `峰值 ${busiest} 分钟 · 第 ${peakDay} 天` : "两周内暂无排期"}</span></div>
        </div>

        <div>
          <div className="gauge-head"><span className="label">六项能力</span><span className="note label" style={{ letterSpacing: 0 }}>0–100</span></div>
          <div className="skill-list">
            {skillScores.map(({ skill, value }) => (
              <button key={skill} className={skill === weakestSkill ? "skill-row weakest" : "skill-row"} onClick={() => onSkill(skill)}>
                <span>{skillLabels[skill]}</span>
                <Meter value={value} strong={skill === weakestSkill} />
                <span className="num">{Math.round(value * 100)}</span>
              </button>
            ))}
          </div>
          <p className="skill-note">最弱是{skillLabels[weakestSkill]}；只在某能力持续偏弱时才生成短期专项。</p>
        </div>

        <div>
          <RuleLabel note={`${queueTotal} 题`}>今日题型分布</RuleLabel>
          <div className="mix-list" style={{ marginTop: 8 }}>
            {typeMix.map(([label, count]) => (
              <div className="mix-row" key={label}>
                <span>{label}</span>
                <Meter value={count / Math.max(1, queueTotal)} />
                <span>{count} 题</span>
              </div>
            ))}
          </div>
        </div>

        <div className="progress-block">
          <span className="label">教材进度</span>
          <div className="progress-list">
            {bookProgress.map((row) => (
              <div className="progress-row" key={row.label}>
                <span>{row.label}</span>
                <span className="num">{Math.round(row.share * 100)}%</span>
                <Meter value={row.share} />
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

/* ── 词库 ──────────────────────────────────────────────── */

function LexiconView({
  entries, matched, listDetails, total, selected, detail, cards, query, setQuery, searchRef,
  scopeFilter, setScopeFilter, bookFilter, setBookFilter, unitFilter, setUnitFilter, statusFilter, setStatusFilter,
  availableUnits, scopeCounts, statusCounts, activeFilterCount, onClear,
  detailOpenMobile, onSelect, onCloseDetail, onFavorite, onNote, onStudy, onJump,
}: {
  entries: LexiconIndexEntry[]; matched: number; listDetails: Map<string, LexiconDetail>;
  total: number; selected: LexiconIndexEntry | null; detail: LexiconDetail | null;
  cards: Map<string, StoredCard>; query: string; setQuery: (value: string) => void; searchRef: React.RefObject<HTMLInputElement | null>;
  scopeFilter: Scope[]; setScopeFilter: (value: Scope[]) => void;
  bookFilter: string[]; setBookFilter: (value: string[]) => void;
  unitFilter: string[]; setUnitFilter: (value: string[]) => void;
  statusFilter: string[]; setStatusFilter: (value: string[]) => void;
  availableUnits: string[]; scopeCounts: Map<string, number>; statusCounts: Map<string, number>;
  activeFilterCount: number; onClear: () => void; detailOpenMobile: boolean;
  onSelect: (entry: LexiconIndexEntry) => void; onCloseDetail: () => void;
  onFavorite: (entry: LexiconIndexEntry) => void; onNote: (entry: LexiconIndexEntry, note: string) => void;
  onStudy: (entry: LexiconIndexEntry) => void; onJump: (headword: string) => void;
}) {
  const toggle = <T extends string>(list: T[], value: T, set: (next: T[]) => void) =>
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const card = selected ? cards.get(selected.id) : undefined;

  return (
    <div className="lexicon">
      <div className="lex-search">
        <Search size={17} strokeWidth={1.5} aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="agri" aria-label="搜索词库" spellCheck={false} />
        <span className="hint">词头 / 中文 / IPA 都能搜</span>
        <div className="tally">
          <span className="num">{matched.toLocaleString()}</span>
          <span>/ {total.toLocaleString()} 条命中</span>
          <kbd>/</kbd>
        </div>
      </div>

      <div className="chip-bar">
        <div className="chip-line">
          <span className="label">范围</span>
          {scopeOrder.map((scope) => {
            const count = scopeCounts.get(scope) || 0;
            return (
              <button
                key={scope}
                className={`chip${scopeFilter.includes(scope) ? " on" : ""}${count ? "" : " empty"}`}
                onClick={() => toggle(scopeFilter, scope, setScopeFilter)}
                aria-pressed={scopeFilter.includes(scope)}
              >
                {scopeLabels[scope]}<span className="count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="chip-line">
          <span className="label">册 / 单元</span>
          {bookOptions.slice(0, 7).map(([id, label]) => (
            <button key={id} className={bookFilter.includes(id) ? "chip on" : "chip"} onClick={() => toggle(bookFilter, id, setBookFilter)} aria-pressed={bookFilter.includes(id)}>{label}</button>
          ))}
          <span className="vr" />
          {availableUnits.slice(0, 5).map((unit) => (
            <button key={unit} className={unitFilter.includes(unit) ? "chip on" : "chip"} onClick={() => toggle(unitFilter, unit, setUnitFilter)} aria-pressed={unitFilter.includes(unit)}>{unit}</button>
          ))}
          <span className="vr" />
          <span className="label" style={{ width: "auto" }}>状态</span>
          {statusOptions.map(([value, label]) => (
            <button
              key={value}
              className={`chip${statusFilter.includes(value) ? (value === "weak" ? " outline-on" : " on") : ""}`}
              onClick={() => toggle(statusFilter, value, setStatusFilter)}
              aria-pressed={statusFilter.includes(value)}
            >
              {label}<span className="count">{statusCounts.get(value) || 0}</span>
            </button>
          ))}
          {activeFilterCount > 0 && (
            <button className="chip-clear" onClick={onClear}>已选 {activeFilterCount} 个条件 · 清空<kbd>⌫</kbd></button>
          )}
        </div>
      </div>

      <div className="lex-body">
        <div className="lex-list">
          <div className="lex-cols">
            <span>词头 / IPA</span><span>词性 · 核心义 · 开放简义</span><span>教材位置</span><span>状态</span><span>下次</span>
          </div>
          {entries.map((entry) => {
            const stored = cards.get(entry.id);
            const next = dueLabel(stored);
            const openGloss = listDetails.get(entry.id)?.englishCore;
            return (
              <button key={entry.id} className={selected?.id === entry.id ? "lex-row on" : "lex-row"} onClick={() => onSelect(entry)}>
                <span className="head">
                  <b>{entry.headword}</b>
                  <span className="ipa">{entry.britishIpa ? `/${entry.britishIpa}/` : "—"}</span>
                </span>
                <span className="gloss">
                  <span className="zh">
                    {entry.partsOfSpeech.length > 0 && <em className="pos">{entry.partsOfSpeech.join(" / ")}.</em>}
                    {entry.chineseCore || "核心义待核"}
                  </span>
                  {openGloss && <span className="en">{openGloss}</span>}
                </span>
                <span className="place">{shortSource(entry)}</span>
                <em className="tag" data-status={stored?.status || "unseen"}>{stored?.favorite ? "已收藏" : statusLabel(stored?.status)}</em>
                <span className="next-cell" data-none={next === "—"}>{next}</span>
              </button>
            );
          })}
          {matched > entries.length && (
            <p className="lex-more">还有 {(matched - entries.length).toLocaleString()} 条命中未显示 ·「一行一个词」按索引序，继续输入关键词可精确定位</p>
          )}
          {!entries.length && <EmptyState title="没有符合条件的词条" text="移除一个筛选芯片，或换用更短的搜索词。" />}
        </div>

        <aside className={detailOpenMobile ? "lex-detail" : "lex-detail hidden-m"} aria-label="词条详情">
          {selected ? (
            <>
              <div className="detail-top">
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  <span className="tag" data-status="mastered">{selected.tier} 层</span>
                  <span className="tag">{selected.sources[0]?.status || "verified-primary"}</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className={card?.favorite ? "icon-btn on" : "icon-btn"} onClick={() => onFavorite(selected)} aria-label="收藏词条" title="收藏 (B)">
                    <Bookmark size={15} strokeWidth={1.5} fill={card?.favorite ? "currentColor" : "none"} />
                  </button>
                  <button className="icon-btn" onClick={() => speakSystem(selected.headword)} aria-label="系统语音朗读" title="发音 (R)">
                    <Volume2 size={15} strokeWidth={1.5} />
                  </button>
                  <button className="icon-btn" onClick={onCloseDetail} aria-label="收起详情"><X size={15} strokeWidth={1.5} /></button>
                </div>
              </div>

              <h2 className="detail-word">{selected.headword}</h2>
              <div className="detail-ipa">
                <span>BrE /{selected.britishIpa || "—"}/</span>
                <small>系统语音，不是真人录音</small>
              </div>
              {selected.americanIpa && selected.americanIpa !== selected.britishIpa && (
                <div className="detail-ipa" style={{ marginTop: 6 }}><span>NAmE /{selected.americanIpa}/</span></div>
              )}

              <div className="detail-grammar">
                {selected.partsOfSpeech.length ? selected.partsOfSpeech.map((pos) => <span key={pos}>{pos}.</span>) : <span>词性待字段级核验</span>}
                {detail?.grammar?.countability && <span>{detail.grammar.countability}</span>}
                {detail?.grammar?.transitivity && <span>{detail.grammar.transitivity}</span>}
              </div>

              <div className="detail-block">
                <span className="label">核心义</span>
                <p className="zh">{selected.chineseCore || "核心义待核"}</p>
                {detail?.englishCore && <p className="en">{detail.englishCore}</p>}
              </div>

              {detail?.relations.family.length ? (
                <div className="detail-block">
                  <span className="label">词族 · 点击即跳转</span>
                  <div className="link-chips">
                    {detail.relations.family.slice(0, 6).map((word) => (
                      <button key={word} className="link-chip" onClick={() => onJump(word)}>{word}</button>
                    ))}
                    {detail.relations.confusables.slice(0, 3).map((word) => (
                      <button key={word} className="link-chip muted" onClick={() => onJump(word)}>{word}</button>
                    ))}
                  </div>
                </div>
              ) : null}

              {detail?.openExample && (
                <div className="detail-block">
                  <span className="label">开放语料例句</span>
                  <p className="en" style={{ fontSize: 15 }}>
                    {detail.openExample}
                    <span className="credit">Open English WordNet · CC BY 4.0</span>
                  </p>
                </div>
              )}

              <div className="detail-block">
                <span className="label">来源位置 · {selected.sources.length} 处</span>
                <div className="source-list">
                  {selected.sources.slice(0, 5).map((source, position) => (
                    <div key={`${source.bookId}-${source.unit}-${position}`} className={position ? "secondary" : ""}>
                      <ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />
                      {source.volume} · {source.unit}{source.printedPage ? ` · p.${source.printedPage}` : ""}
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-block">
                <span className="label">你的记录</span>
                <div className="stat-grid">
                  <div><span className="num">{card?.lastReviewed ? Math.round(Number(card.fsrs.reps || 0)) : 0}</span><span>复习次数</span></div>
                  <div><span className="num">{retrievabilityOf(card).toFixed(2)}</span><span>可提取性</span></div>
                  <div><span className="num">{dueLabel(card)}</span><span>下次</span></div>
                  <div><span className="num">{Math.round(Number(card?.fsrs.lapses || 0))}<small> 次</small></span><span>遗忘</span></div>
                </div>
              </div>

              <label className="note-field">
                <span className="label">我的注释</span>
                <textarea
                  key={selected.id}
                  defaultValue={card?.note || ""}
                  onBlur={(event) => onNote(selected, event.target.value)}
                  placeholder="记录易错点或自己的例句；离开输入框即保存"
                />
              </label>

              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="btn primary" style={{ flex: 1 }} onClick={() => onStudy(selected)}>从这个词开始练习<kbd>⏎</kbd></button>
              </div>
              <p className="rights-note">未公开复制教材整段；详情只保留词表事实、页码定位和许可明确的开放字段。</p>
            </>
          ) : <EmptyState title="选择一个词条" text="右侧会显示音标、词族、来源位置和学习状态。" />}
        </aside>
      </div>
    </div>
  );
}

/* ── 计划 ──────────────────────────────────────────────── */

function PlanView({ settings, backlog, cards, forecast, onUpdate }: {
  settings: AppSettings; backlog: number; cards: Map<string, StoredCard>; forecast: number[];
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const estimated = workloadEstimate(settings.dailyMinutes, settings.desiredRetention);
  const activeCount = [...cards.values()].filter((card) => card.status !== "paused").length;
  const peak = Math.max(...forecast, 1);
  const modes: Array<[AppSettings["mode"], string]> = [
    ["normal", "到期与薄弱优先，再放入少量新词"],
    ["unit", "只从已选教材进度取新词"],
    ["review-only", "不加入任何新词"],
    ["exam", "在时间预算内提高目标词权重"],
    ["browse", "不自动创建学习任务"],
  ];

  return (
    <div className="sheet">
      <RuleLabel note="LOAD, NOT STREAKS">计划 · 让计划服从时间预算</RuleLabel>
      <div className="sheet-grid">
        <section className="panel">
          <div className="panel-head">
            <div><span className="label">每日上限</span><h2>时间预算</h2></div>
            <CalendarDays size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="range-row"><span className="num">{settings.dailyMinutes}</span><span>分钟 / 天</span></div>
          <input type="range" min="10" max="60" step="5" value={settings.dailyMinutes} aria-label="每日学习分钟数" onChange={(event) => onUpdate({ dailyMinutes: Number(event.target.value) })} />
          <div className="range-scale"><span>10</span><span>30</span><span>60</span></div>
          <div className="range-row" style={{ marginTop: 6 }}><span className="num">{settings.desiredRetention.toFixed(2)}</span><span>FSRS 目标保持率</span></div>
          <input type="range" min="0.8" max="0.97" step="0.01" value={settings.desiredRetention} aria-label="目标保持率" onChange={(event) => onUpdate({ desiredRetention: Number(event.target.value) })} />
          <div className="impact">
            <span>预计每日复习时间</span>
            <span className="num">{estimated} 分钟</span>
            <small>估算值；保持率越接近 0.97，负担上升越快，而记住的边际收益越小。</small>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><span className="label">学习模式</span><h2>当前：{modeLabels[settings.mode]}</h2></div>
            <SlidersHorizontal size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="mode-list">
            {modes.map(([id, text]) => (
              <button key={id} className={settings.mode === id ? "on" : ""} onClick={() => onUpdate({ mode: id })} aria-pressed={settings.mode === id}>
                <span className="mode-mark" />
                <span><strong>{modeLabels[id]}</strong><small>{text}</small></span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel span">
          <div className="panel-head">
            <div><span className="label">实际教材进度</span><h2>按学校进度选范围，不混淆七册完整词库。</h2></div>
            <BookOpen size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="book-grid">
            {bookOptions.map(([id, label]) => {
              const checked = settings.selectedBooks.includes(id);
              return (
                <label key={id} className={checked ? "on" : ""}>
                  <input type="checkbox" checked={checked} onChange={() => onUpdate({ selectedBooks: checked ? settings.selectedBooks.filter((book) => book !== id) : [...settings.selectedBooks, id] })} />
                  <span className="box"><Check size={12} strokeWidth={2} /></span>
                  <strong>{label}</strong>
                  <small>{id.startsWith("HS-R") ? "高中必修" : id.startsWith("HS-S") ? "选择性必修" : "初中核心"}</small>
                </label>
              );
            })}
          </div>
        </section>

        <section className="panel span">
          <div className="panel-head">
            <div><span className="label">未来 14 天</span><h2>负担预测</h2></div>
            <span className="label">分钟 / 日</span>
          </div>
          <p>{backlog ? `目前 ${backlog} 个到期词；计划会压低新词，直到积压回落。` : "当前没有逾期；仍保留缓冲，不把空闲全部塞成新词。"}</p>
          <div className="tall-chart" role="img" aria-label="未来十四天复习负担条形图">
            {forecast.map((value, position) => (
              <span key={position}>
                <i style={{ height: `${Math.max(2, value / peak * 100)}%` }} />
                <small>{position % 2 === 0 ? position + 1 : ""}</small>
              </span>
            ))}
          </div>
          <div className="metric-strip">
            <Metric label="主学习状态" value={activeCount} note="跨词书不复制" />
            <Metric label="预计峰值" value={`${Math.max(peak, estimated)} 分钟`} note="可由保持率调整" />
            <Metric label="当前积压" value={backlog} note="到期未复习" />
            <Metric label="已选册次" value={settings.selectedBooks.length} note="决定新词来源" />
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── 分析 ──────────────────────────────────────────────── */

function AnalysisView({ manifest, cards, events, index, skillScores, weakestSkill, onTask }: {
  manifest: LexiconManifest | null; cards: Map<string, StoredCard>; events: ReviewEvent[]; index: LexiconIndexEntry[];
  skillScores: Array<{ skill: SkillName; value: number }>; weakestSkill: SkillName; onTask: (skill: SkillName) => void;
}) {
  const reviewedCards = [...cards.values()].filter((card) => card.lastReviewed);
  const today = new Date();
  const days = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (29 - offset));
    const key = date.toLocaleDateString("sv-SE");
    return events.filter((event) => event.localDate === key).length;
  });
  const maxDay = Math.max(1, ...days);
  const middleLearned = index.filter((entry) => entry.scopes.includes("middle-core") && cards.has(entry.id)).length;
  const highLearned = index.filter((entry) => entry.scopes.some((scope) => scope.startsWith("high")) && cards.has(entry.id)).length;
  const highTotal = (manifest?.highRequiredEntries || 0) + (manifest?.highSelectiveEntries || 0);
  const weak = reviewedCards.filter((card) => card.status === "weak");
  const retention = reviewedCards.length ? reviewedCards.reduce((sum, card) => sum + retrievabilityOf(card), 0) / reviewedCards.length : 0;

  return (
    <div className="sheet">
      <RuleLabel note="EVIDENCE OVER ACTIVITY">分析 · 看能力缺口，不看热闹</RuleLabel>
      <div className="metric-strip">
        <Metric label="学习中词条" value={reviewedCards.length} note={`薄弱 ${weak.length}`} />
        <Metric label="30 天复习" value={days.reduce((sum, value) => sum + value, 0)} note="含新学与复习" />
        <Metric label="估计保持率" value={`${Math.round(retention * 100)}%`} note="基于当前稳定度" />
        <Metric label="主要薄弱项" value={skillLabels[weakestSkill]} note="推荐专项 10–15 分钟" />
      </div>

      <div className="sheet-grid wide">
        <section className="panel">
          <div className="panel-head"><div><span className="label">30 DAYS</span><h2>复习趋势</h2></div><span className="label">事件 / 日</span></div>
          <div className="trend-chart" role="img" aria-label="三十天复习事件趋势">
            {days.map((value, position) => <i key={position} style={{ height: `${Math.max(2, value / maxDay * 100)}%` }} title={`${value} 次`} />)}
          </div>
          <div className="chart-axis"><span>30 天前</span><span>今天</span></div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">SIX CAPABILITIES</span><h2>六项能力</h2></div><span className="label">0–100</span></div>
          <div>
            {skillScores.map(({ skill, value }) => (
              <button key={skill} className="skill-button" onClick={() => onTask(skill)}>
                <span>{skillLabels[skill]}</span>
                <Meter value={value} strong={skill === weakestSkill} />
                <span className="num">{Math.round(value * 100)}</span>
                <ChevronRight size={15} strokeWidth={1.5} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">COVERAGE</span><h2>初高中独立覆盖</h2></div></div>
          <div className="coverage-row">
            <div className="top"><strong>初中核心</strong><small>{middleLearned} / {manifest?.middleEntries || 0}</small></div>
            <Meter value={middleLearned / Math.max(1, manifest?.middleEntries || 1)} />
          </div>
          <div className="coverage-row">
            <div className="top"><strong>高中七册</strong><small>{highLearned} / {highTotal}</small></div>
            <Meter value={highLearned / Math.max(1, highTotal)} />
          </div>
          <p>同一个词跨册出现时只保留一个调度状态，来源位置会全部保留。</p>
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">NEXT ACTION</span><h2>推荐短任务</h2></div></div>
          <div className="range-row"><span className="num">{skillLabels[weakestSkill]}</span><span>约 12 分钟</span></div>
          <p>
            {weakestSkill === "spelling" ? "近期「眼熟但写不出」比例最高，先做中文到英文输入。"
              : weakestSkill === "listening" ? "听辨稳定度最低，先做系统语音听写；真人音频未获授权时不冒充。"
                : "从最低能力向量取词，避免为每个词创建六份长期任务。"}
          </p>
          <button className="btn" onClick={() => onTask(weakestSkill)}>开始专项</button>
        </section>
      </div>
    </div>
  );
}

/* ── 数据 ──────────────────────────────────────────────── */

function DataView({ settings, manifest, articleText, setArticleText, articleMatches, onAlign, onBackup, onImport, onSync, onExportLexicon, onUpdate, onClear }: {
  settings: AppSettings; manifest: LexiconManifest | null; articleText: string; setArticleText: (value: string) => void;
  articleMatches: LexiconIndexEntry[]; onAlign: () => void; onBackup: () => void; onImport: () => void;
  onSync: (direction: "push" | "pull") => void; onExportLexicon: (format: "csv" | "tsv") => void;
  onUpdate: (patch: Partial<AppSettings>) => void; onClear: () => void;
}) {
  return (
    <div className="sheet">
      <RuleLabel note="LOCAL FIRST">数据 · 你的学习数据，先在本机</RuleLabel>
      <div className="sheet-grid">
        <section className="panel">
          <div className="panel-head"><div><span className="label">个人数据</span><h2>备份、恢复与私有同步</h2></div><Database size={20} strokeWidth={1.5} aria-hidden="true" /></div>
          <p>包含卡片主状态、六项能力、追加式事件、词单、注释和设置。</p>
          <div className="btn-row">
            <button className="btn primary" onClick={onBackup}><Download size={16} strokeWidth={1.5} aria-hidden="true" />导出 JSON</button>
            <button className="btn" onClick={onImport}><Upload size={16} strokeWidth={1.5} aria-hidden="true" />恢复备份</button>
            <button className="btn" onClick={() => onSync("push")}>同步本机</button>
            <button className="btn" onClick={() => onSync("pull")}>从私有同步恢复</button>
          </div>
          <small>当前 schema：1.0.0。冲突不会静默覆盖；本地预览没有站点身份时安全降级。</small>
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">词库与 Anki</span><h2>CSV / TSV 导出</h2></div><FileText size={20} strokeWidth={1.5} aria-hidden="true" /></div>
          <p>导出当前正式词库筛选结果；TSV 可映射到 Anki 的 Word、IPA、Meaning、Source 字段。</p>
          <div className="btn-row">
            <button className="btn" onClick={() => onExportLexicon("csv")}>导出 CSV</button>
            <button className="btn" onClick={() => onExportLexicon("tsv")}>Anki TSV</button>
          </div>
          <small>发布版本 {manifest?.version || "—"}；不会导出教材 PDF 或未授权音频。</small>
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">文章生词对齐</span><h2>粘贴一段英文</h2></div><Search size={20} strokeWidth={1.5} aria-hidden="true" /></div>
          <p>只在本机分词，并与正式索引对齐；文本不会上传。</p>
          <textarea className="article-area" value={articleText} onChange={(event) => setArticleText(event.target.value)} placeholder="Paste an English article here…" aria-label="待对齐的英文文章" />
          <div className="btn-row"><button className="btn primary" onClick={onAlign}>提取并对齐</button></div>
          {articleMatches.length > 0 && (
            <div className="match-list">
              {articleMatches.map((entry) => <span key={entry.id}><strong>{entry.headword}</strong>{entry.chineseCore}</span>)}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><div><span className="label">阅读与增强</span><h2>应用设置</h2></div><SlidersHorizontal size={20} strokeWidth={1.5} aria-hidden="true" /></div>
          <label className="field-row">
            <span>阅读方案</span>
            <select value={settings.theme} onChange={(event) => onUpdate({ theme: event.target.value as AppSettings["theme"] })}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="switch-row">
            <span><strong>AI 增强层</strong><small>解释、造句检查与易混小课；AI 关闭时核心学习完全不依赖它</small></span>
            <input type="checkbox" checked={settings.aiEnabled} onChange={(event) => onUpdate({ aiEnabled: event.target.checked })} />
            <span className="switch" />
          </label>
          {settings.aiEnabled && (
            <p className="inline-warning"><Sparkles size={15} strokeWidth={1.5} aria-hidden="true" />当前部署未配置模型密钥，增强层会安全降级到本地检查。</p>
          )}
          <button className="btn danger" onClick={onClear} style={{ marginTop: "auto" }}>
            <RotateCcw size={15} strokeWidth={1.5} aria-hidden="true" />清空本机个人数据
          </button>
        </section>
      </div>

      <section className="privacy-strip">
        <ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" />
        <div>
          <strong>数据边界</strong>
          <p>词库作为版本化静态资源；学习状态进入 IndexedDB。私有同步启用时只上传个人状态，不复制整份词库。系统 TTS 不等于真人音频。</p>
        </div>
      </section>
    </div>
  );
}

/* ── 学习流（常深色） ──────────────────────────────────── */

function StudySession({
  session, complete, entry, detail, card, question, intervals, budgetMinutes, answer, setAnswer, revealed, objectiveResult,
  events, index, cards, favorite, onCheck, onRate, onExit, onRestart, onSpeak, onUndo, canUndo, onFavorite, forcedType, setForcedType,
}: {
  session: SessionState; complete: boolean; entry: LexiconIndexEntry | null; detail?: LexiconDetail; card?: StoredCard;
  question: Question | null; intervals: Record<1 | 2 | 3 | 4, string>; budgetMinutes: number;
  answer: string; setAnswer: (value: string) => void; revealed: boolean; objectiveResult: boolean | null;
  events: ReviewEvent[]; index: LexiconIndexEntry[]; cards: Map<string, StoredCard>; favorite: boolean;
  onCheck: () => void; onRate: (rating: 1 | 2 | 3 | 4) => void; onExit: () => void; onRestart: () => void;
  onSpeak: () => void; onUndo: () => void; canUndo: boolean; onFavorite: () => void;
  forcedType: QuestionType | null; setForcedType: (type: QuestionType | null) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const now = useMountedClock();
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Date.now() - session.startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [session.startedAt]);

  const cardEvents = useMemo(() => entry ? events.filter((event) => event.cardId === entry.id) : [], [events, entry]);
  const mistakes = cardEvents.filter((event) => !event.correct);
  const neighbors = useMemo(() => {
    if (!entry) return [];
    const source = entry.sources[0];
    if (!source) return [];
    return index
      .filter((candidate) => candidate.id !== entry.id && candidate.sources.some((item) => item.bookId === source.bookId && item.unit === source.unit))
      .slice(0, 4);
  }, [entry, index]);

  if (complete) {
    const minutes = ((session.endedAt || session.startedAt) - session.startedAt) / 60000;
    return (
      <main className="session night">
        <div className="complete">
          <div className="complete-inner">
            <span className="label accent">SESSION COMPLETE</span>
            <h1>{session.kind === "diagnostic" ? "诊断样本已写入计划。" : "这一轮已经收好。"}</h1>
            <p>没有额外塞入新词；下一次仍从到期与薄弱项开始。</p>
            <div className="metric-strip" style={{ margin: "28px 0" }}>
              <Metric label="完成" value={session.reviewed} note="主学习状态更新" />
              <Metric label="正确" value={`${Math.round(session.correct / Math.max(1, session.reviewed) * 100)}%`} note="客观题 + 翻卡" />
              <Metric label="用时" value={formatMinutes(minutes)} note="含思考与反馈" />
              <Metric label="最长连对" value={session.streak} note="仅供参考，不计入排程" />
            </div>
            <div className="btn-row">
              {canUndo && <button className="btn" onClick={onUndo}><Undo2 size={16} strokeWidth={1.5} aria-hidden="true" />撤销最后一次评分</button>}
              <button className="btn" onClick={onRestart}><RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />再练一轮</button>
              <button className="btn primary" onClick={onExit}>返回今日</button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!entry || !question) return null;
  const sentenceCheck = question.type === "sentence-output" && answer ? localSentenceCheck(answer, entry.headword) : null;
  const progress = (session.position + (revealed ? 0.5 : 0)) / session.queue.length;
  const overdue = overdueLabel(card, now);

  return (
    <main className="session night">
      <header className="session-bar">
        <button className="session-close" onClick={onExit} aria-label="退出并保存"><X size={16} strokeWidth={1.5} /></button>
        <span className="label">{session.kind === "diagnostic" ? "分层诊断" : session.kind === "free" ? "专项练习" : "今日学习"}</span>
        <div className="session-progress">
          <span className="session-track" aria-hidden="true">
            <i style={{ width: `${progress * 100}%` }} />
            <b style={{ left: `${progress * 100}%` }} />
          </span>
          <span className="session-count">{session.position + 1}<small> / {session.queue.length}</small></span>
        </div>
        <span className="session-clock">{formatClock(elapsed)}</span>
        <span className="session-budget">/ {budgetMinutes} 分钟</span>
        <span className="session-streak"><Zap size={14} strokeWidth={1.5} aria-hidden="true" /><span className="num">连对 {session.streak}</span></span>
      </header>

      <div className="session-body">
        {/* 手机以手势为主：左滑忘记 / 右滑记得 / 上滑轻松；翻卡之后才接受手势。 */}
        <div
          className="stage"
          onTouchStart={(event) => {
            const touch = event.changedTouches[0];
            swipeFrom.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          }}
          onTouchEnd={(event) => {
            const start = swipeFrom.current;
            const touch = event.changedTouches[0];
            swipeFrom.current = null;
            if (!start || !touch || !revealed) return;
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onRate(dx < 0 ? 1 : 3);
            else if (dy < -60 && Math.abs(dy) > Math.abs(dx)) onRate(4);
          }}
        >
          <div className="stage-meta">
            <span className="label accent">{question.label}</span>
            <span className="vr" />
            <select value={forcedType || "adaptive"} onChange={(event) => setForcedType(event.target.value === "adaptive" ? null : event.target.value as QuestionType)} aria-label="选择题型">
              <option value="adaptive">自适应题型</option>
              {QUESTION_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <span className="src">
              <span className="src-full">{fullSource(entry)} · {entry.sources[0]?.status || "verified-primary"}</span>
              <span className="src-short">{shortSource(entry)}</span>
            </span>
          </div>

          <div className="stage-core">
            <span className="label">第 {session.position + 1} 题 · {overdue}</span>
            <h1 className={question.prompt.length > 24 ? "stage-prompt long" : "stage-prompt"}>{question.prompt}</h1>

            <div className="stage-sub">
              {entry.britishIpa && <span className="ipa">BrE /{entry.britishIpa}/</span>}
              <button className="speak-btn" onClick={onSpeak}>
                <Volume2 size={14} strokeWidth={1.5} aria-hidden="true" />系统语音<kbd>R</kbd>
              </button>
              <span className="meta">
                {entry.partsOfSpeech.join(" / ") || "词性待核"} · 出现于 {entry.sources.length} 处
              </span>
            </div>

            {question.support && !revealed && <p className="stage-gloss" style={{ marginTop: 12 }}>{question.support}</p>}

            {!revealed && question.inputMode === "text" && (
              <div className="answer-field">
                <input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onCheck()} placeholder="输入答案" spellCheck={false} autoComplete="off" aria-label="作答" />
              </div>
            )}
            {!revealed && question.inputMode === "textarea" && (
              <div className="answer-field">
                <textarea autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="先独立作答；核心功能不依赖 AI" aria-label="作答" />
                {sentenceCheck && <p className={sentenceCheck.hasTarget && sentenceCheck.completeEnough ? "local-check pass" : "local-check"}>{sentenceCheck.message}</p>}
              </div>
            )}
            {!revealed && question.inputMode === "choice" && (
              <div className="choice-grid">
                {question.choices.map((choice) => (
                  <button key={choice} className={answer === choice ? "on" : ""} onClick={() => setAnswer(choice)}>
                    <span className="choice-mark" />{choice}
                  </button>
                ))}
              </div>
            )}

            {revealed && (
              <>
                <div className="stage-rule" />
                {objectiveResult !== null && (
                  <div className={objectiveResult ? "verdict ok" : "verdict no"}>
                    {objectiveResult ? <Check size={15} strokeWidth={2} /> : <X size={15} strokeWidth={2} />}
                    {objectiveResult ? "客观判定正确" : "客观判定未命中"}
                  </div>
                )}
                <span className="label" style={{ display: "block", marginTop: 10 }}>已翻卡 · 答案</span>
                <div className="stage-answer">{question.answer}</div>
                {detail?.englishCore && (
                  <p className="stage-gloss">
                    {detail.englishCore}
                    <span className="credit">Open English WordNet · CC BY 4.0</span>
                  </p>
                )}
                <div className="stage-split">
                  {detail?.openExample && (
                    <div>
                      <span className="label">开放语料例句</span>
                      <p>{detail.openExample}</p>
                    </div>
                  )}
                  <div>
                    <span className="label">你上次错在哪</span>
                    <p className="zh">
                      {mistakes.length
                        ? `${mistakes.slice(-3).map((event) => `${skillLabels[event.skill]}${event.errorType ? ` · ${event.errorType}` : ""}`).join("；")}。共 ${mistakes.length} 次未命中。`
                        : "还没有记录到错误；这里只显示真实的答题事件，不做推测。"}
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="stage-foot">
            {!revealed ? (
              <div className="check-row">
                <button className="btn primary large" onClick={onCheck}>
                  {question.inputMode === "reveal" ? "显示答案" : "核对答案"}<kbd>Space</kbd>
                </button>
                <span className="session-budget">先自己回忆，再翻卡；翻卡后才出现评分。</span>
              </div>
            ) : (
              <>
                <div className="ask">
                  <span>这次回忆有多费力？</span>
                  <small>评分只更新这一个 FSRS 主状态；键帽上写的是评分后的下一次间隔</small>
                </div>
                <div className="swipe-hint">
                  <span><MoveHorizontal size={14} strokeWidth={1.5} aria-hidden="true" />左滑忘记 · 右滑记得 · 上滑轻松</span>
                  <span>点按也可</span>
                </div>
                <div className="rate-grid">
                  {([1, 2, 3, 4] as const).map((rating) => (
                    <button key={rating} className={rating === 3 ? "rate-btn best" : "rate-btn"} onClick={() => onRate(rating)}>
                      <strong>{ratingLabels[rating]}</strong>
                      <kbd>{rating}</kbd>
                      <span className="iv">{intervals[rating]}{rating === 3 ? " · 推荐" : ""}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="keyline">
              <span><kbd>Space</kbd>翻卡</span>
              <span><kbd>1</kbd>–<kbd>4</kbd>评分并进入下一题</span>
              <span><kbd>R</kbd>发音</span>
              <span><kbd>Z</kbd>撤销</span>
              <span><kbd>T</kbd>换题型</span>
              <span><kbd>Esc</kbd>退出并保存</span>
              <span className="tail">正误反馈同时使用文字与图标</span>
            </div>
          </div>
        </div>

        <aside className="context" aria-label="上下文">
          <span className="label">上下文 · 常驻</span>

          {detail?.relations.family.length ? (
            <div>
              <h3>词族</h3>
              <div className="context-chips">
                <span className="self">{entry.headword}</span>
                {detail.relations.family.slice(0, 5).map((word) => <span key={word}>{word}</span>)}
              </div>
            </div>
          ) : null}

          {detail?.relations.phrases.length ? (
            <div>
              <h3>已审核搭配</h3>
              <div className="context-list">
                {detail.relations.phrases.slice(0, 3).map((phrase) => (
                  <div key={phrase}>{phrase}<span className="credit">来自正式词库短语条目</span></div>
                ))}
              </div>
            </div>
          ) : null}

          {detail?.relations.confusables.length ? (
            <div>
              <h3>易混</h3>
              <div className="context-chips">
                {detail.relations.confusables.slice(0, 4).map((word) => <span key={word}>{word}</span>)}
              </div>
            </div>
          ) : null}

          {neighbors.length > 0 && (
            <div>
              <h3>同单元邻词</h3>
              <div>
                {neighbors.map((neighbor) => (
                  <div className="neighbor" key={neighbor.id}>
                    <span>{neighbor.headword}<span className="zh"> {neighbor.chineseCore}</span></span>
                    <span className="when">{dueLabel(cards.get(neighbor.id))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="context-foot">
            <span className="label">这个词的记录</span>
            <div className="context-stats" style={{ marginTop: 10 }}>
              <div><span className="num">{cardEvents.length}</span><span>复习次数</span></div>
              <div>
                <span className="num">
                  {cardEvents.length ? (cardEvents.reduce((sum, event) => sum + event.responseMs, 0) / cardEvents.length / 1000).toFixed(1) : "0.0"}
                  <small> 秒</small>
                </span>
                <span>平均反应</span>
              </div>
              <div><span className="num">{retrievabilityOf(card).toFixed(2)}</span><span>当前可提取性</span></div>
              <div><span className="num">{mistakes.length}</span><span>未命中</span></div>
            </div>
            <button className="btn block" style={{ marginTop: 12 }} onClick={onFavorite}>
              <Bookmark size={14} strokeWidth={1.5} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
              {favorite ? "已收藏" : "收藏并加注释"}<kbd>B</kbd>
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
