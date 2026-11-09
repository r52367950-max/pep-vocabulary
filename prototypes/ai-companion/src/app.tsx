import { useEffect } from "react";
import { StudioSymbol, type SymbolName } from "@/components/studio/symbol";
import { useStore } from "./store";
import type { LearnView } from "./types";
import { BrandMark } from "./components/icons";
import { ChatView } from "./components/chat-view";
import { DictationView } from "./components/dictation-view";
import { RecordsView, TodayView, WordsView } from "./components/learn-views";
import { Launcher, MiniPanel } from "./components/mini-panel";
import { ReadingView } from "./components/reading-view";
import { SettingsDialog } from "./components/settings-dialog";
import { VoiceSession } from "./components/voice-session";

const NAV: { id: LearnView; label: string; short: string; symbol: SymbolName }[] = [
  { id: "today", label: "今日学习", short: "今日", symbol: "today" },
  { id: "words", label: "词库", short: "词库", symbol: "lexicon" },
  { id: "reading", label: "阅读", short: "阅读", symbol: "reading" },
  { id: "records", label: "学习记录", short: "记录", symbol: "activity" },
];

const HOST_THEME = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;

export function App() {
  const { state, setView, dispatch } = useStore();
  const { view, settings } = state;
  const chat = view === "chat";
  const current = view === "dictation" ? "today" : view;

  useEffect(() => {
    const root = document.documentElement;
    // "System" leaves whatever the page was opened with (a host may set its own theme attribute).
    if (settings.theme === "system") { if (HOST_THEME) root.dataset.theme = HOST_THEME; else delete root.dataset.theme; }
    else root.dataset.theme = settings.theme;
    if (settings.motion === "reduce") root.dataset.motion = "reduce"; else delete root.dataset.motion;
  }, [settings.theme, settings.motion]);

  return (
    <div className={`app${chat ? " is-chat" : ""}${!chat && state.miniOpen ? " mini-open" : ""}`}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <aside className="side-nav" aria-label="词迹导航">
        <button type="button" className="brand" aria-label="词迹 · 今日学习" onClick={() => setView("today")}>
          <BrandMark /><span className="brand-name">词迹</span>
        </button>
        <nav aria-label="学习导航">
          {NAV.map((item) => (
            <button key={item.id} type="button" className="nav-item" aria-current={current === item.id ? "page" : undefined} title={item.label} onClick={() => setView(item.id)}>
              <StudioSymbol name={item.symbol} size={21} /><span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <span className="nav-spacer" />
        <button type="button" className="nav-item" title="设置" onClick={() => dispatch({ type: "settings-open", section: "general" })}>
          <StudioSymbol name="settings" size={21} /><span className="nav-label">设置</span>
        </button>
      </aside>
      <main id="main" className="stage" tabIndex={-1}>
        {view === "chat" && <ChatView />}
        {view === "today" && <TodayView />}
        {view === "words" && <WordsView />}
        {view === "reading" && <ReadingView />}
        {view === "records" && <RecordsView />}
        {view === "dictation" && <DictationView />}
      </main>
      {!chat && (
        <nav className="tab-bar" aria-label="学习导航">
          {NAV.map((item) => (
            <button key={item.id} type="button" aria-current={current === item.id ? "page" : undefined} onClick={() => setView(item.id)}>
              <StudioSymbol name={item.symbol} size={23} /><span>{item.short}</span>
            </button>
          ))}
          <button type="button" onClick={() => dispatch({ type: "settings-open", section: "general" })}>
            <StudioSymbol name="settings" size={23} /><span>设置</span>
          </button>
        </nav>
      )}
      {!chat && state.miniOpen && <MiniPanel />}
      {!chat && <Launcher />}
      <SettingsDialog />
      <VoiceSession />
      <p className="visually-hidden" role="status" aria-live="polite">{state.announcement}</p>
    </div>
  );
}
