"use client";

import {
  Activity,
  lazy,
  memo,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CloudOff,
  Search,
  X,
} from "lucide-react";
import { useVocabulary } from "@/hooks/use-vocabulary";
import { notify, useToastMessage } from "@/hooks/toast-store";
import { buildStudyQueue, summarizeStudy, type StudyMode } from "@/lib/study";
import { studyStats } from "@/lib/progress";
import {
  SESSION_KEY,
  restoreSession,
  type StudySessionState,
} from "@/lib/session";
import { clearUserData, createLocalId } from "@/lib/storage";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import type { LearnMode } from "@/lib/learn";
import Today from "./studio/today";
import { Brand } from "./studio/shared";
import { StudioSymbol } from "./studio/symbol";
import type { CSSProperties, ReactNode } from "react";

// Memoized: once visited, these stay mounted behind <Activity> and skip unrelated shell renders.
const TodayView = memo(Today);
const Lexicon = lazy(() => import("./studio/lexicon").then((m) => ({ default: memo(m.default) })));
const Reading = lazy(() => import("./studio/reading").then((m) => ({ default: memo(m.default) })));
const ActivityView = lazy(() => import("./studio/activity").then((m) => ({ default: memo(m.default) })));
const SettingsDialog = lazy(() => import("./studio/settings-dialog"));
const StudySession = lazy(() => import("./studio/study-session"));
const WordDetail = lazy(() => import("./studio/word-detail"));
const LearnActivity = lazy(() => import("./studio/learn/learn-activity"));
type View = "today" | "lexicon" | "reading" | "activity";
const navigation = [
  { id: "today", label: "今日学习", short: "今日", symbol: "today" },
  { id: "lexicon", label: "词库", short: "词库", symbol: "lexicon" },
  { id: "reading", label: "阅读", short: "阅读", symbol: "reading" },
  { id: "activity", label: "学习记录", short: "记录", symbol: "activity" },
  { id: "settings", label: "设置", short: "设置", symbol: "settings" },
] as const;
const modeTitle: Record<StudyMode, string> = {
  daily: "今日学习",
  review: "到期复习",
  mistakes: "错词重练",
  dictation: "单词听写",
  context: "语境练习",
  new: "学习新词",
};
function Pending() {
  return (
    <div className="view-loading" role="status">
      正在准备…
    </div>
  );
}
/**
 * One main view. A visited view stays mounted while hidden, so its search, page and open article
 * survive tab switches; hidden views run no effects (listeners, observers, timers). Showing it
 * again replays the surface fade, as the former remount did.
 */
function ViewPane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <Suspense fallback={<Pending />}>
        <div className="view-surface">{children}</div>
      </Suspense>
    </Activity>
  );
}

// Owns the toast subscription, so a message appearing or clearing re-renders only this region.
// The live region stays mounted so screen readers announce each message as it appears.
const Toaster = memo(function Toaster() {
  const message = useToastMessage();
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message && (
        <div className="toast">
          <span>{message}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => notify(null)}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
});

const subscribeNothing = () => () => {};
const shortcutLabel = () => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘ K" : "Ctrl K");

export default function VocabApp() {
  const data = useVocabulary();
  const shortcut = useSyncExternalStore(subscribeNothing, shortcutLabel, () => "⌘ K");
  const [view, setView] = useState<View>("today");
  // Views stay mounted once visited (hidden with <Activity>), keeping search, page and open article.
  const [visited, setVisited] = useState<ReadonlySet<View>>(() => new Set(["today"]));
  if (!visited.has(view)) setVisited(new Set(visited).add(view));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unit, setUnit] = useState("all");
  const [selected, setSelected] = useState<LexiconIndexEntry | null>(null);
  const [session, setSession] = useState<StudySessionState | null>(null);
  const [learn, setLearn] = useState<LearnMode | null>(null);
  const [resume, setResume] = useState<StudySessionState | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const initialized = useRef(false);
  const heading = useRef<HTMLElement>(null);
  const bookId = data.settings.selectedBooks[0] || "HS-R1";
  // While practising, the Today plan is off screen: recount it in a background render after each
  // answer rather than before the next card can paint. Elsewhere it stays in step with the data.
  const deferredCards = useDeferredValue(data.cards);
  const deferredEvents = useDeferredValue(data.events);
  const offscreen = session !== null || learn !== null;
  const planCards = offscreen ? deferredCards : data.cards;
  const planEvents = offscreen ? deferredEvents : data.events;
  const stats = useMemo(
    () => studyStats(planEvents, new Date(clock)),
    [planEvents, clock],
  );
  const summary = useMemo(
    () =>
      summarizeStudy(data.index, planCards, {
        bookId,
        unit,
        now: new Date(clock),
      }),
    [data.index, planCards, bookId, unit, clock],
  );
  const budget = Math.max(
    0,
    Math.min(
      14 - stats.todayNew,
      Math.floor(
        (data.settings.dailyMinutes -
          Math.min(data.settings.dailyMinutes, summary.due * 0.6)) /
          1.5,
      ),
    ),
  );
  const newLimit =
    data.settings.mode === "review-only" || data.settings.mode === "browse"
      ? 0
      : budget;
  const dailyQueue = useMemo(
    () =>
      buildStudyQueue(data.index, planCards, {
        bookId,
        unit,
        mode: "daily",
        limit: Math.min(
          60,
          Math.max(10, Math.floor(data.settings.dailyMinutes / 0.7)),
        ),
        newLimit,
        now: new Date(clock),
      }),
    [
      data.index,
      planCards,
      bookId,
      unit,
      data.settings.dailyMinutes,
      newLimit,
      clock,
    ],
  );

  useEffect(() => {
    // Recount due words once a minute while visible, and at once on returning to the tab.
    const tick = () => {
      if (document.visibilityState === "visible") setClock(Date.now());
    };
    const timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  useEffect(() => {
    if (data.loading) return;
    // Warm the practice and word-detail chunks so the first tap opens without a loading step.
    const warm = () => {
      void import("./studio/study-session");
      void import("./studio/word-detail");
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, [data.loading]);
  useEffect(() => {
    if (data.loading || initialized.current) return;
    initialized.current = true;
    // Hydrate an external per-tab checkpoint only after validating the loaded word IDs.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResume(
        restoreSession(
          sessionStorage.getItem(SESSION_KEY),
          new Set(data.index.map((e) => e.id)),
          data.events,
        ),
      );
    } catch {
      /* Learning works when tab checkpoint storage is unavailable. */
    }
  }, [data.loading, data.index, data.events]);
  useEffect(() => {
    window.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [view]);
  // Reads the latest state when a key arrives, so practice checkpoints do not rebind the listener.
  const onSearchKey = useEffectEvent((event: KeyboardEvent) => {
    const editing = (event.target as HTMLElement)?.closest(
      "input, textarea, select, [contenteditable]",
    );
    if (
      !session &&
      !learn &&
      !selected &&
      !settingsOpen &&
      (((event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k") ||
        (!editing && event.key === "/"))
    ) {
      event.preventDefault();
      setView("lexicon");
      setTimeout(
        () =>
          document
            .querySelector<HTMLInputElement>("#lexicon-search")
            ?.focus(),
        150,
      );
    }
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => onSearchKey(event);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const checkpoint = useCallback(
    (next: StudySessionState) => {
      setSession(next);
      try {
        if (next.position >= next.queue.length)
          sessionStorage.removeItem(SESSION_KEY);
        else sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      } catch {
        notify("本机作答已保存，但此浏览器未允许保存临时学习位置。");
      }
    },
    [],
  );
  // Stable between data changes, so views kept mounted in the background are not re-rendered
  // by every shell render.
  const startSession = useCallback((mode: StudyMode, custom?: LexiconIndexEntry[]) => {
    const queue = custom?.length
      ? custom
          .filter((entry) => data.cards.get(entry.id)?.status !== "paused")
          .slice(0, 80)
      : mode === "daily"
        ? dailyQueue
        : buildStudyQueue(data.index, data.cards, {
            bookId,
            unit,
            mode,
            limit: 20,
            newLimit: 20,
          });
    if (!queue.length) {
      notify(
        mode === "mistakes"
          ? "当前范围没有待巩固词。可以换个教材或继续学习。"
          : "当前范围没有待学词，可从词库选择练习。",
      );
      return;
    }
    const next: StudySessionState = {
      id: createLocalId(),
      mode,
      title: custom?.length && mode === "daily" ? "单词练习" : modeTitle[mode],
      queue: [...new Set(queue.map((entry) => entry.id))],
      position: 0,
      startedAt: Date.now(),
      results: [],
      retries: {},
    };
    setSelected(null);
    setResume(null);
    checkpoint(next);
  }, [data.cards, data.index, dailyQueue, bookId, unit, checkpoint]);
  const { updateSettings } = data;
  const onCourse = useCallback((book: string, nextUnit: string) => {
    setUnit(nextUnit);
    void updateSettings({ selectedBooks: [book] });
  }, [updateSettings]);
  const practiseReading = useCallback(
    (entries: LexiconIndexEntry[]) => startSession("context", entries),
    [startSession],
  );
  // Stable Today props, so switching tabs does not re-render the Today view behind them.
  const onLearn = useCallback((mode: LearnMode) => {
    setSelected(null);
    setLearn(mode);
  }, []);
  const showLexicon = useCallback(() => setView("lexicon"), []);
  const showReading = useCallback(() => setView("reading"), []);
  const showActivity = useCallback(() => setView("activity"), []);
  const resumeSession = useMemo(
    () =>
      resume
        ? () => {
            checkpoint(resume);
            setResume(null);
          }
        : null,
    [resume, checkpoint],
  );
  const newCount = useMemo(
    () =>
      dailyQueue.filter((entry) => !data.cards.get(entry.id)?.lastReviewed)
        .length,
    [dailyQueue, data.cards],
  );
  const closeSession = () => {
    if (session && session.position < session.queue.length) setResume(session);
    else setResume(null);
    setSession(null);
    setView("today");
  };
  const onReplaced = () => {
    setResume(null);
    setSession(null);
  };
  const clear = async () => {
    if (
      !window.confirm(
        "将清空本机学习记录、收藏、个人文章和设置。请先导出备份。确认清空？",
      )
    )
      return;
    try {
      await clearUserData();
      const { clearPersonalReadings } = await import("@/lib/personal-readings");
      await clearPersonalReadings();
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("pep-vocab-cloud-link-v2");
      localStorage.removeItem("pep-vocab-sync-revision");
      onReplaced();
      await data.reload();
      data.notify("本机学习数据已清空。");
    } catch {
      data.notify("清空失败，请重试。");
    }
  };

  if (data.loading)
    return (
      <main className="boot-screen">
        <Brand />
        <span className="boot-pulse" />
        <p>正在载入词库…</p>
      </main>
    );
  if (data.error)
    return (
      <main className="boot-screen">
        <CloudOff size={35} aria-hidden="true" />
        <h1>暂时无法打开词迹</h1>
        <p>{data.error}</p>
        <button className="primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    );
  const toast = <Toaster />;
  if (session)
    return (
      <>
        <Suspense fallback={<Pending />}>
          <StudySession
            key={session.id}
            data={data}
            session={session}
            onChange={checkpoint}
            onExit={closeSession}
            onRetry={(ids) => {
              // Keep lexicon order, as before, without an O(n·m) includes scan.
              const wanted = new Set(ids);
              startSession(
                "mistakes",
                data.index.filter((entry) => wanted.has(entry.id)),
              );
            }}
          />
        </Suspense>
        {toast}
      </>
    );
  if (learn)
    return (
      <>
        <Suspense fallback={<Pending />}>
          <LearnActivity
            data={data}
            mode={learn}
            bookId={bookId}
            unit={unit}
            onCourse={onCourse}
            onExit={() => setLearn(null)}
            onPractice={(entries, mode) => {
              setLearn(null);
              startSession(mode, entries);
            }}
          />
        </Suspense>
        {toast}
      </>
    );
  return (
    <div className="vocab-studio">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="app-sidebar" aria-label="应用侧栏">
        <button
          className="brand-home"
          onClick={() => setView("today")}
          aria-label="词迹首页"
        >
          <Brand />
        </button>
        <button
          className="sidebar-search"
          aria-label="搜索词库"
          onClick={() => {
            setView("lexicon");
            setTimeout(
              () =>
                document
                  .querySelector<HTMLInputElement>("#lexicon-search")
                  ?.focus(),
              150,
            );
          }}
        >
          <Search size={17} aria-hidden="true" />
          <span>搜索</span>
          <kbd>{shortcut}</kbd>
        </button>
        <nav className="desktop-nav" aria-label="主要导航">
          {navigation.slice(0, 3).map(({ id, label, symbol }) => (
            <button
              key={id}
              aria-label={label}
              title={label}
              aria-current={
                view === id
                  ? "page"
                  : undefined
              }
              onClick={() => id === "settings" ? setSettingsOpen(true) : setView(id)}
            >
              <StudioSymbol name={symbol} size={21} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-progress"
            onClick={() => setView("activity")}
          >
            <span
              className="daily-ring"
              style={{
                background: `conic-gradient(var(--blue) ${Math.min(100, (stats.todayMinutes / Math.max(1, data.settings.dailyMinutes)) * 100)}%, var(--line) 0)`,
              }}
            >
              <span>{stats.todayWords}</span>
            </span>
            <span>
              <strong>今日进度</strong>
              <small>今天已学习 {stats.todayWords} 词</small>
            </span>
          </button>
          <nav className="desktop-nav" aria-label="个人导航">
            {navigation.slice(3).map(({ id, label, symbol }) => (
              <button
                key={id}
                aria-label={label}
                title={label}
                aria-current={
                  view === id
                    ? "page"
                    : undefined
                }
                onClick={() => id === "settings" ? setSettingsOpen(true) : setView(id)}
              >
                <StudioSymbol name={symbol} size={21} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </aside>
      <header className="mobile-header">
        <button
          className="brand-home"
          onClick={() => setView("today")}
          aria-label="词迹首页"
        >
          <Brand />
        </button>
        <button
          className="icon-button"
          aria-label="搜索词库"
          onClick={() => setView("lexicon")}
        >
          <Search size={21} aria-hidden="true" />
        </button>
      </header>
      <div className="studio-workspace">
        <main
          id="main-content"
          className="main-content"
          ref={heading}
          tabIndex={-1}
        >
          {!data.online && (
            <div className="offline-banner" role="status">
              <CloudOff size={16} aria-hidden="true" />
              离线模式 · 已缓存词条仍可学习，作答会保存在本机。
            </div>
          )}
          <ViewPane active={view === "today"}>
            <TodayView
              data={data}
              bookId={bookId}
              unit={unit}
              onCourse={onCourse}
              due={summary.due}
              newCount={newCount}
              weak={summary.weak}
              total={summary.total}
              learned={summary.learned}
              queue={dailyQueue}
              onStart={startSession}
              onLearn={onLearn}
              onWords={showLexicon}
              onReading={showReading}
              onActivity={showActivity}
              resumeLabel={
                resume
                  ? `${resume.title} · 第 ${resume.position + 1} / ${resume.queue.length} 词`
                  : null
              }
              resume={resumeSession}
            />
          </ViewPane>
          {visited.has("lexicon") && (
            <ViewPane active={view === "lexicon"}>
              <Lexicon
                data={data}
                bookId={bookId}
                unit={unit}
                onCourse={onCourse}
                initialQuery=""
                onDetail={setSelected}
                onStart={startSession}
              />
            </ViewPane>
          )}
          {visited.has("reading") && (
            <ViewPane active={view === "reading"}>
              <Reading
                data={data}
                onDetail={setSelected}
                onPractice={practiseReading}
              />
            </ViewPane>
          )}
          {visited.has("activity") && (
            <ViewPane active={view === "activity"}>
              {/* Keyed by date: the record counts "today" and the last seven days, as a fresh visit did. */}
              <ActivityView key={new Date(clock).toLocaleDateString("sv-SE")} data={data} />
            </ViewPane>
          )}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="移动导航" style={{ "--nav-index": navigation.findIndex(item => item.id === view) } as CSSProperties}>
        <span className="nav-selection" aria-hidden="true" />
        {navigation.map(({ id, short, symbol }) => (
          <button
            key={id}
            aria-current={
              view === id
                ? "page"
                : undefined
            }
            onClick={() => id === "settings" ? setSettingsOpen(true) : setView(id)}
          >
            <StudioSymbol name={symbol} size={25} />
            <span>{short}</span>
          </button>
        ))}
      </nav>
      {settingsOpen && <Suspense fallback={null}><SettingsDialog data={data} onClose={() => setSettingsOpen(false)} onClear={clear} onReplaced={onReplaced} /></Suspense>}
      {selected && (
        <Suspense fallback={null}>
          <WordDetail
            key={selected.id}
            entry={selected}
            data={data}
            onClose={() => setSelected(null)}
            onPractice={(entry) => startSession("daily", [entry])}
          />
        </Suspense>
      )}
      {toast}
    </div>
  );
}
