"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Clock3, Headphones, Mic, MicOff, Pause, Play, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { NativeLiveSession, appendTranscript, feedbackTranscript, readVoiceHistory, saveVoiceRecord, voiceRequest, VOICE_HISTORY_KEY, type TranscriptTurn, type VoiceFeedback, type VoiceRecord, type VoiceSnapshot, type VoiceStatus } from "@/lib/voice/client";
import { VOICE_LEVELS, VOICE_TOPICS, getVoiceTopic, type VoiceLevel } from "@/lib/voice/curriculum";
import { DictationPanel } from "./voice/dictation-panel";
import { LearningMemoryPanel, useLearningMemory } from "./voice/learning-memory";
import { PracticeDiscussion, type DiscussionMessage } from "./voice/practice-discussion";

const INITIAL: VoiceSnapshot = { phase: "idle", message: "准备好就开始", seconds: 0, muted: false, paused: false, playbackBlocked: false, maxSeconds: 600, usageSeconds: null, closeConfirmed: false };
const CAPTIONS_KEY = "pep-vocab-voice-captions-v1";
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
type Plan = { topicId: string; level: VoiceLevel; minutes: number; title: string; goal: string; openingPrompt: string; reason: string };
type RecordMeta = Pick<VoiceRecord, "id" | "createdAt" | "topicId" | "level" | "customTopic" | "goal" | "openingPrompt">;

export default function VoiceWorkspace({ entries, onClose, onOpenSettings, initialTab = "speaking" }: { entries: LexiconIndexEntry[]; onClose: () => void; onOpenSettings: () => void; initialTab?: "speaking" | "dictation" }) {
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
  const [showNextSetup, setShowNextSetup] = useState(false);
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
    catch (error) { if (mounted.current && !abort.signal.aborted) setStatusError(error instanceof Error ? error.message : "暂时无法检查语音设置。"); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const transport = new NativeLiveSession({ onState: (state) => { if (mounted.current) setSnapshot(state); }, onTranscript: (turn) => { if (mounted.current) setTranscript((current) => appendTranscript(current, turn)); } });
    client.current = transport;
    queueMicrotask(() => { if (mounted.current) { try { setHistory(readVoiceHistory(localStorage)); setCaptions(localStorage.getItem(CAPTIONS_KEY) !== "hidden"); } catch { setStorageError("当前浏览器不允许保存本机记录。"); } void refreshStatus(); } });
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
    if (!["ended", "error"].includes(snapshot.phase) || !recordMeta.current || !transcript.length || saved) return;
    const record: VoiceRecord = { ...recordMeta.current, seconds: snapshot.seconds, transcript, discussion, ...(feedback ? { feedback } : {}) };
    try { setHistory(saveVoiceRecord(localStorage, record)); setSaved(true); setStorageError(""); }
    catch { setStorageError("此浏览器暂时无法保存记录，请在离开前复制需要的文字。"); }
  }, [snapshot.phase, snapshot.seconds, transcript, saved, feedback, discussion]);
  useEffect(() => {
    const meta = recordMeta.current;
    if (!hasPractice || !meta || !memory.memory?.enabled || memory.busy || rememberedTopics.current.has(meta.id)) return;
    rememberedTopics.current.add(meta.id);
    void memory.rememberTopic((meta.customTopic || getVoiceTopic(meta.topicId).title).slice(0, 160));
  }, [hasPractice, memory.memory, memory.busy, memory.rememberTopic]);
  const end = () => client.current?.end();
  const exit = () => { client.current?.dispose(); onClose(); };
  const changeCaptions = (show: boolean) => { setCaptions(show); try { localStorage.setItem(CAPTIONS_KEY, show ? "shown" : "hidden"); } catch { /* The preference remains usable for this session. */ } };
  const start = async (diagnostic = false, retry?: { customTopic: string; goal: string; openingPrompt: string }) => {
    feedbackAbort.current?.abort(); planAbort.current?.abort(); planPending.current = false; setPlanBusy(false); setFeedbackBusy(false); setFeedbackError("");
    setTranscript([]); setTranscriptRevision(0); setDiscussion([]); setShowNextSetup(false); setFeedback(null); setSaved(false); setStorageError("");
    const task = retry ?? { customTopic, goal, openingPrompt };
    if (retry) { setCustomTopic(retry.customTopic); setGoal(retry.goal); setOpeningPrompt(retry.openingPrompt); }
    const meta: RecordMeta = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), topicId, level, ...task }; recordMeta.current = diagnostic ? null : meta; setRecordId(diagnostic ? null : meta.id);
    await client.current?.start({ topicId, level, minutes, targetWords: targets, ...task, ...(diagnostic ? { diagnostic: true } : {}) });
  };
  const recommend = async () => {
    if (planPending.current || active) return;
    planAbort.current?.abort(); const abort = new AbortController(); planAbort.current = abort; planPending.current = true; setPlanBusy(true); setPlanError(""); setPlanNotice("");
    try {
      const result = await voiceRequest<{ recommendations: Plan[] }>("/api/voice/recommend", { topicId, level, minutes, customTopic }, abort.signal);
      if (mounted.current && !abort.signal.aborted) setPlans(result.recommendations);
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setPlanError(cause instanceof Error ? cause.message : "推荐暂时未完成。仍可自己设置并开始。"); }
    finally { if (planAbort.current === abort) planPending.current = false; if (mounted.current && !abort.signal.aborted) setPlanBusy(false); }
  };
  const applyPlan = (plan: Plan) => { setTopicId(plan.topicId); setLevel(plan.level); setMinutes(plan.minutes); setCustomTopic(plan.title); setGoal(plan.goal); setOpeningPrompt(plan.openingPrompt); setPlans([]); setPlanNotice(`已选：${plan.title}。仍可修改设置，准备好再开始。`); };
  const requestFeedback = async () => {
    if (!hasPractice || feedbackBusy) return;
    feedbackAbort.current?.abort(); const abort = new AbortController(); feedbackAbort.current = abort;
    setFeedbackBusy(true); setFeedbackError("");
    try {
      const result = await voiceRequest<VoiceFeedback>("/api/voice/feedback", { topicId: recordMeta.current?.topicId || topicId, level: recordMeta.current?.level || level, transcript: feedbackTranscript(transcript) }, abort.signal);
      if (!mounted.current || abort.signal.aborted) return;
      setFeedback(result); setSaved(false);
    } catch (error) { if (mounted.current && !abort.signal.aborted) setFeedbackError(error instanceof Error ? error.message : "反馈暂时未完成。"); }
    finally { if (mounted.current && !abort.signal.aborted) setFeedbackBusy(false); }
  };
  const openRecord = (record: VoiceRecord) => {
    feedbackAbort.current?.abort(); planAbort.current?.abort(); planPending.current = false; setPlanBusy(false); setFeedbackBusy(false); setFeedbackError(""); setRecordId(record.id); recordMeta.current = { id: record.id, createdAt: record.createdAt, topicId: record.topicId, level: record.level, customTopic: record.customTopic, goal: record.goal, openingPrompt: record.openingPrompt };
    rememberedTopics.current.add(record.id);
    setTopicId(record.topicId); setLevel(VOICE_LEVELS.some((item) => item.id === record.level) ? record.level as VoiceLevel : "B1"); setCustomTopic(record.customTopic || ""); setGoal(record.goal || ""); setOpeningPrompt(record.openingPrompt || ""); setTranscript(record.transcript); setTranscriptRevision((value) => value + 1); setDiscussion(record.discussion || []); setFeedback(record.feedback || null); setSaved(true); setSnapshot({ ...INITIAL, phase: "ended", seconds: record.seconds, message: "已打开本机练习记录。" });
  };
  const availableTargets = entries.filter((entry) => !entry.flags.properName && entry.headword.length < 25).slice(0, 18);
  const browserSupported = typeof window !== "undefined" && window.isSecureContext && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;
  const canStart = Boolean(status?.ready && !status.activeSession && !active && browserSupported);
  const isDiagnostic = active && !recordMeta.current;
  const remembered = memory.memory?.notes.map((note) => note.text) || [];

  return <div className={`learn-screen voice-screen ${active ? "voice-screen-active" : ""}`}>
    <header className="voice-header"><button className="icon-button" onClick={exit} aria-label="退出听说练习"><X size={22} /></button><span className="learn-header-title">听说练习</span><button className="icon-button" onClick={() => { client.current?.dispose(); onOpenSettings(); }} aria-label="打开 AI 设置"><Settings2 size={20} /></button></header>
    <main className="voice-stage">
      {!active && <><div className="voice-intro"><h1>{tab === "speaking" ? hasPractice ? "聊聊这次的收获。" : "今天，聊点什么？" : "听清，也记住。"}</h1><p>{tab === "speaking" ? hasPractice ? "追问一个表达，或把想继续练的内容记下来。" : "选一个话题开始，也可以让 AI 帮你安排。" : "从单词到句子，按自己的节奏练习。"}</p></div><div className="voice-tabs" role="tablist" aria-label="练习类型"><button role="tab" id="speaking-tab" aria-selected={tab === "speaking"} aria-controls="speaking-panel" onClick={() => setTab("speaking")}><Mic size={17} />口语对话</button><button role="tab" id="dictation-tab" aria-selected={tab === "dictation"} aria-controls="dictation-panel" onClick={() => setTab("dictation")}><Headphones size={17} />词句听写</button></div></>}
      <section id="speaking-panel" role="tabpanel" aria-labelledby={active ? undefined : "speaking-tab"} aria-label={active ? "口语对话" : undefined} hidden={tab !== "speaking"}>
        {!active && (!hasPractice || showNextSetup) && <section className="voice-preparation" aria-label="口语安排">
          <div className="voice-plan-heading"><div><span className="voice-kicker">本次安排</span><h2>{customTopic || topic.title}</h2><p>{level} · {minutes} 分钟{memory.memory?.enabled && memory.memory.notes.length > 0 ? " · 参考学习记忆" : ""}</p></div><button className="secondary" disabled={planBusy || !status?.configured} onClick={() => void recommend()}><Sparkles size={17} />{planBusy ? "正在推荐…" : "AI 推荐安排"}</button></div>
          {planError && <p className="voice-notice" role="alert">{planError}</p>}{planNotice && <p className="voice-muted" role="status">{planNotice}</p>}
          {plans.length > 0 && <div className="voice-plan-list">{plans.map((plan, index) => <button key={`${plan.title}-${index}`} onClick={() => applyPlan(plan)}><span className="voice-kicker">{plan.level} · {plan.minutes} 分钟</span><strong>{plan.title}</strong><p>{plan.goal}</p><small>{plan.reason}</small><span className="voice-plan-select">选择这个安排 <ArrowRight size={16} /></span></button>)}</div>}
          <details className="voice-manual voice-disclosure"><summary><span>自己设置</span><span>主题、难度与时长 <ChevronDown size={16} /></span></summary><div className="voice-manual-content"><label>话题<select value={topicId} onChange={(event) => { setTopicId(event.target.value); setCustomTopic(""); setGoal(""); setOpeningPrompt(""); setPlanNotice(""); }}>{VOICE_TOPICS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="voice-select-row"><label>难度<select value={level} onChange={(event) => setLevel(event.target.value as VoiceLevel)}>{VOICE_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>时长<select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>{[5, 10, 15, 20].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label></div><p className="voice-level-note">{VOICE_LEVELS.find((item) => item.id === level)?.description}</p><label>自己的话题 <span className="voice-muted">可选</span><textarea rows={2} maxLength={600} value={customTopic} placeholder="例如：聊聊最近读的一本书，或者安排一个雨天的城市散步。" onChange={(event) => { setCustomTopic(event.target.value); setOpeningPrompt(""); setGoal(""); setPlanNotice(""); }} /></label><label>这次想练什么 <span className="voice-muted">可选</span><input maxLength={600} value={goal} placeholder="例如：表达观点，再给出一个具体例子。" onChange={(event) => setGoal(event.target.value)} /></label><details className="voice-targets"><summary>带几个词去聊天 <span>{targets.length}/5</span></summary><div>{availableTargets.map((entry) => <button key={entry.id} aria-pressed={targets.includes(entry.headword)} onClick={() => setTargets((current) => current.includes(entry.headword) ? current.filter((word) => word !== entry.headword) : current.length < 5 ? [...current, entry.headword] : current)} className={targets.includes(entry.headword) ? "is-selected" : ""}>{entry.headword}</button>)}</div></details></div></details>
        </section>}
        <section className={`voice-conversation ${connected ? "is-live" : ""} ${hasPractice ? "is-finished" : ""}`} aria-label="语音练习">
          {!hasPractice && <div className="voice-caption-choice" role="group" aria-label="对话文字显示"><button aria-pressed={captions} onClick={() => changeCaptions(true)}>显示文字</button><button aria-pressed={!captions} onClick={() => changeCaptions(false)}>不显示文字</button></div>}
          {!hasPractice && <div className="voice-orb" aria-hidden="true">{snapshot.muted ? <MicOff size={32} strokeWidth={1.6} /> : <Mic size={32} strokeWidth={1.6} />}</div>}
          <span className="voice-session-label">{isDiagnostic ? "连接测试" : `${customTopic || topic.title} · ${level}`}</span>
          <h2>{active ? snapshot.phase === "closing" ? "正在结束" : connected ? snapshot.paused ? "留点时间，想一想。" : "对话进行中" : "正在连接" : hasPractice ? "语音已结束" : "准备好，就开始。"}</h2>
          {!hasPractice && (!active || captions) && <p className="voice-goal">{goal || topic.goal}</p>}
          {!active && !hasPractice && captions && <div className="voice-prompts"><span>可以从这里开始</span><p lang="en">{openingPrompt || (customTopic ? "Tell me what you would like to talk about today." : topic.openingPrompt)}</p></div>}
          <div className="voice-connection-state" role="status" aria-live="polite">{snapshot.message}</div>
          {active && !captions && <p className="voice-muted">专注听和说。结束后仍可查看转写。</p>}
          {active && captions && <div className="voice-live-captions" aria-label="实时对话文字">{transcript.length ? transcript.slice(-4).map((turn, index) => <div className={`voice-caption-line ${turn.role}`} key={`${transcript.length}-${index}`}><span>{turn.role === "user" ? "你" : "英语伙伴"}</span><p lang="en">{turn.text}</p></div>) : <p className="voice-muted">说话后，转写会显示在这里。</p>}</div>}
          <div className="voice-meter"><span><Clock3 size={15} />{time(snapshot.seconds)} <small>/ {time(active ? snapshot.maxSeconds : minutes * 60)}</small></span>{active && <span>{isDiagnostic ? "测试音轨" : snapshot.muted ? "麦克风已静音" : connected ? "麦克风已开启" : "正在准备音频"}</span>}</div>
          {snapshot.playbackBlocked && <button className="secondary voice-resume-audio" onClick={() => void client.current?.resumePlayback()}><Play size={16} />点此开启声音</button>}
          <div className={`voice-controls ${active ? "voice-live-controls" : ""}`}>{active ? <><button className="secondary" disabled={!connected} aria-pressed={snapshot.muted} onClick={() => client.current?.mute(!snapshot.muted)}>{snapshot.muted ? <MicOff size={18} /> : <Mic size={18} />}{snapshot.muted ? "开启麦克风" : "静音"}</button><button className="secondary" disabled={!connected} aria-pressed={snapshot.paused} onClick={() => client.current?.pause(!snapshot.paused)}>{snapshot.paused ? <Play size={18} /> : <Pause size={18} />}{snapshot.paused ? "继续对话" : "让我想想"}</button><button className="voice-end" disabled={snapshot.phase === "closing"} onClick={() => void end()}><Square size={15} fill="currentColor" />{snapshot.phase === "connecting" ? "取消" : "结束"}</button></> : <button className="primary voice-start" disabled={!canStart} onClick={() => void start()}><Mic size={18} />{snapshot.phase === "idle" ? "开始对话" : "开始新的对话"}</button>}</div>
          {hasPractice && <button className="text-button" aria-expanded={showNextSetup} onClick={() => setShowNextSetup((value) => !value)}>{showNextSetup ? "收起下次安排" : "调整下次安排"}</button>}
          {active && <p className="voice-muted voice-live-note">{snapshot.paused ? "对方暂时安静，你仍可说话。" : "可以随时开口，也可以留一点时间想词。"} 静音与思考时仍计费。</p>}
          {status?.activeSession && !active && <div className="voice-notice"><p>上次语音还未确认结束，先关闭再开始。</p><button className="secondary" onClick={async () => { try { await voiceRequest("/api/voice/close", { sessionId: status.activeSession!.sessionId }); await refreshStatus(); } catch (error) { setStatusError(error instanceof Error ? error.message : "关闭未确认，请稍后重试。"); } }}>关闭上次语音</button></div>}
          {!status && !statusError && <p className="voice-muted">正在检查语音设置…</p>}{statusError && <p className="voice-notice" role="alert">{statusError} <button className="text-button" onClick={() => void refreshStatus()}>重新检查</button></p>}
          {status && !status.ready && <div className="voice-notice"><p>{!status.configured ? "在 AI 设置中保存 OpenAI API key 后，就可以开始口语练习。" : status.reason || "语音服务暂未就绪，请检查 AI 设置。"}</p><button className="secondary" onClick={onOpenSettings}>打开 AI 设置</button><button className="text-button" onClick={() => void refreshStatus()}>重新检查</button></div>}
          {status?.ready && !browserSupported && !active && <p className="voice-notice">语音需要 HTTPS 安全连接、麦克风和 WebRTC。请用新版 Safari / Chrome 打开正式站点。</p>}
        </section>
        {!active && <>
          <LearningMemoryPanel controls={memory} />
          <details className="voice-connection-details voice-disclosure"><summary><span>用量与连接</span><span>{typeof status?.remainingSeconds === "number" ? `今日可预留 ${Math.floor(status.remainingSeconds / 60)} 分钟` : "查看详情"}</span></summary><div><p className="voice-muted">语音费用估计 ${(Math.max(snapshot.seconds, snapshot.usageSeconds || 0) / 60 * .05).toFixed(3)}。GPT-Live 语音约 $0.05/分钟，文字模型和复盘另计。应用在开始时预留整段时长，提前结束不退还应用额度；它不是实际账单或绝对费用上限。</p><button className="secondary" disabled={!canStart} onClick={() => void start(true)}>测试 Live 连接（无需麦克风）</button><p className="voice-muted">约 20 秒自动结束，会使用少量 API 额度。实际收音仍需麦克风。</p></div></details>
          {hasPractice && <PracticeDiscussion key={`${recordId}-${transcriptRevision}`} sessionKey={recordId || "practice"} topicId={recordMeta.current?.topicId || topicId} level={recordMeta.current?.level || level} transcript={transcript} messages={discussion} onChange={(messages) => { setDiscussion(messages); setSaved(false); }} configured={Boolean(status?.configured)} onRemember={memory.remember} remembered={remembered} memoryBusy={memory.busy} />}
          {hasPractice && <details className="voice-feedback voice-disclosure"><summary><span>表达反馈与重练</span><span>查看具体修改</span></summary><div><button className="secondary" disabled={feedbackBusy || !status?.configured} onClick={() => void requestFeedback()}><Sparkles size={16} />{feedbackBusy ? "正在整理…" : feedback ? "重新整理反馈" : "整理表达反馈"}</button><p className="voice-muted">先检查转写。反馈仅依据文字，不能评定发音或口音。</p>{feedbackError && <p role="alert" className="voice-notice">{feedbackError}</p>}{feedback && <><p>{feedback.strength}</p>{feedback.improvements.map((item, index) => <div className="voice-correction" key={index}><span>可以这样说</span><p lang="en">{item.original}</p><strong lang="en">{item.suggestion}</strong><small>{item.reason}</small></div>)}<div className="voice-retry"><p lang="en">{feedback.retryPrompt}</p><button className="primary" disabled={!canStart} onClick={() => void start(false, { customTopic: recordMeta.current?.customTopic || topic.title, goal: `练习刚才的表达改进：${feedback.improvements.map((item) => item.suggestion).join("；")}`.slice(0, 600), openingPrompt: feedback.retryPrompt })}><Mic size={16} />用这个建议再说一次</button></div>{feedback.expressions.length > 0 && <div className="voice-expressions">{feedback.expressions.map((expression, index) => { const note = `练习表达：${expression.text} — ${expression.meaning}`.slice(0, 400); const included = remembered.includes(note); return <button key={index} disabled={included || memory.busy || !memory.memory} onClick={() => void memory.remember(note)}><strong lang="en">{expression.text}</strong><small>{expression.meaning}</small><span>{included ? "已加入学习记忆 ✓" : "+ 记住这个表达"}</span></button>; })}</div>}</>}{memory.error && <p className="voice-notice">{memory.error}</p>}</div></details>}
          <details className="voice-transcript voice-disclosure"><summary><span>完整转写</span><span>{transcript.length ? "可修正识别错误" : "练习后查看"}</span></summary>{transcript.length ? <div className="voice-transcript-list">{transcript.map((turn, index) => <label key={`${index}-${turn.role}`} className={`voice-turn ${turn.role}`}><span>{turn.role === "user" ? "你" : "英语伙伴"}</span><textarea aria-label={`${turn.role === "user" ? "你的" : "英语伙伴的"}第 ${index + 1} 段转写`} lang="en" value={turn.text} maxLength={3000} onChange={(event) => { feedbackAbort.current?.abort(); setFeedbackBusy(false); setFeedbackError(""); setTranscript((current) => current.map((row, i) => i === index ? { ...row, text: event.target.value } : row)); setTranscriptRevision((value) => value + 1); setFeedback(null); setDiscussion([]); setSaved(false); }} /></label>)}</div> : <p className="voice-empty-note">这里会保留对话文字，不保存录音。</p>}</details>
          {saved && <p className="voice-saved"><Check size={14} />本次转写与复盘已保存在此浏览器，最近 12 次；学习记忆另存于账号。</p>}
          <details className="voice-history voice-disclosure"><summary><span>最近练习</span><span>{history.length} 次 · 当前浏览器</span></summary>{storageError && <p role="alert" className="voice-notice">{storageError}</p>}{history.length ? <ul>{history.map((record) => <li key={record.id}><button aria-current={recordId === record.id ? "true" : undefined} onClick={() => openRecord(record)}><span>{record.customTopic || getVoiceTopic(record.topicId).title}<small>{record.level} · {time(record.seconds)} · {new Date(record.createdAt).toLocaleDateString("zh-CN")}</small></span><ArrowRight size={16} /></button><button className="icon-button" aria-label="删除这次口语记录" onClick={() => { const next = history.filter((row) => row.id !== record.id); try { localStorage.setItem(VOICE_HISTORY_KEY, JSON.stringify(next)); setHistory(next); setDeletedRecord(record); if (recordId === record.id) { feedbackAbort.current?.abort(); recordMeta.current = null; setRecordId(null); setTranscript([]); setDiscussion([]); setFeedback(null); } } catch { setStorageError("删除未完成，请重试。"); } }}><Trash2 size={16} /></button></li>)}</ul> : <p className="voice-empty-note">还没有练习记录。</p>}{deletedRecord && <p className="voice-muted" role="status">已删除这次练习。<button className="text-button" onClick={() => { try { setHistory(saveVoiceRecord(localStorage, deletedRecord)); setDeletedRecord(null); } catch { setStorageError("恢复未完成，请重试。"); } }}>撤销</button></p>}<p className="voice-muted">每次保留最近 150 段转写。转写与复盘不进入学习备份，其他设备看不到。</p></details>
        </>}
      </section>
      <section id="dictation-panel" role="tabpanel" aria-labelledby="dictation-tab" hidden={tab !== "dictation"}><DictationPanel entries={entries} active={tab === "dictation"} /></section>
    </main>
  </div>;
}
