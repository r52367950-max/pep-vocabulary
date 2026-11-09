"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, AudioLines, Mic, MicOff, Play, Settings2, X } from "lucide-react";
import { contextStillCurrent, learningContextStore, refreshLearningContext, type LearningMemory } from "@/lib/learning-context-client";
import { NativeLiveSession, appendTranscript, voiceRequest, type LiveDictationPlan, type TranscriptTurn, type VoiceSnapshot, type VoiceStatus } from "@/lib/voice/client";
import { companionVoiceContext } from "@/lib/companion-voice-context";
import type { DictationItem } from "@/lib/voice/dictation";
import { useStore } from "../store";
import { TraceGlyph } from "./icons";
import "../live-voice.css";

const INITIAL: VoiceSnapshot = { phase: "idle", message: "", muted: false, paused: false, playbackBlocked: false, seconds: 0, usageSeconds: null, maxSeconds: 600, closeConfirmed: false };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const DictationPanel = lazy(() => import("../../voice/dictation-panel").then((module) => ({ default: module.DictationPanel })));
const NO_ENTRIES: never[] = [];

/** The approved conversation surface shares the existing authenticated WebRTC transport. */
export function VoiceStage({ conversationId }: { conversationId: string }) {
  const { state, appendVoice, dispatch, send, getState } = useStore();
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [snapshot, setSnapshot] = useState(INITIAL);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [closing, setClosing] = useState(false);
  const [hasPendingClose, setHasPendingClose] = useState(false);
  const [plan, setPlan] = useState<LiveDictationPlan | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [dictationBusy, setDictationBusy] = useState(false);
  const [dictationUnconfirmed, setDictationUnconfirmed] = useState(false);
  const client = useRef<NativeLiveSession | null>(null);
  const mounted = useRef(false);
  const startPending = useRef(false);
  const exitPending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const starting = useRef<AbortController | null>(null);
  const startSequence = useRef(0);
  const policy = useRef<{ context: LearningMemory; globalTemporary: boolean } | null>(null);
  const latestTurns = useRef<TranscriptTurn[]>([]);
  const latestSnapshot = useRef(INITIAL);
  const returned = useRef(false);
  const attempts = useRef<{ item: DictationItem; answer: string; correct: boolean; assisted: boolean }[]>([]);
  const captions = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const temporary = !!conversation?.temporary;
  const active = ["connecting", "connected", "closing"].includes(snapshot.phase);
  const connected = snapshot.phase === "connected";
  const cancelStart = useCallback(() => { startSequence.current++; starting.current?.abort(); }, []);

  const readStatus = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    try {
      const value = await voiceRequest<VoiceStatus>("/api/voice/status", undefined, abort.signal);
      if (mounted.current && !abort.signal.aborted) { setStatus(value); setError(""); }
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "语音连接暂不可用，请重试。");
    }
  }, []);

  const keepTranscript = useCallback(() => {
    const captured = policy.current;
    if (returned.current || (!latestTurns.current.length && !attempts.current.length) || !captured || !contextStillCurrent(captured.context, captured.globalTemporary)) return;
    returned.current = true;
    const captions = latestTurns.current.map((turn) => ({ speaker: turn.role === "user" ? "user" as const : "ai" as const, text: turn.text }));
    if (attempts.current.length) captions.push({ speaker: "ai", text: `本次听写完成 ${attempts.current.length} 次作答，独立答对 ${attempts.current.filter((attempt) => attempt.correct && !attempt.assisted).length} 次。${attempts.current.filter((attempt) => !attempt.correct || attempt.assisted).map((attempt) => attempt.item.text).slice(0, 12).join("、") || "本轮全部掌握。"}` });
    appendVoice(conversationId, captions, latestSnapshot.current.seconds);
  }, [appendVoice, conversationId]);

  useEffect(() => {
    mounted.current = true;
    const session = new NativeLiveSession({
      onState: (next) => { if (client.current !== session) return; latestSnapshot.current = next; if (mounted.current) { setSnapshot(next); setHasPendingClose(session.hasPendingClose); } },
      onTranscript: (turn) => {
        const captured = policy.current;
        if (client.current !== session || !captured || !contextStillCurrent(captured.context, captured.globalTemporary)) return;
        latestTurns.current = appendTranscript(latestTurns.current, turn);
        if (mounted.current) setTurns(latestTurns.current);
      },
      onDictationPlan: (next) => {
        const captured = policy.current;
        if (mounted.current && client.current === session && captured && contextStillCurrent(captured.context, captured.globalTemporary)) setPlan(next);
      },
    });
    client.current = session;
    queueMicrotask(() => { if (mounted.current) void readStatus(); });
    const unsubscribe = learningContextStore.subscribe(() => {
      const captured = policy.current;
      if (captured && !contextStillCurrent(captured.context, captured.globalTemporary)) {
        cancelStart();
        policy.current = null;
        latestTurns.current = [];
        attempts.current = [];
        void session.end("账户或学习设置已改变，请重新开始。");
        if (mounted.current) { setTurns([]); setPlan(null); setPracticeOpen(false); setError("账户或学习设置已改变，请重新开始。"); }
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        hiddenAt = Date.now();
        timer = setTimeout(() => void session.end("离开页面较久，语音已停止。"), 30_000);
      } else if (hiddenAt && Date.now() - hiddenAt >= 30_000) {
        hiddenAt = 0;
        void session.end("语音已停止，可以重新开始。");
      }
    };
    const pagehide = () => { cancelStart(); keepTranscript(); session.dispose(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("vocab-ai-config-changed", readStatus);
    return () => {
      mounted.current = false; cancelStart(); clearTimeout(timer); request.current?.abort(); unsubscribe();
      keepTranscript(); session.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("vocab-ai-config-changed", readStatus);
    };
  }, [cancelStart, keepTranscript, readStatus]);

  useEffect(() => {
    if (follow.current && captions.current) captions.current.scrollTop = captions.current.scrollHeight;
  }, [turns]);

  const start = async () => {
    const session = client.current;
    if (!session || startPending.current || active || !status?.ready || status.activeSession || session.hasPendingClose) return;
    startPending.current = true;
    const sequence = ++startSequence.current;
    starting.current?.abort(); const abort = new AbortController(); starting.current = abort;
    setError("");
    try {
      const globalTemporary = learningContextStore.get().temporary;
      const context = await refreshLearningContext(abort.signal);
      if (!mounted.current || abort.signal.aborted || sequence !== startSequence.current || !contextStillCurrent(context, globalTemporary)) return;
      keepTranscript();
      policy.current = { context, globalTemporary };
      returned.current = false; latestTurns.current = []; attempts.current = []; setTurns([]); setPlan(null);
      await session.start({
        topicId: "everyday", level: "B1", minutes: 10,
        temporary: temporary || globalTemporary,
        accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion,
        customTopic: conversation?.title === "新对话" ? "学习对话" : conversation?.title,
        goal: "帮助学习者用英语表达，结合本次学习问题给出简洁、可执行的建议。",
        openingPrompt: companionVoiceContext(getState().conversations.find((item) => item.id === conversationId)?.messages ?? []),
      });
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted && sequence === startSequence.current) setError(cause instanceof Error ? cause.message : "语音未能开始，请重试。");
    } finally { startPending.current = false; }
  };

  const finish = async (text?: string) => {
    if (exitPending.current || dictationBusy || dictationUnconfirmed) return;
    cancelStart();
    exitPending.current = true; setClosing(true);
    try {
      await client.current?.end("语音已结束。");
      if (!mounted.current) return;
      if (client.current?.hasPendingClose) { setError("声音已停止。请重试确认结束。"); return; }
      keepTranscript();
      dispatch({ type: "voice-open", open: false });
      dispatch({ type: "focus-composer" });
      if (text?.trim()) send(conversationId, { text: text.trim(), via: "text", keepDraft: true });
    } finally { exitPending.current = false; if (mounted.current) setClosing(false); }
  };

  const retryClose = async () => {
    if (exitPending.current) return;
    exitPending.current = true; setClosing(true);
    try {
      if (client.current?.hasPendingClose) await client.current.retryClose();
      else if (status?.activeSession) await voiceRequest("/api/voice/close", { sessionId: status.activeSession.sessionId });
      await readStatus();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "请重试确认结束。"); }
    finally { exitPending.current = false; if (mounted.current) setClosing(false); }
  };

  const pendingClose = hasPendingClose || !!status?.activeSession;
  const supported = typeof window !== "undefined" && window.isSecureContext && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;
  const statusText = closing || snapshot.phase === "closing" ? "正在结束…"
    : snapshot.phase === "connecting" ? "正在连接…"
    : connected ? snapshot.muted ? "麦克风已静音" : "对话进行中"
    : snapshot.phase === "ended" ? "语音已结束" : "准备好就开始";
  const notice = error || (snapshot.phase === "error" ? snapshot.message : "");
  const latestAi = turns.map((turn) => turn.role).lastIndexOf("assistant");

  const openPractice = async () => {
    if (!plan?.items.length || exitPending.current) return;
    cancelStart();
    exitPending.current = true; setClosing(true);
    try {
      await client.current?.end("准备进入听写。");
      const captured = policy.current;
      if (!mounted.current || !captured || !contextStillCurrent(captured.context, captured.globalTemporary)) return;
      if (client.current?.hasPendingClose) { setError("请先确认语音已结束。"); return; }
      setPracticeOpen(true);
    } finally { exitPending.current = false; if (mounted.current) setClosing(false); }
  };

  if (practiceOpen && plan) return <section className="live-dictation-stage" aria-label="对话中准备的听写">
    <header><button className="live-voice-link" disabled={dictationBusy || dictationUnconfirmed} onClick={() => void finish()}><ArrowLeft size={17} />返回对话</button><h2>听写练习</h2></header>
    <Suspense fallback={<p role="status">正在准备听写…</p>}><DictationPanel entries={NO_ENTRIES} preparedPlan={plan} temporary={temporary || learningContextStore.get().temporary} accountScope={learningContextStore.get().memory?.accountScope} contextEpoch={learningContextStore.get().epoch} onLiveActiveChange={setDictationBusy} onLiveUnconfirmedChange={setDictationUnconfirmed} onAttempt={(attempt) => { attempts.current.push(attempt); }} /></Suspense>
  </section>;

  return <section className="voice-stage live-voice-stage" aria-label="语音会话" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); void finish(); }
  }}>
    <header className="voice-top"><span className="voice-title"><AudioLines size={18} aria-hidden="true" />语音会话</span><span className="voice-time">{active ? clock(snapshot.seconds) : temporary ? "临时" : ""}</span></header>
    <div className="voice-lines" ref={captions} onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} aria-live="polite">
      {!turns.length ? <div className="voice-hello"><TraceGlyph size={34} /><p className="voice-greeting">说说今天想练什么</p></div> : <ol className="voice-captions">{turns.map((turn, index) => <li key={`${index}-${turn.role}`} className={`voice-line line-${turn.role === "user" ? "user" : "ai"}${index === latestAi ? " is-latest" : ""}`}><span className="who">{turn.role === "user" ? "你" : "AI"}</span><p>{turn.text}</p></li>)}</ol>}
    </div>
    <div className="voice-bottom">
      <p className="voice-state" role="status"><span className="state-dot" aria-hidden="true" />{statusText}</p>
      {notice && <p className="live-voice-notice" role="alert">{notice}</p>}
      {snapshot.playbackBlocked && <button className="live-voice-link" onClick={() => void client.current?.resumePlayback()}><Play size={16} />开启声音</button>}
      {!active && !status && <button className="live-voice-link" onClick={() => void readStatus()}>重新检查连接</button>}
      {!active && status && !status.ready && <p className="live-voice-notice">{status.configured ? status.reason || "语音服务暂不可用" : "先连接语音服务"} <button className="live-voice-link" onClick={() => { dispatch({ type: "settings-open", section: "model" }); }}><Settings2 size={15} />打开设置</button></p>}
      {!active && status?.ready && !supported && <p className="live-voice-notice">当前浏览器无法使用麦克风，可继续用文字提问。</p>}
      {pendingClose && !active && <button className="live-voice-link" disabled={closing} onClick={() => void retryClose()}>确认结束上次语音</button>}
      {!!plan?.items.length && <button className="live-voice-link" disabled={closing} onClick={() => void openPractice()}>开始准备好的听写 · {plan.items.length} 项</button>}
      <div className="voice-bar">
        <form className="voice-input" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) void finish(typed); }}>
          <label className="visually-hidden" htmlFor="voice-typed">用文字提问</label>
          <input id="voice-typed" value={typed} placeholder="用文字提问" autoComplete="off" onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} />
          <button type="submit" className="voice-send" aria-label="发送文字并返回对话" disabled={!typed.trim() || closing}><ArrowUp size={17} aria-hidden="true" /></button>
        </form>
        {active ? <button className={`voice-round${snapshot.muted ? " is-on" : ""}`} aria-pressed={snapshot.muted} disabled={!connected || closing} aria-label={snapshot.muted ? "开启麦克风" : "麦克风静音"} onClick={() => client.current?.mute(!snapshot.muted)}>{snapshot.muted ? <MicOff size={19} /> : <Mic size={19} />}</button>
          : <button className="voice-round live-voice-start" aria-label="开始语音" title="开始语音" disabled={!status?.ready || pendingClose || !supported || closing} onClick={() => void start()}><Mic size={19} /></button>}
        <button className="voice-round voice-end" aria-label="结束语音会话" title="结束" disabled={closing} onClick={() => void finish()}><X size={20} aria-hidden="true" /></button>
      </div>
    </div>
  </section>;
}
