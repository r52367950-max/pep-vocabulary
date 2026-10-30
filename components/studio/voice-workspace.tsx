"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, Check, Menu, Mic, MicOff, Play, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { learningContextStore, refreshLearningContext, contextStillCurrent } from "@/lib/learning-context-client";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { NativeLiveSession, appendTranscript, feedbackTranscript, readVoiceHistory, saveVoiceRecord, voiceRequest, VOICE_HISTORY_KEY, type TranscriptTurn, type VoiceFeedback, type VoiceRecord, type VoiceSnapshot, type VoiceStatus } from "@/lib/voice/client";
import { VOICE_LEVELS, VOICE_TOPICS, getVoiceTopic, type VoiceLevel } from "@/lib/voice/curriculum";
import { DictationPanel } from "./voice/dictation-panel";
import { LearningMemoryPanel, useLearningMemory } from "./voice/learning-memory";
import { PracticeDiscussion, type DiscussionMessage } from "./voice/practice-discussion";
import { VoiceDialog } from "./voice/voice-dialog";

const INITIAL: VoiceSnapshot = { phase: "idle", message: "准备好就开始", seconds: 0, muted: false, paused: false, playbackBlocked: false, maxSeconds: 600, usageSeconds: null, closeConfirmed: false };
const CAPTIONS_KEY = "pep-vocab-voice-captions-v1";
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
type Plan = { topicId: string; level: VoiceLevel; minutes: number; title: string; goal: string; openingPrompt: string; reason: string };
type RecordMeta = Pick<VoiceRecord, "id" | "createdAt" | "topicId" | "level" | "customTopic" | "goal" | "openingPrompt">;

export default function VoiceWorkspace({ entries, onClose, onOpenSettings, initialTab = "speaking" }: { entries: LexiconIndexEntry[]; onClose: () => void; onOpenSettings: () => void; initialTab?: "speaking" | "dictation" }) {
  const privacy = useSyncExternalStore(learningContextStore.subscribe, learningContextStore.get, learningContextStore.getServerSnapshot);
  const [dictationLive, setDictationLive] = useState(false);
  const [dictationUnconfirmed, setDictationUnconfirmed] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const closePending = useRef(false);
  const startPending = useRef(false);
  const sessionPolicy = useRef<{ scope: string; temporary: boolean; revision: number } | null>(null);
  const previousPolicy = useRef<{ scope: string; temporary: boolean; epoch: number } | null>(null);
  const historyStorage = (scope: string) => ({ getItem: (key: string) => localStorage.getItem(`${key}:${scope}`), setItem: (key: string, value: string) => localStorage.setItem(`${key}:${scope}`, value) });
  const [tab, setTab] = useState<"speaking" | "dictation">(initialTab);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [topicId, setTopicId] = useState("everyday");
  const [level, setLevel] = useState<VoiceLevel>("B1");
  const [minutes, setMinutes] = useState(10);
  const [targets, setTargets] = useState<string[]>([]);
  const [customTopic, setCustomTopic] = useState("");
  const [goal, setGoal] = useState("");
  const [openingPrompt, setOpeningPrompt] = useState("");
  const [captions, setCaptions] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [planNotice, setPlanNotice] = useState("");
  const [panel, setPanel] = useState<"menu" | "settings" | "review" | null>(null);
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(INITIAL);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [discussion, setDiscussion] = useState<DiscussionMessage[]>([]);
  const [feedback, setFeedback] = useState<VoiceFeedback | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [history, setHistory] = useState<VoiceRecord[]>([]);
  const [saved, setSaved] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [deletedRecord, setDeletedRecord] = useState<VoiceRecord | null>(null);
  const memory = useLearningMemory();
  const rememberedTopics = useRef(new Set<string>());
  const mounted = useRef(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const followCaptions = useRef(true);
  const diagnosticRun = useRef(false);
  const client = useRef<NativeLiveSession | null>(null);
  const feedbackAbort = useRef<AbortController | null>(null);
  const statusAbort = useRef<AbortController | null>(null);
  const planAbort = useRef<AbortController | null>(null);
  const planPending = useRef(false);
  const recordMeta = useRef<RecordMeta | null>(null);
  const active = ["connecting", "connected", "closing"].includes(snapshot.phase);
  const connected = snapshot.phase === "connected";
  const topic = getVoiceTopic(topicId);
  const hasPractice = !active && transcript.some((turn) => turn.role === "user" && turn.text.trim());

  const refreshStatus = useCallback(async () => {
    statusAbort.current?.abort(); const abort = new AbortController(); statusAbort.current = abort;
    try { const value = await voiceRequest<VoiceStatus>("/api/voice/status", undefined, abort.signal); if (mounted.current && !abort.signal.aborted) { setStatus(value); setStatusError(""); } }
    catch (error) { if (mounted.current && !abort.signal.aborted) { setStatus(null); setStatusError(error instanceof Error ? error.message : "暂时无法检查语音设置。"); } }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const transport = new NativeLiveSession({ onState: (state) => { if (mounted.current) setSnapshot(state); }, onTranscript: (turn) => { if (mounted.current) setTranscript((current) => appendTranscript(current, turn)); } });
    client.current = transport;
    queueMicrotask(() => { if (mounted.current) { try { setCaptions(localStorage.getItem(CAPTIONS_KEY) !== "hidden"); } catch { setStorageError("当前浏览器不允许保存本机记录。"); } void refreshStatus(); } });
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const stopHidden = () => { void transport.end("离开页面超过 30 秒，语音已停止。可手动开始下一次练习。"); };
    const visibility = () => { clearTimeout(hiddenTimer); if (document.hidden) { hiddenAt = Date.now(); hiddenTimer = setTimeout(stopHidden, 30_000); } else if (hiddenAt && Date.now() - hiddenAt >= 30_000) { hiddenAt = 0; stopHidden(); } };
    const pagehide = () => transport.dispose();
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", pagehide); window.addEventListener("vocab-ai-config-changed", refreshStatus);
    return () => { mounted.current = false; clearTimeout(hiddenTimer); transport.dispose(); statusAbort.current?.abort(); feedbackAbort.current?.abort(); planAbort.current?.abort(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); window.removeEventListener("vocab-ai-config-changed", refreshStatus); };
  }, [refreshStatus]);
  useEffect(() => { if (["ended", "error"].includes(snapshot.phase)) queueMicrotask(() => { if (mounted.current) void refreshStatus(); }); }, [snapshot.phase, snapshot.closeConfirmed, refreshStatus]);
  useEffect(() => {
    const policy = sessionPolicy.current;
    if (!policy || policy.temporary || privacy.temporary || !privacy.memory || policy.scope !== privacy.memory.accountScope || !["ended", "error"].includes(snapshot.phase) || !recordMeta.current || !transcript.length || saved) return;
    const record: VoiceRecord = { ...recordMeta.current, contextRevision: policy.revision, seconds: snapshot.seconds, transcript, discussion, ...(feedback ? { feedback } : {}) };
    try { setHistory(saveVoiceRecord(historyStorage(policy.scope), record)); setSaved(true); setStorageError(""); }
    catch { setStorageError("此浏览器暂时无法保存记录，请在离开前复制需要的文字。"); }
  }, [snapshot.phase, snapshot.seconds, transcript, saved, feedback, discussion, privacy.temporary, privacy.memory]);
  useEffect(() => {
    const meta = recordMeta.current;
    if (privacy.temporary || !hasPractice || !meta || !memory.memory?.enabled || memory.busy || rememberedTopics.current.has(meta.id)) return;
    rememberedTopics.current.add(meta.id);
    void memory.rememberTopic((meta.customTopic || getVoiceTopic(meta.topicId).title).slice(0, 160));
  }, [hasPractice, memory.memory, memory.busy, memory.rememberTopic, privacy.temporary]);
  useEffect(() => {
    if (!active || !captions || !followCaptions.current) return;
    const stage = stageRef.current;
    if (stage) stage.scrollTop = stage.scrollHeight;
  }, [active, captions, transcript]);
  useEffect(() => {
    const current = { scope: privacy.memory?.accountScope || "", temporary: privacy.temporary, epoch: privacy.epoch };
    const previous = previousPolicy.current;
    previousPolicy.current = current;
    if (previous && previous.epoch !== current.epoch) {
      void client.current?.end("学习记忆或隐私设置已改变，本机语音已停止。请确认关闭后重新开始。");
      feedbackAbort.current?.abort(); planAbort.current?.abort(); planPending.current = false;
      setFeedbackBusy(false); setPlanBusy(false); setPlans([]); setFeedback(null); setDiscussion([]); setSaved(true);
      if (previous.scope !== current.scope || previous.temporary !== current.temporary) {
        recordMeta.current = null; sessionPolicy.current = null;
        setTranscript([]); setRecordId(null); setHistory([]); setDeletedRecord(null);
        setCustomTopic(""); setGoal(""); setOpeningPrompt(""); setTargets([]);
      }
    }
    if (current.scope && !current.temporary) {
      try { setHistory(readVoiceHistory(historyStorage(current.scope))); } catch { setStorageError("无法读取本机练习记录。"); }
    } else setHistory([]);
  }, [privacy.epoch, privacy.temporary, privacy.memory?.accountScope]);
  useEffect(() => {
    if (!active && !dictationLive) return;
    const check = () => { void refreshLearningContext().catch(() => undefined); };
    const timer = setInterval(check, 10_000);
    const visible = () => { if (!document.hidden) check(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, [active, dictationLive]);
  const end = () => client.current?.end();
  const closePanel = () => setPanel(null);
  const exit = async () => {
    if (dictationLive || dictationUnconfirmed) { setPanel(null); setStatusError("请先在听写中结束 Live，并确认关闭后返回。"); return; }
    await client.current?.end();
    if (client.current?.hasPendingClose) { setPanel(null); await refreshStatus(); return; }
    onClose();
  };
  const changeCaptions = (show: boolean) => {
    if (show) followCaptions.current = true;
    setCaptions(show);
    try { localStorage.setItem(CAPTIONS_KEY, show ? "shown" : "hidden"); }
    catch { /* The preference remains usable for this session. */ }
  };
  const start = async (diagnostic = false, retry?: { customTopic: string; goal: string; openingPrompt: string }) => {
    if (startPending.current || active || dictationLive || dictationUnconfirmed || closePending.current || client.current?.hasPendingClose || statusError) return;
    startPending.current = true;
    try {
    let context;
    const temporary = learningContextStore.get().temporary;
    try { context = await refreshLearningContext(); } catch { return; }
    if (!contextStillCurrent(context, temporary)) return;
    sessionPolicy.current = { scope: context.accountScope, temporary, revision: context.revision };
    setTab("speaking");
    setPanel(null);
    followCaptions.current = true;
    diagnosticRun.current = diagnostic;
    feedbackAbort.current?.abort(); planAbort.current?.abort(); planPending.current = false; setPlanBusy(false); setFeedbackBusy(false); setFeedbackError("");
    setTranscript([]); setTranscriptRevision(0); setDiscussion([]); setFeedback(null); setSaved(false); setStorageError("");
    const task = retry ?? { customTopic, goal, openingPrompt };
    if (retry) { setCustomTopic(retry.customTopic); setGoal(retry.goal); setOpeningPrompt(retry.openingPrompt); }
    const meta: RecordMeta = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), topicId, level, ...task }; recordMeta.current = diagnostic ? null : meta; setRecordId(diagnostic ? null : meta.id);
    await client.current?.start({ topicId, level, minutes, targetWords: targets, temporary, accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion, ...task, ...(diagnostic ? { diagnostic: true } : {}) });
    } finally { startPending.current = false; }
  };
  const recommend = async () => {
    if (planPending.current || active) return;
    planAbort.current?.abort(); const abort = new AbortController(); planAbort.current = abort; planPending.current = true; setPlanBusy(true); setPlanError(""); setPlanNotice("");
    try {
      const context = await refreshLearningContext(abort.signal); const temporary = learningContextStore.get().temporary;
      const result = await voiceRequest<{ recommendations: Plan[] }>("/api/voice/recommend", { topicId, level, minutes, customTopic, temporary, accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion }, abort.signal);
      await refreshLearningContext(abort.signal);
      if (mounted.current && !abort.signal.aborted && contextStillCurrent(context, temporary)) setPlans(result.recommendations);
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setPlanError(cause instanceof Error ? cause.message : "推荐暂时未完成。仍可自己设置并开始。"); }
    finally { if (planAbort.current === abort) planPending.current = false; if (mounted.current && !abort.signal.aborted) setPlanBusy(false); }
  };
  const applyPlan = (plan: Plan) => { if (active) return; setTopicId(plan.topicId); setLevel(plan.level); setMinutes(plan.minutes); setCustomTopic(plan.title); setGoal(plan.goal); setOpeningPrompt(plan.openingPrompt); setPlans([]); setPlanNotice(`已选：${plan.title}。仍可修改设置，准备好再开始。`); };
  const requestFeedback = async () => {
    if (!hasPractice || feedbackBusy) return;
    feedbackAbort.current?.abort(); const abort = new AbortController(); feedbackAbort.current = abort;
    setFeedbackBusy(true); setFeedbackError("");
    try {
      const context = await refreshLearningContext(abort.signal); const temporary = learningContextStore.get().temporary;
      const result = await voiceRequest<VoiceFeedback>("/api/voice/feedback", { topicId: recordMeta.current?.topicId || topicId, level: recordMeta.current?.level || level, transcript: feedbackTranscript(transcript), temporary, accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion }, abort.signal);
      await refreshLearningContext(abort.signal);
      if (!mounted.current || abort.signal.aborted || !contextStillCurrent(context, temporary)) return;
      setFeedback(result); setSaved(false);
    } catch (error) { if (mounted.current && !abort.signal.aborted) setFeedbackError(error instanceof Error ? error.message : "反馈暂时未完成。"); }
    finally { if (mounted.current && !abort.signal.aborted) setFeedbackBusy(false); }
  };
  const openRecord = (record: VoiceRecord) => {
    if (active || dictationLive || privacy.temporary || !privacy.memory) return;
    sessionPolicy.current = { scope: privacy.memory.accountScope, temporary: false, revision: privacy.memory.revision };
    diagnosticRun.current = false;
    setTab("speaking"); setPanel(null);
    feedbackAbort.current?.abort(); planAbort.current?.abort(); planPending.current = false; setPlanBusy(false); setFeedbackBusy(false); setFeedbackError(""); setRecordId(record.id); recordMeta.current = { id: record.id, createdAt: record.createdAt, topicId: record.topicId, level: record.level, customTopic: record.customTopic, goal: record.goal, openingPrompt: record.openingPrompt };
    rememberedTopics.current.add(record.id);
    setTopicId(record.topicId); setLevel(VOICE_LEVELS.some((item) => item.id === record.level) ? record.level as VoiceLevel : "B1"); setCustomTopic(record.customTopic || ""); setGoal(record.goal || ""); setOpeningPrompt(record.openingPrompt || ""); setTranscript(record.transcript); setTranscriptRevision((value) => value + 1); setDiscussion(record.contextRevision === privacy.memory.revision ? record.discussion || [] : []); setFeedback(record.contextRevision === privacy.memory.revision ? record.feedback || null : null); setSaved(true); setSnapshot({ ...INITIAL, phase: "ended", seconds: record.seconds, message: "已打开本机练习记录。" });
  };
  const availableTargets = entries.filter((entry) => !entry.flags.properName && entry.headword.length < 25).slice(0, 18);
  const transportSupported = typeof window !== "undefined" && window.isSecureContext && !!window.RTCPeerConnection;
  const browserSupported = transportSupported && !!navigator.mediaDevices?.getUserMedia;
  const canConnect = Boolean(privacy.memory && !privacy.error && status?.ready && !status.activeSession && !active && !dictationLive && !dictationUnconfirmed && !statusError && !closeBusy && !client.current?.hasPendingClose && transportSupported);
  const canStart = canConnect && browserSupported;
  const isDiagnostic = diagnosticRun.current;
  const remembered = memory.memory?.notes.map((note) => note.text) || [];

  const switchTab = (next: "speaking" | "dictation") => {
    if (active || dictationLive || dictationUnconfirmed) return;
    setTab(next);
    setPanel(null);
  };
  const deleteRecord = (record: VoiceRecord) => {
    if (active || privacy.temporary || !privacy.memory) return;
    const next = history.filter((row) => row.id !== record.id);
    try {
      historyStorage(privacy.memory.accountScope).setItem(VOICE_HISTORY_KEY, JSON.stringify(next));
      setHistory(next);
      setDeletedRecord(record);
      if (recordId === record.id) {
        feedbackAbort.current?.abort();
        recordMeta.current = null;
        setRecordId(null);
        setTranscript([]);
        setDiscussion([]);
        setFeedback(null);
      }
    } catch { setStorageError("删除未完成，请重试。"); }
  };
  const restoreRecord = () => {
    if (active || !deletedRecord || privacy.temporary || !privacy.memory) return;
    try { setHistory(saveVoiceRecord(historyStorage(privacy.memory.accountScope), deletedRecord)); setDeletedRecord(null); }
    catch { setStorageError("恢复未完成，请重试。"); }
  };
  const openAISettings = () => {
    if (active) return;
    setPanel(null);
    onOpenSettings();
  };
  const retryPractice = () => {
    if (active || !feedback || !canStart) return;
    void start(false, {
      customTopic: recordMeta.current?.customTopic || topic.title,
      goal: `练习刚才的表达改进：${feedback.improvements.map((item) => item.suggestion).join("；")}`.slice(0, 600),
      openingPrompt: feedback.retryPrompt,
    });
  };
  const sessionTitle = isDiagnostic ? "连接测试" : customTopic || topic.title;
  const shortStatus = snapshot.phase === "closing" ? "正在结束…"
    : snapshot.phase === "connecting" ? "正在连接…"
    : connected ? isDiagnostic ? "Live 已连接" : snapshot.muted ? "麦克风已静音" : "对话进行中"
    : hasPractice ? "练习回顾"
    : !status && !statusError ? "正在检查语音设置…" : "";
  const sessionNotice = snapshot.phase === "error" || /未能|尚未/.test(snapshot.message)
    ? snapshot.message
    : !active && isDiagnostic && snapshot.phase === "ended" ? snapshot.message : "";

  return (
    <div className={`learn-screen voice-screen ${active ? "voice-screen-active" : ""}`} data-phase={snapshot.phase} data-muted={snapshot.muted}>
      <header className="voice-header">
        <button className="voice-icon-button" onClick={() => setPanel("menu")} aria-label="打开记录与返回" title="记录与返回">
          <Menu size={24} />
        </button>
        {active ? <span className="voice-header-title">口语练习</span> : (
          <nav className="voice-mode-switch" aria-label="练习方式">
            <button aria-pressed={tab === "speaking"} onClick={() => switchTab("speaking")}>口语</button>
            <button aria-pressed={tab === "dictation"} onClick={() => switchTab("dictation")}>听写</button>
          </nav>
        )}
        <button className="voice-icon-button" onClick={() => setPanel("settings")} aria-label="打开练习设置" title="练习设置">
          <Settings2 size={23} />
        </button>
      </header>

      <main ref={stageRef} onScroll={(event) => { const stage = event.currentTarget; followCaptions.current = stage.scrollHeight - stage.clientHeight - stage.scrollTop < 100; }} className={`voice-stage voice-stage-${tab} ${active && captions ? "has-captions" : ""} ${hasPractice && tab === "speaking" ? "has-review" : ""}`}>
        <section className="voice-speaking-stage" hidden={tab !== "speaking"} aria-label="口语练习">
          {active && captions ? (
            <div className="voice-conversation-feed" aria-label="实时对话文字">
              {transcript.length ? transcript.map((turn, index) => (
                <div className={`voice-caption-line ${turn.role}`} key={`${index}-${turn.role}`}>
                  <span className="voice-speaker-label">{turn.role === "user" ? "你" : "英语伙伴"}</span>
                  <p lang="en">{turn.text}</p>
                </div>
              )) : <p className="voice-caption-empty">可以开始说话了。</p>}
            </div>
          ) : !hasPractice ? (
            <div className="voice-centered-scene">
              <div className="voice-orb" aria-hidden="true"><i /><i /><i /></div>
              <h1>{sessionTitle}</h1>
              <p>{level} · {minutes} 分钟</p>
            </div>
          ) : null}

          {hasPractice && (
            <div className="voice-after-session">
              <div className="voice-review-heading">
                <span>{recordMeta.current?.customTopic || getVoiceTopic(recordMeta.current?.topicId || topicId).title} · {time(snapshot.seconds)}</span>
                <button className="text-button" onClick={() => setPanel("review")}>转写与反馈 <ArrowRight size={15} /></button>
              </div>
              <PracticeDiscussion
                key={`${recordId}-${transcriptRevision}-${privacy.epoch}`}
                sessionKey={recordId || "practice"}
                topicId={recordMeta.current?.topicId || topicId}
                level={recordMeta.current?.level || level}
                transcript={transcript}
                messages={discussion}
                onChange={(messages) => { setDiscussion(messages); setSaved(false); }}
                configured={Boolean(status?.configured && privacy.memory && !privacy.error)}
                temporary={privacy.temporary}
                onRemember={memory.remember}
                remembered={remembered}
                memoryBusy={memory.busy}
              />
              {storageError && <p role="alert" className="voice-inline-error">{storageError}</p>}
            </div>
          )}
        </section>
        <section className="voice-dictation-stage" hidden={tab !== "dictation"} aria-label="词句听写">
          <DictationPanel entries={entries} active={tab === "dictation"} temporary={privacy.temporary} accountScope={privacy.memory?.accountScope} contextEpoch={privacy.epoch} learningPreferences={{ preferredSpeed: privacy.memory?.enabled && !privacy.temporary ? (privacy.memory.notes.find((note) => note.id === "dictation-speed")?.text === "听写默认使用慢速朗读。" ? "slow" : "normal") : undefined }} onLiveActiveChange={setDictationLive} onLiveUnconfirmedChange={setDictationUnconfirmed} />
        </section>
      </main>

      {tab === "speaking" && (
        <footer className="voice-footer">
          {active && captions && <div className="voice-orb voice-orb-small" aria-hidden="true"><i /><i /><i /></div>}
          <div className="voice-status-line">
            {shortStatus && <span role="status" aria-live="polite">{shortStatus}</span>}
            {active && <span aria-live="off">{time(snapshot.seconds)} / {time(snapshot.maxSeconds)}</span>}
          </div>
          <div className="voice-session-notices">
            {privacy.temporary && <p className="voice-muted">临时练习 · 不使用历史记忆，不保存本次记录</p>}
            {privacy.error && <p className="voice-inline-error" role="alert">{privacy.error} <button className="text-button" onClick={() => void memory.load()}>重新读取记忆设置</button></p>}
            {snapshot.playbackBlocked && (
              <button className="text-button voice-recovery" onClick={() => void client.current?.resumePlayback()}>
                <Play size={16} />点此开启声音
              </button>
            )}
            {sessionNotice && <p className="voice-inline-error" role="status">{sessionNotice}</p>}
            {!active && statusError && (
              <p className="voice-inline-error">{statusError} <button className="text-button" onClick={() => void refreshStatus()}>重新检查</button></p>
            )}
            {!active && (status?.activeSession || client.current?.hasPendingClose) && (
              <div className="voice-recovery">
                <p>上次语音还未确认结束。</p>
                <button className="text-button" disabled={closeBusy} onClick={async () => {
                  if (closePending.current) return; closePending.current = true; setCloseBusy(true);
                  try { if (client.current?.hasPendingClose) await client.current.retryClose(); else if (status?.activeSession) await voiceRequest("/api/voice/close", { sessionId: status.activeSession.sessionId }); await refreshStatus(); }
                  catch (error) { setStatusError(error instanceof Error ? error.message : "关闭未确认，请稍后重试。"); }
                  finally { closePending.current = false; if (mounted.current) setCloseBusy(false); }
                }}>{closeBusy ? "正在确认关闭…" : "关闭上次语音"}</button>
              </div>
            )}
            {!active && !statusError && status && !status.ready && (
              <p className="voice-inline-error">
                {!status.configured ? "保存 API key 后即可开始。" : status.reason || "语音服务暂未就绪。"}
                <button className="text-button" onClick={() => setPanel("settings")}>查看设置</button>
              </p>
            )}
            {!active && status?.ready && !browserSupported && <p className="voice-inline-error">请用支持麦克风的新版 Safari 或 Chrome 打开正式站点。</p>}
          </div>
          <div className="voice-bottom-actions">
            {active ? (
              <>
                <button
                  className="voice-round-control"
                  disabled={!connected || isDiagnostic}
                  aria-pressed={snapshot.muted}
                  aria-label={snapshot.muted ? "开启麦克风" : "麦克风静音"}
                  title={snapshot.muted ? "开启麦克风" : "麦克风静音"}
                  onClick={() => client.current?.mute(!snapshot.muted)}
                >
                  {snapshot.muted ? <MicOff size={25} /> : <Mic size={25} />}
                </button>
                <button
                  className="voice-round-control voice-stop-control"
                  disabled={snapshot.phase === "closing"}
                  aria-label={snapshot.phase === "connecting" ? "取消连接" : "结束对话"}
                  title={snapshot.phase === "connecting" ? "取消连接" : "结束对话"}
                  onClick={() => void end()}
                >
                  <X size={26} />
                </button>
              </>
            ) : (
              <button className="primary voice-start" disabled={!canStart} onClick={() => void start()}>
                <Mic size={20} />{hasPractice ? "开始新的对话" : "开始对话"}
              </button>
            )}
          </div>
        </footer>
      )}

      <VoiceDialog open={panel !== null} title={panel === "menu" ? "练习记录" : panel === "review" ? "转写与反馈" : "练习设置"} onClose={closePanel}>
        <section hidden={panel !== "menu"}>
          <nav className="voice-menu-list" aria-label="练习导航">
            <button onClick={() => void exit()}><ArrowLeft size={19} /><span>{active ? "结束并返回词迹" : "返回词迹"}</span></button>
            {hasPractice && <button disabled={active} onClick={() => setPanel("review")}><ArrowRight size={19} /><span>转写与反馈</span></button>}
          </nav>
          <section className="voice-history" aria-label="最近练习">
            <h3>最近练习</h3>
            {active && <p className="voice-muted">结束当前通话后，可以打开其他记录。</p>}
            {history.length ? (
              <ul>{history.map((record) => (
                <li key={record.id}>
                  <button disabled={active} aria-current={recordId === record.id ? "true" : undefined} onClick={() => openRecord(record)}>
                    <span>{record.customTopic || getVoiceTopic(record.topicId).title}<small>{record.level} · {time(record.seconds)} · {new Date(record.createdAt).toLocaleDateString("zh-CN")}</small></span>
                    <ArrowRight size={16} />
                  </button>
                  <button className="voice-icon-button" disabled={active} aria-label="删除这次口语记录" title="删除这次记录" onClick={() => deleteRecord(record)}><Trash2 size={17} /></button>
                </li>
              ))}</ul>
            ) : <p className="voice-muted">还没有练习记录。</p>}
            {deletedRecord && <p className="voice-muted" role="status">记录已删除。<button className="text-button" disabled={active} onClick={restoreRecord}>撤销</button></p>}
            {storageError && <p className="voice-inline-error" role="alert">{storageError}</p>}
            <p className="voice-muted">{privacy.temporary ? "临时练习不读取或保存练习记录。" : "当前账户的最近 12 次转写与复盘仅保存在此浏览器，不含录音、不自动上传。旧版未分账户记录保留在本机，不自动归入当前账户。"}</p>
          </section>
        </section>

        <section hidden={panel !== "settings"}>
          <label className="voice-setting-row">
            <span>显示对话文字<small>关闭后专注听说，结束后仍可查看转写。</small></span>
            <input type="checkbox" checked={captions} onChange={(event) => changeCaptions(event.target.checked)} />
          </label>
          <section className="voice-settings-section" aria-label="练习安排">
            <div className="voice-section-heading">
              <h3>练习安排</h3>
              <button className="text-button" disabled={active || dictationLive || planBusy || !status?.configured || !privacy.memory || !!privacy.error} onClick={() => void recommend()}><Sparkles size={16} />{planBusy ? "正在推荐…" : "AI 推荐"}</button>
            </div>
            {active && <p className="voice-muted">当前通话的安排保持不变，结束后可调整。</p>}
            {planError && <p className="voice-inline-error" role="alert">{planError}</p>}
            {planNotice && <p className="voice-muted" role="status">{planNotice}</p>}
            {plans.length > 0 && (
              <div className="voice-plan-list">
                {plans.map((plan, index) => (
                  <button disabled={active} key={`${plan.title}-${index}`} onClick={() => applyPlan(plan)}>
                    <span><strong>{plan.title}</strong><small>{plan.level} · {plan.minutes} 分钟</small><p>{plan.goal}</p><small>{plan.reason}</small></span>
                    <ArrowRight size={18} />
                  </button>
                ))}
              </div>
            )}
            <fieldset className="voice-manual-content" disabled={active}>
              <legend className="learn-sr">手动设置练习</legend>
              <label>话题
                <select value={topicId} onChange={(event) => { setTopicId(event.target.value); setCustomTopic(""); setGoal(""); setOpeningPrompt(""); setPlanNotice(""); }}>
                  {VOICE_TOPICS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
              </label>
              <div className="voice-select-row">
                <label>难度
                  <select value={level} onChange={(event) => setLevel(event.target.value as VoiceLevel)}>
                    {VOICE_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                  </select>
                </label>
                <label>时长
                  <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
                    {[5, 10, 15, 20].map((value) => <option key={value} value={value}>{value} 分钟</option>)}
                  </select>
                </label>
              </div>
              <label>自己的话题 <span className="voice-muted">可选</span>
                <textarea rows={2} maxLength={600} value={customTopic} placeholder="例如：聊一本刚读完的书。" onChange={(event) => { setCustomTopic(event.target.value); setOpeningPrompt(""); setGoal(""); setPlanNotice(""); }} />
              </label>
              <label>想练什么 <span className="voice-muted">可选</span>
                <input maxLength={600} value={goal} placeholder="例如：说明观点，再给出一个例子。" onChange={(event) => setGoal(event.target.value)} />
              </label>
              <details className="voice-targets voice-disclosure">
                <summary><span>带几个词去聊天</span><span>{targets.length}/5</span></summary>
                <div>{availableTargets.map((entry) => (
                  <button key={entry.id} aria-pressed={targets.includes(entry.headword)} onClick={() => setTargets((current) => current.includes(entry.headword) ? current.filter((word) => word !== entry.headword) : current.length < 5 ? [...current, entry.headword] : current)}>{entry.headword}</button>
                ))}</div>
              </details>
            </fieldset>
          </section>
          <LearningMemoryPanel controls={memory} disabled={active || dictationLive} />
          <details className="voice-connection-details voice-disclosure">
            <summary><span>用量与连接</span><span>{typeof status?.remainingSeconds === "number" ? `今日可预留 ${Math.floor(status.remainingSeconds / 60)} 分钟` : "查看详情"}</span></summary>
            <div>
              <p className="voice-muted">本次语音估计 ${(Math.max(snapshot.seconds, snapshot.usageSeconds || 0) / 60 * .05).toFixed(3)}。GPT-Live 语音约 $0.05/分钟，文字模型和复盘另计。静音仍计费；应用预留整段时长，提前结束不退还应用额度，它不是实际账单或绝对费用上限。</p>
              <button className="text-button" disabled={!canConnect} onClick={() => void start(true)}>测试 Live 连接（无需麦克风）</button>
              <p className="voice-muted">约 20 秒自动结束，会使用少量 API 额度。实际收音仍需麦克风。</p>
            </div>
          </details>
          <button className="voice-settings-link" disabled={active} onClick={openAISettings}><Settings2 size={18} /><span>API 与模型设置</span><ArrowRight size={17} /></button>
        </section>

        <section hidden={panel !== "review"}>
          <section className="voice-feedback" aria-label="表达反馈">
            <div className="voice-section-heading">
              <h3>表达反馈</h3>
              <button className="text-button" disabled={active || !hasPractice || feedbackBusy || !status?.configured || !privacy.memory || !!privacy.error} onClick={() => void requestFeedback()}><Sparkles size={16} />{feedbackBusy ? "正在整理…" : feedback ? "重新整理" : "整理反馈"}</button>
            </div>
            <p className="voice-muted">先检查转写。文字反馈不能评定发音或口音。</p>
            {feedbackError && <p role="alert" className="voice-inline-error">{feedbackError}</p>}
            {feedback && (
              <>
                <p>{feedback.strength}</p>
                {feedback.improvements.map((item, index) => (
                  <div className="voice-correction" key={index}>
                    <p lang="en">{item.original}</p>
                    <strong lang="en">{item.suggestion}</strong>
                    <small>{item.reason}</small>
                  </div>
                ))}
                <div className="voice-retry">
                  <p lang="en">{feedback.retryPrompt}</p>
                  <button className="primary" disabled={!canStart} onClick={retryPractice}><Mic size={16} />再说一次</button>
                </div>
                {feedback.expressions.length > 0 && (
                  <div className="voice-expressions">
                    {feedback.expressions.map((expression, index) => {
                      const note = `练习表达：${expression.text} — ${expression.meaning}`.slice(0, 400);
                      const included = remembered.includes(note);
                      return (
                        <button key={index} disabled={included || memory.busy || !memory.memory} onClick={() => void memory.remember(note)}>
                          <span><strong lang="en">{expression.text}</strong><small>{expression.meaning}</small></span>
                          <span>{included ? <Check size={17} /> : "记住"}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            {memory.error && <p className="voice-inline-error">{memory.error}</p>}
          </section>
          <details className="voice-transcript voice-disclosure">
            <summary><span>完整转写</span><span>{transcript.length ? "可修正识别错误" : "暂无转写"}</span></summary>
            {transcript.length ? (
              <div className="voice-transcript-list">
                {transcript.map((turn, index) => (
                  <label key={`${index}-${turn.role}`} className={`voice-turn ${turn.role}`}>
                    <span>{turn.role === "user" ? "你" : "英语伙伴"}</span>
                    <textarea
                      aria-label={`${turn.role === "user" ? "你的" : "英语伙伴的"}第 ${index + 1} 段转写`}
                      lang="en" value={turn.text} maxLength={3000} disabled={active}
                      onChange={(event) => {
                        if (active) return;
                        feedbackAbort.current?.abort();
                        setFeedbackBusy(false); setFeedbackError("");
                        setTranscript((current) => current.map((row, i) => i === index ? { ...row, text: event.target.value } : row));
                        setTranscriptRevision((value) => value + 1);
                        setFeedback(null); setDiscussion([]); setSaved(false);
                      }}
                    />
                  </label>
                ))}
              </div>
            ) : <p className="voice-muted">练习结束后，可在这里查看文字。</p>}
          </details>
          {saved && <p className="voice-muted">本次转写与复盘已保存在此浏览器；学习记忆另存于账号。</p>}
        </section>
      </VoiceDialog>
    </div>
  );
}
