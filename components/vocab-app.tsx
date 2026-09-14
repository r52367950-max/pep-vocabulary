"use client";

import {
  BarChart3,
  BookOpen,
  CalendarRange,
  Check,
  ChevronRight,
  Clock3,
  CloudOff,
  Database,
  Download,
  FileText,
  Info,
  Play,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { delimitedCell } from "@/lib/export";
import ConsoleLexicon from "@/components/console-lexicon";
import ConsoleSettings from "@/components/console-settings";
import ConsoleStudySession from "@/components/console-study-session";
import { loadDetails, loadLexicon, matchesLexiconQuery, speakSystem, type LexiconDetail, type LexiconIndexEntry, type LexiconManifest, type Scope } from "@/lib/lexicon";
import { buildQuestion, gradeQuestion, QUESTION_CATALOG, type Question, type QuestionType } from "@/lib/questions";
import { forecastDueLoad, isDue, newStoredCard, scheduleReview, workloadEstimate } from "@/lib/scheduler";
import {
  clearUserData,
  createLocalId,
  defaultSettings,
  commitReview,
  exportBackup,
  getAll,
  loadSettings,
  updateCardMetadata,
  restoreBackup,
  saveSettings,
  USER_DATA_SCHEMA_VERSION,
  type AppSettings,
  type ReviewEvent,
  type SkillName,
  type StoredCard,
} from "@/lib/storage";

type View = "today" | "lexicon" | "plan" | "analysis" | "data" | "settings";
type SessionKind = "daily" | "diagnostic" | "free";
export type SessionState = {
  kind: SessionKind;
  queue: LexiconIndexEntry[];
  details: Map<string, LexiconDetail>;
  position: number;
  startedAt: number;
  reviewed: number;
  correct: number;
  endedAt?: number;
};

const bookOptions = [
  ["HS-R1", "必修一"], ["HS-R2", "必修二"], ["HS-R3", "必修三"],
  ["HS-S1", "选必一"], ["HS-S2", "选必二"], ["HS-S3", "选必三"], ["HS-S4", "选必四"],
  ["JH-7A", "七上"], ["JH-7B", "七下"], ["JH-8A", "八上"], ["JH-8B", "八下"], ["JH-9", "九年级"],
] as const;

const skillLabels: Record<SkillName, string> = {
  meaning: "识义", listening: "听辨", spelling: "拼写", context: "语境", collocation: "搭配", output: "输出",
};

const navItems: Array<{ id: View; label: string; icon: typeof BookOpen }> = [
  { id: "today", label: "今日", icon: Target },
  { id: "lexicon", label: "词库", icon: BookOpen },
  { id: "plan", label: "计划", icon: CalendarRange },
  { id: "analysis", label: "分析", icon: BarChart3 },
  { id: "data", label: "数据", icon: Database },
  { id: "settings", label: "设置", icon: Settings2 },
];

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatMinutes(value: number) {
  return value < 60 ? `${Math.round(value)} 分钟` : `${Math.floor(value / 60)} 小时 ${Math.round(value % 60)} 分`;
}

function calculateStreak(events: ReviewEvent[]) {
  if (!events.length) return 0;
  const days = new Set(events.map((event) => event.localDate));
  const cursor = new Date();
  let streak = 0;
  while (days.has(cursor.toLocaleDateString("sv-SE"))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function sourceLine(entry: LexiconIndexEntry) {
  const source = entry.sources[0];
  if (!source) return "来源待核";
  return `${source.volume} · ${source.unit}${source.printedPage ? ` · p.${source.printedPage}` : ""}`;
}

function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress-wrap" aria-label={label || `完成 ${Math.round(value * 100)}%`}>
      <span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
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
  const [hints, setHints] = useState(0);
  const [questionStartedAt, setQuestionStartedAt] = useState(() => Date.now());
  const [lastReview, setLastReview] = useState<{ event: ReviewEvent; entry: LexiconIndexEntry } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<LexiconIndexEntry | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<LexiconDetail | null>(null);
  const [visibleDetails, setVisibleDetails] = useState<Map<string, LexiconDetail>>(new Map());
  const [query, setQuery] = useState("");
  const [scopeFilters, setScopeFilters] = useState<Scope[]>([]);
  const [bookFilter, setBookFilter] = useState("all");
  const [unitFilter, setUnitFilter] = useState("all");
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [articleText, setArticleText] = useState("");
  const [articleMatches, setArticleMatches] = useState<LexiconIndexEntry[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const reviewBusy = useRef(false);
  const lastSubmitted = useRef<string | null>(null);
  const settingsWrites = useRef(Promise.resolve());
  const sessionStarting = useRef(false);
  const [savingReview, setSavingReview] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([loadLexicon(), loadSettings(), getAll<StoredCard>("cards"), getAll<ReviewEvent>("events")])
      .then(([lexicon, storedSettings, storedCards, storedEvents]) => {
        if (!active) return;
        setIndex(lexicon.index);
        setManifest(lexicon.manifest);
        setSettings(storedSettings);
        setCards(new Map(storedCards.map((card) => [card.id, card])));
        setEvents(storedEvents);
        setSelectedEntry(lexicon.index.find((entry) => entry.sources.some((source) => source.bookId === "HS-R1" && source.unit === "Unit 1")) || lexicon.index[0]);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "应用初始化失败"); })
      .finally(() => { if (active) setLoading(false); });
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
    let active = true;
    if (selectedEntry) loadDetails([selectedEntry.id]).then((rows) => { if (active) setSelectedDetail(rows[0] || null); }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedEntry]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (session) return;
      const target = event.target as HTMLElement;
      const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" || (!editing && event.key === "/")) {
        event.preventDefault();
        setView("lexicon");
        window.setTimeout(() => document.querySelector<HTMLInputElement>("#lexicon-search")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session]);

  const activeEvents = useMemo(() => {
    const undone = new Set(events.filter((event) => event.eventType === "undo" && event.targetEventId).map((event) => event.targetEventId));
    return events.filter((event) => event.eventType !== "undo" && !undone.has(event.eventId));
  }, [events]);

  const dueCards = useMemo(() => [...cards.values()].filter((card) => isDue(card)).sort((a, b) => {
    if (a.status === "weak" && b.status !== "weak") return -1;
    if (b.status === "weak" && a.status !== "weak") return 1;
    return a.due.localeCompare(b.due);
  }), [cards]);
  const backlog = dueCards.length;
  const newBudget = Math.max(0, Math.min(14, Math.floor((settings.dailyMinutes - Math.min(settings.dailyMinutes, backlog * 0.55)) / 1.5)));
  const todayNew = backlog > 28 || ["review-only", "browse"].includes(settings.mode) ? 0 : newBudget;
  const todayReviews = Math.min(backlog, Math.max(8, Math.floor(settings.dailyMinutes / 0.6)));

  const eligibleNew = useMemo(() => index
    .filter((entry) => (!cards.has(entry.id) || cards.get(entry.id)?.status === "unseen") && entry.sources.some((source) => settings.selectedBooks.includes(source.bookId)) && !entry.flags.properName)
    .sort((a, b) => Number(b.flags.highValue) - Number(a.flags.highValue) || a.tier.localeCompare(b.tier) || a.headword.localeCompare(b.headword)), [index, cards, settings.selectedBooks]);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return index.filter((entry) => {
      const card = cards.get(entry.id);
      const queryHit = matchesLexiconQuery(entry, normalized);
      const scopeHit = !scopeFilters.length || scopeFilters.some((scope) => entry.scopes.includes(scope));
      const bookHit = bookFilter === "all" || entry.sources.some((source) => source.bookId === bookFilter);
      const unitHit = unitFilter === "all" || entry.sources.some((source) => source.unit === unitFilter && (bookFilter === "all" || source.bookId === bookFilter));
      const statusHit = !statusFilters.length || statusFilters.some((status) => status === "favorite" ? card?.favorite : (card?.status || "unseen") === status);
      return queryHit && scopeHit && bookHit && unitHit && statusHit;
    });
  }, [index, query, scopeFilters, bookFilter, unitFilter, statusFilters, cards]);

  useEffect(() => {
    if (view !== "lexicon") return;
    const ids = filteredEntries.slice(0, 90).map((entry) => entry.id).filter((id) => !visibleDetails.has(id));
    if (!ids.length) return;
    let active = true;
    loadDetails(ids).then((rows) => {
      if (!active) return;
      setVisibleDetails((previous) => {
        const next = new Map(previous);
        rows.forEach((row) => next.set(row.id, row));
        return next;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [view, filteredEntries, visibleDetails]);

  const availableUnits = useMemo(() => [...new Set(index.flatMap((entry) => entry.sources.filter((source) => bookFilter === "all" || source.bookId === bookFilter).map((source) => source.unit)))].sort(), [index, bookFilter]);
  const indexById = useMemo(() => new Map(index.map((entry) => [entry.id, entry])), [index]);
  const dailyQueuePreview = useMemo(() => {
    const due = dueCards.map((card) => indexById.get(card.id)).filter(Boolean) as LexiconIndexEntry[];
    return [...due.slice(0, todayReviews), ...eligibleNew.slice(0, todayNew)];
  }, [dueCards, indexById, todayReviews, eligibleNew, todayNew]);
  const workload = useMemo(() => forecastDueLoad(cards.values(), 14), [cards]);

  const currentEntry = session?.queue[session.position] || null;
  const currentDetail = currentEntry ? session?.details.get(currentEntry.id) : undefined;
  const currentCard = currentEntry ? cards.get(currentEntry.id) : undefined;
  const suggestedType = useMemo<QuestionType>(() => {
    if (!currentEntry || !session) return "meaning-recall";
    if (forcedType) return forcedType;
    if (session.kind === "diagnostic") return (["meaning-recall", "listening-choice", "spelling"] as QuestionType[])[session.position % 3];
    const skills = currentCard?.skills;
    if (skills) {
      const weakest = (Object.entries(skills) as Array<[SkillName, number]>).sort((a, b) => a[1] - b[1])[0]?.[0];
      const mapping: Record<SkillName, QuestionType[]> = {
        meaning: ["meaning-recall", "natural-expression"], listening: ["listening-choice", "dictation"], spelling: ["spelling", "word-form"],
        context: ["context-choice", "confusable"], collocation: ["collocation-gap", "family-conversion"], output: ["sentence-output", "paragraph-retell"],
      };
      if (weakest) return mapping[weakest][session.position % mapping[weakest].length];
    }
    return QUESTION_CATALOG[session.position % QUESTION_CATALOG.length].id;
  }, [currentEntry, currentCard, session, forcedType]);

  const question = useMemo<Question | null>(() => currentEntry ? buildQuestion(currentEntry, currentDetail, suggestedType, index) : null, [currentEntry, currentDetail, suggestedType, index]);

  const resetQuestion = useCallback(() => {
    setAnswer("");
    setRevealed(false);
    setObjectiveResult(null);
    setHints(0);
    setQuestionStartedAt(Date.now());
  }, []);

  const startSession = useCallback(async (kind: SessionKind, custom?: LexiconIndexEntry[], questionType: QuestionType | null = null) => {
    if (sessionStarting.current || reviewBusy.current) return;
    sessionStarting.current = true;
    setLoading(true);
    try {
      let queue = custom || [];
      if (!queue.length && kind === "diagnostic") {
        const middle = index.filter((entry) => entry.scopes.includes("middle-core") && !entry.flags.properName).slice(0, 12);
        const high = index.filter((entry) => entry.scopes.includes("high-required") && !entry.flags.properName).slice(30, 54);
        queue = [...middle, ...high];
      } else if (!queue.length) {
        queue = dailyQueuePreview;
        if (!queue.length) { setToast("当前计划没有待学词；可从词库选择自由练习。"); return; }
      }
      const details = await loadDetails(queue.map((entry) => entry.id));
      setSession({ kind, queue, details: new Map(details.map((detail) => [detail.id, detail])), position: 0, startedAt: Date.now(), reviewed: 0, correct: 0 });
      setSessionComplete(false);
      setForcedType(questionType);
      setLastReview(null);
      lastSubmitted.current = null;
      resetQuestion();
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "学习队列无法建立");
    } finally {
      sessionStarting.current = false;
      setLoading(false);
    }
  }, [index, dailyQueuePreview, resetQuestion]);

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
    const result = gradeQuestion(question, answer);
    setObjectiveResult(result);
    setRevealed(true);
  }, [question, answer]);

  const rate = useCallback(async (rating: 1 | 2 | 3 | 4) => {
    if (!session || !currentEntry || !question || !revealed || sessionComplete || reviewBusy.current) return;
    const submission = `${session.startedAt}:${session.position}:${question.type}`;
    if (lastSubmitted.current === submission) return;
    reviewBusy.current = true;
    setSavingReview(true);
    try {
      const stored = cards.get(currentEntry.id) || null;
      const correct = objectiveResult ?? rating > 1;
      const { after, event } = scheduleReview({
        stored,
        cardId: currentEntry.id,
        rating,
        retention: settings.desiredRetention,
        skill: question.skill,
        questionType: question.type,
        correct,
        responseMs: Date.now() - questionStartedAt,
        hints,
        errorType: correct ? null : question.skill === "spelling" ? "spelling" : question.skill === "listening" ? "listening" : "recall",
        prompt: question.prompt,
        answerGiven: answer.trim() || null,
        expectedAnswer: question.answer,
        sourceLine: sourceLine(currentEntry),
      });
      await commitReview({ ...event, eventType: "review" });
      lastSubmitted.current = submission;
      setCards((previous) => new Map(previous).set(after.id, after));
      setEvents((previous) => [...previous, { ...event, eventType: "review" }]);
      setLastReview({ event, entry: currentEntry });
      if (session.position + 1 >= session.queue.length) {
        setSession((previous) => previous ? { ...previous, reviewed: previous.reviewed + 1, correct: previous.correct + (correct ? 1 : 0), endedAt: Date.now() } : previous);
        setSessionComplete(true);
        if (session.kind === "diagnostic") {
          const nextSettings = await saveSettings({ ...settings, diagnosisComplete: true });
          setSettings(nextSettings);
        }
        return;
      }
      setSession((previous) => previous ? { ...previous, position: previous.position + 1, reviewed: previous.reviewed + 1, correct: previous.correct + (correct ? 1 : 0) } : previous);
      resetQuestion();
    } catch { setToast("保存未完成，请重试；若其他页面已修改此词，请重新加载。已提交的评分不会重复保存。"); }
    finally { reviewBusy.current = false; setSavingReview(false); }
  }, [session, sessionComplete, revealed, currentEntry, question, cards, questionStartedAt, objectiveResult, settings, hints, answer, resetQuestion]);

  const undoLast = useCallback(async () => {
    if (!lastReview || reviewBusy.current) return;
    reviewBusy.current = true;
    setSavingReview(true);
    try {
      const { event, entry } = lastReview;
      const undoId = createLocalId();
      const undoEvent: ReviewEvent = { ...event, eventType: "undo", eventId: undoId, targetEventId: event.eventId, timestampUtc: new Date().toISOString(), localDate: new Date().toLocaleDateString("sv-SE") };
      await commitReview(undoEvent);
      lastSubmitted.current = null;
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
          endedAt: undefined,
        };
      });
      setSessionComplete(false);
      resetQuestion();
      setLastReview(null);
    } catch { setToast("撤销未完成；数据可能已在其他页面更新，请重新加载后检查。"); }
    finally { reviewBusy.current = false; setSavingReview(false); }
  }, [lastReview, resetQuestion]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!session || sessionComplete || reviewBusy.current || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") { event.preventDefault(); checkAnswer(); }
      if (revealed && ["1", "2", "3", "4"].includes(event.key)) rate(Number(event.key) as 1 | 2 | 3 | 4);
      if (event.key.toLowerCase() === "r" && currentEntry) speakSystem(currentEntry.headword);
      if (event.key.toLowerCase() === "z") undoLast();
      if (event.key.toLowerCase() === "t") { resetQuestion(); setForcedType((current) => {
        const index = current ? QUESTION_CATALOG.findIndex((item) => item.id === current) : -1;
        return QUESTION_CATALOG[(index + 1) % QUESTION_CATALOG.length].id;
      }); }
      if (event.key === "Escape") { setSession(null); setSessionComplete(false); setView("today"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, sessionComplete, checkAnswer, revealed, rate, currentEntry, undoLast, resetQuestion]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const updateSettings = async (patch: Partial<AppSettings>) => {
    settingsWrites.current = settingsWrites.current.then(async () => {
      const next = await saveSettings({ ...await loadSettings(), ...patch });
      setSettings(next);
    }).catch(() => { setToast("设置保存失败，请重试。"); });
    await settingsWrites.current;
  };

  const toggleFavorite = async (entry: LexiconIndexEntry) => {
    try {
      const next = await updateCardMetadata(newStoredCard(entry.id), { toggleFavorite: true });
      setCards((previous) => new Map(previous).set(entry.id, next));
    } catch { setToast("收藏保存失败，请重试。"); }
  };

  const saveNote = async (entry: LexiconIndexEntry, note: string) => {
    try {
      const next = await updateCardMetadata(newStoredCard(entry.id), { note });
      setCards((previous) => new Map(previous).set(entry.id, next));
      setToast("注释已保存在本机");
    } catch { setToast("注释保存失败，请重试。"); }
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
      if (file.size > 25_000_000) throw new Error("备份文件超过 25 MB 限制。");
      const payload = JSON.parse(await file.text());
      if (!window.confirm("导入将替换本机学习数据。请确认已有备份，是否继续？")) return;
      await restoreBackup(payload);
      localStorage.removeItem("pep-vocab-sync-revision");
      setLastReview(null);
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
        const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: USER_DATA_SCHEMA_VERSION, baseRevision, clientUpdatedAt: new Date().toISOString(), payload }) });
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
        setLastReview(null);
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
    const escape = (value: string) => delimitedCell(value, format);
    const rows = filteredEntries.map((entry) => [entry.id, entry.headword, entry.britishIpa, entry.chineseCore, entry.scopes.join("|"), sourceLine(entry)].map((value) => escape(String(value))).join(separator));
    downloadFile(`词迹词表.${format}`, [["id", "word", "ipa_uk", "meaning_zh", "scopes", "source"].join(separator), ...rows].join("\n"), format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8");
  };

  const alignArticle = () => {
    const tokens = new Set((articleText.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []));
    const matches = index.filter((entry) => !entry.headword.includes(" ") && tokens.has(entry.lookup)).slice(0, 80);
    setArticleMatches(matches);
  };

  if (loading && !index.length) {
    return <main className="loading-screen"><div className="wordmark">词迹</div><div className="loading-line" /><p>正在校验词库版本与本地学习状态…</p></main>;
  }

  if (error) {
    return <main className="loading-screen"><CloudOff size={32} /><h1>暂时无法启动</h1><p>{error}</p><button className="primary-button" onClick={() => location.reload()}>重新加载</button></main>;
  }

  if (session) {
    return (
      <><ConsoleStudySession
        saving={savingReview}
        session={session}
        complete={sessionComplete}
        entry={currentEntry}
        detail={currentDetail}
        card={currentCard}
        events={activeEvents}
        index={index}
        desiredRetention={settings.desiredRetention}
        dailyMinutes={settings.dailyMinutes}
        question={question}
        answer={answer}
        setAnswer={setAnswer}
        revealed={revealed}
        objectiveResult={objectiveResult}
        hints={hints}
        setHints={setHints}
        onCheck={checkAnswer}
        onRate={rate}
        onExit={() => { if (reviewBusy.current) return; setSession(null); setSessionComplete(false); setView("today"); }}
        onRestart={() => startSession(session.kind, session.queue)}
        onSpeak={() => currentEntry && speakSystem(currentEntry.headword)}
        onUndo={undoLast}
        canUndo={Boolean(lastReview)}
        forcedType={forcedType}
        setForcedType={(type) => { if (reviewBusy.current) return; setForcedType(type); resetQuestion(); }}
      />{toast && <div className="toast" role="status">{toast}</div>}</>
    );
  }

  const streak = calculateStreak(activeEvents);
  const modeLabel = ({ normal: "普通学习", unit: "单元同步", "review-only": "只复习", exam: "考前强化", browse: "自由浏览" } as const)[settings.mode];
  return (
    <div className="console-app">
      <aside className="console-sidebar">
        <button className="console-brand" onClick={() => setView("today")} aria-label="词迹首页"><strong>词迹</strong><span>VOCAB CONSOLE</span></button>
        <nav className="console-nav" aria-label="主导航">
          <span className="nav-group-label">WORKSPACE</span>
          {navItems.slice(0, 3).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={16} /><span>{item.label}</span><em>{item.id === "today" ? backlog : item.id === "lexicon" ? index.length.toLocaleString() : ""}</em></button>)}
          <span className="nav-group-label evidence">EVIDENCE</span>
          {navItems.slice(3, 5).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={16} /><span>{item.label}</span><em>{item.id === "analysis" ? activeEvents.length : ""}</em></button>)}
          <span className="nav-group-label evidence">SYSTEM</span>
          {navItems.slice(5).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={16}/><span>{item.label}</span><em/></button>)}
        </nav>
        <div className="sidebar-foot"><div className="streak-line"><Target size={16} /><strong>{streak}</strong><span>连续学习天</span></div><div className="streak-cells" aria-label={`连续学习 ${streak} 天`}>{Array.from({ length: 14 }, (_, position) => <i key={position} className={position >= 14 - Math.min(streak, 14) ? "filled" : ""} />)}</div><div className="local-line">{online ? <ShieldCheck size={13} /> : <CloudOff size={13} />}<span>{online ? "本地数据已就绪" : "当前离线 · 核心可用"}</span></div></div>
      </aside>
      <section className="console-workspace">
        <header className="console-toolbar">
          <div className="toolbar-context"><span>{new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" })}</span><i/><strong>{modeLabel}</strong><span>{settings.dailyMinutes} 分钟 / 日</span><span>保持率 {Math.round(settings.desiredRetention * 100)}%</span></div>
          <div className="toolbar-actions"><button className="command-search" onClick={() => { setView("lexicon"); window.setTimeout(() => document.querySelector<HTMLInputElement>("#lexicon-search")?.focus(), 0); }}><Search size={15}/><span>查词或跳转</span><kbd>⌘K</kbd></button>{lastReview && <button className="square-icon" onClick={undoLast} aria-label="撤销上一次评分"><Undo2 size={16}/></button>}<button className={view === "settings" ? "square-icon mobile-data-trigger active" : "square-icon mobile-data-trigger"} onClick={() => setView("settings")} aria-label="设置"><Settings2 size={16}/></button></div>
        </header>
        <main className={`console-main view-${view}`}>
        {view === "today" && (
          <TodayView
            settings={settings}
            manifest={manifest}
            backlog={backlog}
            todayNew={todayNew}
            todayReviews={todayReviews}
            events={activeEvents}
            cards={cards}
            index={index}
            queue={dailyQueuePreview}
            workload={workload}
            diagnosisComplete={settings.diagnosisComplete}
            onStart={() => startSession("daily")}
            onDiagnostic={() => startSession("diagnostic")}
            onPlan={() => setView("plan")}
            onQuick={(type) => {
              const candidates = type === "spelling" ? index.filter((entry) => (cards.get(entry.id)?.skills.spelling ?? 0) < 0.45).slice(0, 12) : index.filter((entry) => entry.scopes.includes("middle-core") && !entry.flags.properName).slice(0, 15);
              startSession("free", candidates, type === "spelling" ? "spelling" : "meaning-recall");
            }}
          />
        )}
        {view === "lexicon" && (
          <ConsoleLexicon
            entries={filteredEntries}
            total={index.length}
            selected={selectedEntry}
            detail={selectedDetail?.id === selectedEntry?.id ? selectedDetail : null}
            visibleDetails={visibleDetails}
            cards={cards}
            events={activeEvents}
            allEntries={index}
            query={query}
            setQuery={setQuery}
            scopeFilters={scopeFilters}
            setScopeFilters={setScopeFilters}
            bookFilter={bookFilter}
            setBookFilter={(value) => { setBookFilter(value); setUnitFilter("all"); }}
            unitFilter={unitFilter}
            setUnitFilter={setUnitFilter}
            statusFilters={statusFilters}
            setStatusFilters={setStatusFilters}
            availableUnits={availableUnits}
            onSelect={setSelectedEntry}
            onFavorite={toggleFavorite}
            onNote={saveNote}
            onStudy={(entry) => startSession("free", [entry, ...filteredEntries.filter((candidate) => candidate.id !== entry.id).slice(0, 9)])}
          />
        )}
        {view === "plan" && <PlanView settings={settings} backlog={backlog} cards={cards} workload={workload} onUpdate={updateSettings} />}
        {view === "analysis" && <AnalysisView manifest={manifest} cards={cards} events={activeEvents} index={index} onTask={(skill) => {
          const candidates = index.filter((entry) => (cards.get(entry.id)?.skills[skill] ?? 0) < 0.5 && !entry.flags.properName).slice(0, 15);
          const typeMap: Record<SkillName, QuestionType> = { meaning: "meaning-recall", listening: "dictation", spelling: "spelling", context: "context-choice", collocation: "collocation-gap", output: "sentence-output" };
          startSession("free", candidates, typeMap[skill]);
        }} />}
        {view === "data" && (
          <DataView
            manifest={manifest}
            articleText={articleText}
            setArticleText={setArticleText}
            articleMatches={articleMatches}
            onAlign={alignArticle}
            onBackup={handleBackup}
            onImport={() => importRef.current?.click()}
            onSync={handleSync}
            onExportLexicon={exportLexicon}
            onOpenSettings={() => setView("settings")}
          />
        )}
        {view === "settings" && (
          <ConsoleSettings settings={settings} onUpdate={updateSettings} onOpenData={() => setView("data")} onClear={async () => {
              if (!window.confirm("将清空本机的学习记录、词单、注释和设置。此操作只能通过已有备份恢复。确定继续？")) return;
              try {
                await clearUserData();
                localStorage.removeItem("pep-vocab-sync-revision");
                setLastReview(null);
                setCards(new Map()); setEvents([]); setSettings(defaultSettings); setToast("本机个人数据已清空");
              } catch { setToast("清空未完成，请重试。"); }
            }}/>
        )}
        </main>
      </section>
      <nav className="console-mobile-nav" aria-label="移动端主导航">{navItems.slice(0, 4).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
      <input ref={importRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && handleImport(event.target.files[0])} />
      <div className="sr-live" aria-live="polite">{toast}</div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function TodayView({ settings, manifest, backlog, todayNew, todayReviews, events, cards, index, queue, workload, diagnosisComplete, onStart, onDiagnostic, onPlan, onQuick }: {
  settings: AppSettings; manifest: LexiconManifest | null; backlog: number; todayNew: number; todayReviews: number; events: ReviewEvent[];
  cards: Map<string, StoredCard>; index: LexiconIndexEntry[]; queue: LexiconIndexEntry[]; workload: ReturnType<typeof forecastDueLoad>;
  diagnosisComplete: boolean; onStart: () => void; onDiagnostic: () => void; onPlan: () => void; onQuick: (type: "spelling" | "middle") => void;
}) {
  const today = new Date().toLocaleDateString("sv-SE");
  const todayEvents = events.filter((event) => event.localDate === today);
  const todayMinutes = todayEvents.reduce((sum, event) => sum + event.responseMs, 0) / 60000;
  const correct = todayEvents.length ? Math.round(todayEvents.filter((event) => event.correct).length / todayEvents.length * 100) : 0;
  const reviewedCards = [...cards.values()].filter((card) => card.lastReviewed);
  const skills = (Object.keys(skillLabels) as SkillName[]).map((skill) => ({ skill, value: reviewedCards.length ? reviewedCards.reduce((sum, card) => sum + card.skills[skill], 0) / reviewedCards.length : 0 }));
  const mix = [...new Set(events.map((event) => event.questionType))].slice(0, 4).map((type) => ({ type, count: events.filter((event) => event.questionType === type).length }));
  const mixMax = Math.max(1, ...mix.map((item) => item.count));
  const loadMax = Math.max(1, ...workload.slice(0, 7).map((day) => day.count));
  const byId = new Map(index.map((entry) => [entry.id, entry]));
  const queueMinutes = Math.min(settings.dailyMinutes, Math.round(todayReviews * .55 + todayNew * 1.5));
  const dueLabel = (entry: LexiconIndexEntry) => {
    const card = cards.get(entry.id);
    if (!card?.lastReviewed) return "新词";
    const days = Math.floor((new Date(`${today}T00:00:00`).getTime() - new Date(card.due).getTime()) / 86400000);
    return days > 0 ? `逾期 ${days} 天` : "今天到期";
  };
  const questionName = (value: string) => QUESTION_CATALOG.find((item) => item.id === value)?.label || value;
  return <div className="console-today">
    <section className="today-workbench">
      {!diagnosisComplete && <section className="console-diagnostic"><span>36</span><div><strong>分层快筛尚未完成</strong><small>12 个初中基础词 + 24 个高一词，识义、听辨、拼写交替检查</small></div><button onClick={onDiagnostic}>开始诊断</button></section>}
      <section className="queue-blueprint"><i className="corner tl"/><i className="corner tr"/><i className="corner bl"/><i className="corner br"/><div><span className="console-kicker">TODAY QUEUE · FSRS V6</span><div className="queue-numbers"><strong>{todayReviews}</strong><small>到期 / 薄弱</small><b>+</b><strong>{todayNew}</strong><small>新词上限</small><i/><strong className="minutes">{queueMinutes}<em> min</em></strong><small>预计用时</small></div><p className={backlog > 28 ? "queue-reason warning" : "queue-reason"}>{backlog > 28 ? `积压 ${backlog} 个：已暂停新词，先消化到期队列。` : `先处理到期与薄弱词，再按教材进度补入 ${todayNew} 个新词。`}</p></div><button className="console-primary" onClick={onStart}><Play size={17} fill="currentColor"/>开始今日学习</button></section>
      <section className="queue-preview"><header><span className="console-kicker">QUEUE PREVIEW</span><i/><small>实时顺序 · 薄弱优先</small></header><div className="queue-table"><div className="queue-row queue-head"><span>词头</span><span>核心义</span><span>层级</span><span>来源</span><span>状态</span></div>{queue.slice(0, 7).map((entry) => <div className="queue-row" key={entry.id}><strong>{entry.headword}</strong><span>{entry.chineseCore}</span><em>{entry.tier} 层</em><small>{sourceLine(entry)}</small><b>{dueLabel(entry)}</b></div>)}{!queue.length && <EmptyState title="今日没有到期任务" text="可以自由查词，或从短任务开始一轮练习。"/>}</div></section>
      <section className="console-quick-tasks"><header><span className="console-kicker">QUICK TASKS</span><i/><small>来自薄弱能力，不按签到凑数</small></header><div><button onClick={() => onQuick("spelling")}><span>01</span><span><strong>拼写回收</strong><small>眼熟但写不出 · 约 12 分钟</small></span><em>弱项优先</em><ChevronRight size={15}/></button><button onClick={() => onQuick("middle")}><span>02</span><span><strong>初中基础快扫</strong><small>核心义主动回忆 · 约 10 分钟</small></span><em>基础保持</em><ChevronRight size={15}/></button></div></section>
    </section>
    <aside className="today-inspector">
      <section className="inspector-summary"><span>TODAY</span><div><strong>{todayEvents.length}</strong><small> 次完成</small><em>{correct}% 正确</em></div><div className="inspector-progress"><i style={{ width: `${Math.min(100, todayMinutes / Math.max(1, settings.dailyMinutes) * 100)}%` }}/></div><p>{formatMinutes(todayMinutes)} / {settings.dailyMinutes} 分钟预算</p></section>
      <section><header><span>7 DAY LOAD</span><small>{workload.slice(0, 7).reduce((sum, day) => sum + day.count, 0)} 次预计</small></header><div className="load-bars">{workload.slice(0, 7).map((day, position) => <i key={day.date} style={{ height: `${Math.max(7, day.count / loadMax * 100)}%` }}>{position === 0 && <span>{day.count}</span>}</i>)}</div><div className="load-axis"><span>今天</span><span>+6 天</span></div></section>
      <section><header><span>SIX CAPABILITIES</span><small>真实卡片均值</small></header><div className="inspector-skills">{skills.map(({ skill, value }) => <div key={skill}><span>{skillLabels[skill]}</span><i><b style={{ width: `${value * 100}%` }}/></i><strong>{Math.round(value * 100)}</strong></div>)}</div></section>
      <section><header><span>QUESTION MIX</span><small>历史事件</small></header><div className="question-mix">{mix.length ? mix.map((item) => <div key={item.type}><span>{questionName(item.type)}</span><i><b style={{ width: `${item.count / mixMax * 100}%` }}/></i><strong>{item.count}</strong></div>) : <p>完成首轮学习后显示题型分布。</p>}</div></section>
      <section><header><span>RECENT EVENTS</span><small>追加式日志</small></header><div className="recent-events">{events.slice(-4).reverse().map((event) => <div key={event.eventId}><strong>{byId.get(event.cardId)?.headword || "已迁移词条"} · {event.correct ? "正确" : "未命中"}</strong><span>{skillLabels[event.skill]} · {event.answerGiven || `评分 ${event.rating}`}</span><time>{new Date(event.timestampUtc).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div>)}</div></section>
      <section className="inspector-footer"><button onClick={onPlan}><span>调整计划与保持率</span><ChevronRight size={14}/></button><span>词库 {manifest?.version || "—"} · 数据 schema {USER_DATA_SCHEMA_VERSION}</span></section>
    </aside>
  </div>;
}

function PlanView({ settings, backlog, cards, workload, onUpdate }: { settings: AppSettings; backlog: number; cards: Map<string, StoredCard>; workload: ReturnType<typeof forecastDueLoad>; onUpdate: (patch: Partial<AppSettings>) => void }) {
  const estimated = workloadEstimate(settings.dailyMinutes, settings.desiredRetention);
  const activeCount = [...cards.values()].filter((card) => card.status !== "paused").length;
  const modes: Array<[AppSettings["mode"], string, string]> = [
    ["normal", "普通学习", "到期与薄弱优先，再放入少量新词"], ["unit", "单元同步", "只从已选教材进度取新词"], ["review-only", "只复习", "不加入任何新词"],
    ["exam", "考前强化", "在时间预算内提高目标词权重"], ["browse", "自由浏览", "不自动创建学习任务"],
  ];
  return (
    <div className="page-frame plan-frame">
      <header className="page-title"><p className="eyebrow">LOAD, NOT STREAKS</p><h1>让计划服从时间预算。</h1><p>系统先处理到期和薄弱词；复习积压时，新词自动减少。</p></header>
      <div className="plan-grid">
        <section className="settings-section">
          <div className="section-heading compact"><div><span className="section-kicker">每日上限</span><h2>{settings.dailyMinutes} 分钟</h2></div><Clock3 size={22} /></div>
          <input type="range" min="10" max="60" step="5" value={settings.dailyMinutes} onChange={(event) => onUpdate({ dailyMinutes: Number(event.target.value) })} aria-label="每日学习分钟数" />
          <div className="range-labels"><span>10</span><span>30</span><span>60 分钟</span></div>
          <div className="settings-divider" />
          <div className="section-heading compact"><div><span className="section-kicker">FSRS 目标保持率</span><h2>{Math.round(settings.desiredRetention * 100)}%</h2></div><Target size={22} /></div>
          <input type="range" min="0.8" max="0.97" step="0.01" value={settings.desiredRetention} onChange={(event) => onUpdate({ desiredRetention: Number(event.target.value) })} aria-label="目标保持率" />
          <div className="retention-impact"><span>预计每日复习时间</span><strong>{estimated} 分钟</strong><small>估算值；保持率越接近 97%，负担上升越快。</small></div>
        </section>

        <section className="settings-section">
          <div className="section-heading compact"><div><span className="section-kicker">学习模式</span><h2>当前：{modes.find(([id]) => id === settings.mode)?.[1]}</h2></div><SlidersHorizontal size={22} /></div>
          <div className="mode-list">{modes.map(([id, label, text]) => <button key={id} className={settings.mode === id ? "active" : ""} onClick={() => onUpdate({ mode: id })}><span className="radio-mark" /><div><strong>{label}</strong><small>{text}</small></div></button>)}</div>
        </section>

        <section className="settings-section span-two">
          <div className="section-heading compact"><div><span className="section-kicker">实际教材进度</span><h2>按学校进度选范围，不混淆七册完整词库。</h2></div><BookOpen size={22} /></div>
          <div className="book-selector">{bookOptions.map(([id, label]) => {
            const checked = settings.selectedBooks.includes(id);
            return <label key={id} className={checked ? "checked" : ""}><input type="checkbox" checked={checked} onChange={() => onUpdate({ selectedBooks: checked ? settings.selectedBooks.filter((book) => book !== id) : [...settings.selectedBooks, id] })} /><span><Check size={14} /></span><strong>{label}</strong><small>{id.startsWith("HS-R") ? "高中必修" : id.startsWith("HS-S") ? "选择性必修" : "初中核心"}</small></label>;
          })}</div>
        </section>

        <section className="forecast-section span-two">
          <div><span className="section-kicker">未来 14 天</span><h2>负担预测</h2><p>{backlog ? `目前 ${backlog} 个到期词；计划会压低新词，直到积压回落。` : "当前没有逾期；仍保留缓冲，不把空闲全部塞成新词。"}</p></div>
          <div className="forecast-chart" role="img" aria-label="未来十四天复习负担条形图">{workload.map((day, index) => <span key={day.date}><i style={{ height: `${Math.max(4, day.count / Math.max(1, ...workload.map((row) => row.count)) * 100)}%` }} /><small>{index % 2 === 0 ? `${index + 1}` : ""}</small></span>)}</div>
          <div className="forecast-summary"><Metric label="主学习状态" value={activeCount} note="跨词书不复制" /><Metric label="预计峰值" value={`${Math.max(estimated, ...workload.map((day) => day.minutes))} 分钟`} note="来自当前到期时间" /></div>
        </section>
      </div>
    </div>
  );
}

function AnalysisView({ manifest, cards, events, index, onTask }: { manifest: LexiconManifest | null; cards: Map<string, StoredCard>; events: ReviewEvent[]; index: LexiconIndexEntry[]; onTask: (skill: SkillName) => void }) {
  const reviewedCards = [...cards.values()].filter((card) => card.lastReviewed);
  const skills = (Object.keys(skillLabels) as SkillName[]).map((skill) => ({ skill, value: reviewedCards.length ? reviewedCards.reduce((sum, card) => sum + card.skills[skill], 0) / reviewedCards.length : 0 }));
  const today = new Date();
  const days = Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(today); date.setDate(today.getDate() - (29 - offset));
    const key = date.toLocaleDateString("sv-SE");
    return events.filter((event) => event.localDate === key).length;
  });
  const maxDay = Math.max(1, ...days);
  const middleLearned = index.filter((entry) => entry.scopes.includes("middle-core") && cards.has(entry.id)).length;
  const highLearned = index.filter((entry) => entry.scopes.some((scope) => scope.startsWith("high")) && cards.has(entry.id)).length;
  const weak = reviewedCards.filter((card) => card.status === "weak");
  const weakest = [...skills].sort((a, b) => a.value - b.value)[0];
  return (
    <div className="page-frame analysis-frame">
      <header className="page-title"><p className="eyebrow">EVIDENCE OVER ACTIVITY</p><h1>看能力缺口，不看热闹。</h1><p>统计来自追加式复习事件；撤销会通过反向事件重放。</p></header>
      <section className="analysis-metrics"><Metric label="学习中词条" value={reviewedCards.length} note={`薄弱 ${weak.length}`} /><Metric label="30 天复习" value={events.filter((event) => event.timestampUtc >= new Date(today.getTime() - 30 * 86400000).toISOString()).length} note="含新学与复习" /><Metric label="估计保持率" value={`${Math.round((reviewedCards.length ? reviewedCards.reduce((sum, card) => sum + Math.min(0.99, Number(card.fsrs.stability || 0) / (Number(card.fsrs.stability || 0) + 2)), 0) / reviewedCards.length : 0) * 100)}%`} note="基于当前稳定度" /><Metric label="主要薄弱项" value={skillLabels[weakest?.skill || "meaning"]} note="推荐专项 10–15 分钟" /></section>
      <div className="analysis-grid">
        <section className="analysis-panel trend-panel"><div className="panel-title"><div><span className="section-kicker">30 DAYS</span><h2>复习趋势</h2></div><span>事件 / 日</span></div><div className="trend-chart" role="img" aria-label="三十天复习事件趋势">{days.map((value, indexValue) => <i key={indexValue} style={{ height: `${Math.max(4, value / maxDay * 100)}%` }} title={`${value} 次`} />)}</div><div className="trend-axis"><span>30 天前</span><span>今天</span></div></section>
        <section className="analysis-panel skills-panel"><div className="panel-title"><div><span className="section-kicker">SIX CAPABILITIES</span><h2>六项能力</h2></div><span>0–100</span></div>{skills.map(({ skill, value }) => <button key={skill} onClick={() => onTask(skill)}><span>{skillLabels[skill]}</span><Progress value={value} /><strong>{Math.round(value * 100)}</strong><ChevronRight size={15} /></button>)}</section>
        <section className="analysis-panel coverage-panel"><div className="panel-title"><div><span className="section-kicker">COVERAGE</span><h2>初高中独立覆盖</h2></div></div><div className="coverage-row"><div><strong>初中核心</strong><small>{middleLearned} / {manifest?.middleEntries || 0}</small></div><Progress value={middleLearned / Math.max(1, manifest?.middleEntries || 1)} /></div><div className="coverage-row"><div><strong>高中七册</strong><small>{highLearned} / {(manifest?.highRequiredEntries || 0) + (manifest?.highSelectiveEntries || 0)}</small></div><Progress value={highLearned / Math.max(1, (manifest?.highRequiredEntries || 0) + (manifest?.highSelectiveEntries || 0))} /></div><div className="coverage-note"><Info size={16} /><p>同一个词跨册出现时只保留一个调度状态，来源位置会全部保留。</p></div></section>
        <section className="analysis-panel weak-panel"><div className="panel-title"><div><span className="section-kicker">NEXT ACTION</span><h2>推荐短任务</h2></div></div><strong>{skillLabels[weakest?.skill || "meaning"]} · 12 分钟</strong><p>{weakest?.skill === "spelling" ? "近期“眼熟但写不出”比例最高，先做中文到英文输入。" : weakest?.skill === "listening" ? "听辨稳定度最低，先做系统语音听写；真人音频未获授权时不冒充。" : "从最低能力向量取词，避免为每个词创建六份长期任务。"}</p><button className="secondary-button" onClick={() => onTask(weakest?.skill || "meaning")}>开始专项</button></section>
      </div>
    </div>
  );
}

function DataView({ manifest, articleText, setArticleText, articleMatches, onAlign, onBackup, onImport, onSync, onExportLexicon, onOpenSettings }: {
  manifest: LexiconManifest | null; articleText: string; setArticleText: (value: string) => void; articleMatches: LexiconIndexEntry[];
  onAlign: () => void; onBackup: () => void; onImport: () => void; onSync: (direction: "push" | "pull") => void; onExportLexicon: (format: "csv" | "tsv") => void; onOpenSettings: () => void;
}) {
  return (
    <div className="page-frame data-frame">
      <header className="page-title"><p className="eyebrow">LOCAL FIRST</p><h1>你的学习数据，先在本机。</h1><p>词库版本与个人状态分离；JSON 备份可完整恢复，应用偏好与 API 接口已集中到设置页。</p></header>
      <div className="data-grid">
        <section className="data-panel"><Database size={22} /><div><span className="section-kicker">个人数据</span><h2>备份、恢复与私有同步</h2><p>包含卡片主状态、六项能力、追加式事件、词单、注释和设置。</p></div><div className="button-row"><button className="primary-button" onClick={onBackup}><Download size={17} />导出 JSON</button><button className="secondary-button" onClick={onImport}><Upload size={17} />恢复备份</button><button className="secondary-button" onClick={() => onSync("push")}>同步本机</button><button className="secondary-button" onClick={() => onSync("pull")}>从私有同步恢复</button></div><small>当前 schema：{USER_DATA_SCHEMA_VERSION}；1.0.0 备份会先迁移再恢复。冲突不会静默覆盖。</small></section>
        <section className="data-panel"><FileText size={22} /><div><span className="section-kicker">词库与 Anki</span><h2>CSV / TSV</h2><p>导出当前正式词库筛选结果；TSV 可映射到 Anki 的 Word、IPA、Meaning、Source 字段。</p></div><div className="button-row"><button className="secondary-button" onClick={() => onExportLexicon("csv")}>导出 CSV</button><button className="secondary-button" onClick={() => onExportLexicon("tsv")}>Anki TSV</button></div><small>发布版本 {manifest?.version || "—"}；不会导出教材 PDF 或未授权音频。</small></section>
        <section className="data-panel article-panel"><Search size={22} /><div><span className="section-kicker">文章生词对齐</span><h2>粘贴一段英文</h2><p>只在本机分词，并与正式索引对齐；文本不会上传。</p></div><textarea value={articleText} onChange={(event) => setArticleText(event.target.value)} placeholder="Paste an English article here…" /><button className="primary-button" onClick={onAlign}>提取并对齐</button>{articleMatches.length > 0 && <div className="match-list">{articleMatches.map((entry) => <span key={entry.id}><strong>{entry.headword}</strong>{entry.chineseCore}</span>)}</div>}</section>
        <section className="data-panel"><Settings2 size={22}/><div><span className="section-kicker">应用设置</span><h2>外观、学习与 API</h2><p>API Key 由服务端加密保管，不进入学习备份；接口状态和安全边界可在设置页查看。</p></div><button className="secondary-button" onClick={onOpenSettings}>打开设置<ChevronRight size={16}/></button><small>数据页不读取、显示或导出任何 API Key。</small></section>
      </div>
      <section className="privacy-strip"><ShieldCheck size={20} /><div><strong>数据边界</strong><p>词库作为版本化静态资源；学习状态进入 IndexedDB。私有同步启用时只上传个人状态，不复制整份词库。系统 TTS 不等于真人音频。</p></div></section>
    </div>
  );
}
