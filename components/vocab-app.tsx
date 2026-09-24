"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CloudOff,
  Search,
  X,
} from "lucide-react";
import { useVocabulary } from "@/hooks/use-vocabulary";
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
import type { CSSProperties } from "react";

const Lexicon = lazy(() => import("./studio/lexicon"));
const Reading = lazy(() => import("./studio/reading"));
const Activity = lazy(() => import("./studio/activity"));
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

export default function VocabApp() {
  const data = useVocabulary();
  const [view, setView] = useState<View>("today");
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
  const stats = useMemo(
    () => studyStats(data.events, new Date(clock)),
    [data.events, clock],
  );
  const summary = useMemo(
    () =>
      summarizeStudy(data.index, data.cards, {
        bookId,
        unit,
        now: new Date(clock),
      }),
    [data.index, data.cards, bookId, unit, clock],
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
      buildStudyQueue(data.index, data.cards, {
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
      data.cards,
      bookId,
      unit,
      data.settings.dailyMinutes,
      newLimit,
      clock,
    ],
  );

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
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
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
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
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [session, learn, selected, settingsOpen]);

  const checkpoint = useCallback(
    (next: StudySessionState) => {
      setSession(next);
      try {
        if (next.position >= next.queue.length)
          sessionStorage.removeItem(SESSION_KEY);
        else sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      } catch {
        data.notify("本机作答已保存，但此浏览器未允许保存临时学习位置。");
      }
    },
    [data],
  );
  const startSession = (mode: StudyMode, custom?: LexiconIndexEntry[]) => {
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
      data.notify(
        mode === "mistakes"
          ? "当前范围没有待巩固词。可以换个教材或继续学习。"
          : "当前范围没有待学词，可从词库选择练习。",
      );
      return;
    }
    const next: StudySessionState = {
      id: createLocalId(),
      mode,
      title: modeTitle[mode],
      queue: [...new Set(queue.map((entry) => entry.id))],
      position: 0,
      startedAt: Date.now(),
      results: [],
      retries: {},
    };
    setSelected(null);
    setResume(null);
    checkpoint(next);
  };
  const onCourse = (book: string, nextUnit: string) => {
    setUnit(nextUnit);
    void data.updateSettings({ selectedBooks: [book] });
  };
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
        <CloudOff size={35} />
        <h1>暂时无法打开词迹</h1>
        <p>{data.error}</p>
        <button className="primary" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    );
  const toast = data.toast && (
    <div className="toast" role="status">
      <span>{data.toast}</span>
      <button
        className="icon-button"
        aria-label="关闭提示"
        onClick={() => data.notify(null)}
      >
        <X size={17} />
      </button>
    </div>
  );
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
            onRetry={(ids) =>
              startSession(
                "mistakes",
                data.index.filter((entry) => ids.includes(entry.id)),
              )
            }
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
          <Search size={17} />
          <span>搜索</span>
          <kbd>⌘ K</kbd>
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
              <StudioSymbol name={symbol} tile size={21} />
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
                <StudioSymbol name={symbol} tile size={21} />
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
          <Search size={21} />
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
            <div className="offline-banner">
              <CloudOff size={16} />
              离线模式 · 已缓存词条仍可学习，作答会保存在本机。
            </div>
          )}
          <Suspense fallback={<Pending />}>
          <div className="view-surface" key={view}>
            {view === "today" && (
              <Today
                data={data}
                bookId={bookId}
                unit={unit}
                onCourse={onCourse}
                due={summary.due}
                newCount={
                  dailyQueue.filter(
                    (entry) => !data.cards.get(entry.id)?.lastReviewed,
                  ).length
                }
                weak={summary.weak}
                total={summary.total}
                learned={summary.learned}
                queue={dailyQueue}
                onStart={startSession}
                onLearn={(mode: LearnMode) => {
                  setSelected(null);
                  setLearn(mode);
                }}
                onWords={() => setView("lexicon")}
                onReading={() => setView("reading")}
                onActivity={() => setView("activity")}
                resumeLabel={
                  resume
                    ? `${resume.title} · 第 ${resume.position + 1} / ${resume.queue.length} 词`
                    : null
                }
                resume={
                  resume
                    ? () => {
                        checkpoint(resume);
                        setResume(null);
                      }
                    : null
                }
              />
            )}
            {view === "lexicon" && (
              <Lexicon
                data={data}
                bookId={bookId}
                unit={unit}
                onCourse={onCourse}
                initialQuery=""
                onDetail={setSelected}
                onStart={startSession}
              />
            )}
            {view === "reading" && (
              <Reading
                data={data}
                onDetail={setSelected}
                onPractice={(entries) => startSession("context", entries)}
              />
            )}
            {view === "activity" && <Activity data={data} />}

          </div>
          </Suspense>
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
