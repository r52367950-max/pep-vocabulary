"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Clock3, Headphones, Mic, MicOff, Pause, Play, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { NativeLiveSession, appendTranscript, feedbackTranscript, readVoiceHistory, saveVoiceRecord, voiceRequest, VOICE_HISTORY_KEY, type TranscriptTurn, type VoiceFeedback, type VoiceRecord, type VoiceSnapshot, type VoiceStatus } from "@/lib/voice/client";
import { VOICE_LEVELS, VOICE_TOPICS, getVoiceTopic, type VoiceLevel } from "@/lib/voice/curriculum";
import { DictationPanel } from "./voice/dictation-panel";

const INITIAL: VoiceSnapshot = { phase: "idle", message: "准备好就开始", seconds: 0, muted: false, paused: false, playbackBlocked: false, maxSeconds: 600, usageSeconds: null, closeConfirmed: false };
const time = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
type ReviewExpression = { text: string; meaning: string };

export default function VoiceWorkspace({ entries, onClose, onOpenSettings }: { entries: LexiconIndexEntry[]; onClose: () => void; onOpenSettings: () => void }) {
  const [tab, setTab] = useState<"speaking" | "dictation">("speaking");
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [topicId, setTopicId] = useState("everyday");
  const [level, setLevel] = useState<VoiceLevel>("B1");
  const [minutes, setMinutes] = useState(10);
  const [targets, setTargets] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(INITIAL);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [feedback, setFeedback] = useState<VoiceFeedback | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [history, setHistory] = useState<VoiceRecord[]>([]);
  const [saved, setSaved] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewExpression[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewMeaning, setReviewMeaning] = useState(false);
  const mounted = useRef(false);
  const client = useRef<NativeLiveSession | null>(null);
  const feedbackAbort = useRef<AbortController | null>(null);
  const statusAbort = useRef<AbortController | null>(null);
  const recordMeta = useRef<{ id: string; createdAt: string; topicId: string; level: string } | null>(null);
  const active = ["connecting", "connected", "closing"].includes(snapshot.phase);
  const connected = snapshot.phase === "connected";
  const topic = getVoiceTopic(topicId);

  const refreshStatus = useCallback(async () => {
    statusAbort.current?.abort(); const abort = new AbortController(); statusAbort.current = abort;
    try { const value = await voiceRequest<VoiceStatus>("/api/voice/status", undefined, abort.signal); if (mounted.current && !abort.signal.aborted) { setStatus(value); setStatusError(""); } }
    catch (error) { if (mounted.current && !abort.signal.aborted) setStatusError(error instanceof Error ? error.message : "暂时无法检查语音设置。"); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const transport = new NativeLiveSession({ onState: (state) => { if (mounted.current) setSnapshot(state); }, onTranscript: (turn) => { if (mounted.current) setTranscript((current) => appendTranscript(current, turn)); } });
    client.current = transport;
    queueMicrotask(() => { if (mounted.current) { try { setHistory(readVoiceHistory(localStorage)); } catch { setStorageError("当前浏览器不允许保存本机记录。"); } void refreshStatus(); } });
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const stopHidden = () => { void transport.end("离开页面超过 30 秒，语音已停止。可手动开始下一次练习。"); };
    const visibility = () => { clearTimeout(hiddenTimer); if (document.hidden) { hiddenAt = Date.now(); hiddenTimer = setTimeout(stopHidden, 30_000); } else if (hiddenAt && Date.now() - hiddenAt >= 30_000) { hiddenAt = 0; stopHidden(); } };
    const pagehide = () => transport.dispose();
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", pagehide); window.addEventListener("vocab-ai-config-changed", refreshStatus);
    return () => { mounted.current = false; clearTimeout(hiddenTimer); transport.dispose(); statusAbort.current?.abort(); feedbackAbort.current?.abort(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); window.removeEventListener("vocab-ai-config-changed", refreshStatus); };
  }, [refreshStatus]);
  useEffect(() => { if (["ended", "error"].includes(snapshot.phase)) queueMicrotask(() => { if (mounted.current) void refreshStatus(); }); }, [snapshot.phase, snapshot.closeConfirmed, refreshStatus]);
  useEffect(() => {
    if (!["ended", "error"].includes(snapshot.phase) || !recordMeta.current || !transcript.length || saved) return;
    const record: VoiceRecord = { ...recordMeta.current, seconds: snapshot.seconds, transcript, ...(feedback ? { feedback } : {}) };
    try { setHistory(saveVoiceRecord(localStorage, record)); setSaved(true); setStorageError(""); }
    catch { setStorageError("此浏览器暂时无法保存记录，请在离开前复制需要的文字。"); }
  }, [snapshot.phase, snapshot.seconds, transcript, saved, feedback]);
  const end = () => client.current?.end();
  const exit = () => { client.current?.dispose(); onClose(); };
  const start = async (diagnostic = false) => {
    feedbackAbort.current?.abort(); setFeedbackBusy(false); setFeedbackError("");
    setTranscript([]); setFeedback(null); setSaved(false); setReview([]); setStorageError("");
    const meta = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), topicId, level }; recordMeta.current = diagnostic ? null : meta; setRecordId(diagnostic ? null : meta.id);
    await client.current?.start({ topicId, level, minutes, targetWords: targets, ...(diagnostic ? { diagnostic: true } : {}) });
  };
  const requestFeedback = async () => {
    if (active || !transcript.some((turn) => turn.role === "user" && turn.text.trim()) || feedbackBusy) return;
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
    feedbackAbort.current?.abort(); setFeedbackBusy(false); setFeedbackError(""); setRecordId(record.id); recordMeta.current = { id: record.id, createdAt: record.createdAt, topicId: record.topicId, level: record.level };
    setTopicId(record.topicId); setLevel(VOICE_LEVELS.some((item) => item.id === record.level) ? record.level as VoiceLevel : "B1"); setTranscript(record.transcript); setFeedback(record.feedback || null); setSaved(true); setSnapshot({ ...INITIAL, phase: "ended", seconds: record.seconds, message: "已打开本机练习记录。" });
  };
  const availableTargets = entries.filter((entry) => !entry.flags.properName && entry.headword.length < 25).slice(0, 18);
  const browserSupported = typeof window !== "undefined" && window.isSecureContext && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia;
  const canStart = Boolean(status?.ready && !status.activeSession && !active && browserSupported);
  const unavailableReason = status?.reason === "voice_budget_exhausted" ? "今天可预留的语音额度已用完，次日北京时间 0 点重置。" : status?.reason === "voice_requires_openai" ? "口语与 AI 听写需要 OpenAI 官方接口，请在 AI 设置中选择推荐配置并保存密钥。" : "语音服务暂未就绪，请检查 AI 设置。";

  return <div className="learn-screen voice-screen">
    <header className="voice-header"><button className="icon-button" onClick={exit} aria-label="退出口语与听写"><X size={22} /></button><span className="learn-header-title">听说练习</span><button className="icon-button" onClick={() => { client.current?.dispose(); onOpenSettings(); }} aria-label="打开 AI 设置"><Settings2 size={20} /></button></header>
    <main className="voice-stage">
      <div className="voice-intro"><span className="voice-eyebrow">A LITTLE EVERY DAY</span><h1>把英语，说出来。</h1><p>从熟悉的话题开始，慢一点也没关系。</p></div>
      <div className="voice-tabs" role="tablist" aria-label="练习类型"><button role="tab" id="speaking-tab" aria-selected={tab === "speaking"} aria-controls="speaking-panel" onClick={() => setTab("speaking")}><Mic size={17} />口语对话</button><button role="tab" id="dictation-tab" aria-selected={tab === "dictation"} aria-controls="dictation-panel" onClick={() => { if (active) void end(); setTab("dictation"); }}><Headphones size={17} />词汇听写</button></div>
      <section id="speaking-panel" role="tabpanel" aria-labelledby="speaking-tab" hidden={tab !== "speaking"}>
        <div className="voice-layout">
          <aside className="voice-setup"><h2>今天聊什么</h2><fieldset disabled={active}><legend>主题</legend><div className="voice-topic-list">{VOICE_TOPICS.map((item) => <button key={item.id} className={topicId === item.id ? "is-selected" : ""} onClick={() => setTopicId(item.id)} aria-pressed={topicId === item.id}><span>{item.title}</span><small>{item.description}</small>{topicId === item.id && <Check size={16} />}</button>)}</div><div className="voice-select-row"><label>难度<select value={level} onChange={(event) => setLevel(event.target.value as VoiceLevel)}>{VOICE_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>时长<select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>{[5, 10, 15, 20].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label></div><p className="voice-level-note">{VOICE_LEVELS.find((item) => item.id === level)?.description}</p>
            <details className="voice-targets"><summary>带几个词去聊天 <ChevronDown size={14} /><span>{targets.length}/5</span></summary><div>{availableTargets.map((entry) => <button key={entry.id} aria-pressed={targets.includes(entry.headword)} onClick={() => setTargets((current) => current.includes(entry.headword) ? current.filter((word) => word !== entry.headword) : current.length < 5 ? [...current, entry.headword] : current)} className={targets.includes(entry.headword) ? "is-selected" : ""}>{entry.headword}</button>)}</div></details>
          </fieldset></aside>
          <div className="voice-main">
            <section className={`voice-conversation ${connected ? "is-live" : ""}`} aria-label="语音练习"><div className="voice-orb" aria-hidden="true"><Mic size={29} strokeWidth={1.6} /></div><span className="voice-session-label">{topic.title} · {level}</span><h2>{connected ? snapshot.paused ? "留一点时间想一想。" : "轮到你，慢慢说。" : "先说一句，就很好。"}</h2><p className="voice-goal">{topic.goal}</p><div className="voice-prompts"><span>可以从这里开始</span><p lang="en">{topic.openingPrompt}</p></div>
              <div className="voice-connection-state" role="status" aria-live="polite">{snapshot.message}</div>
              <div className="voice-meter"><span><Clock3 size={15} /> {time(snapshot.seconds)} <small>/ {time(active ? snapshot.maxSeconds : minutes * 60)}</small></span><span>语音约 ${(Math.max(snapshot.seconds, snapshot.usageSeconds || 0) / 60 * .05).toFixed(3)}</span></div>
              {snapshot.playbackBlocked && <button className="secondary voice-resume-audio" onClick={() => void client.current?.resumePlayback()}><Play size={16} />点此开启声音</button>}
              <div className="voice-controls">{active ? <><button className="secondary" disabled={!connected} aria-pressed={snapshot.muted} onClick={() => client.current?.mute(!snapshot.muted)}>{snapshot.muted ? <MicOff size={18} /> : <Mic size={18} />}{snapshot.muted ? "开启麦克风" : "麦克风静音"}</button><button className="secondary" disabled={!connected} aria-pressed={snapshot.paused} onClick={() => client.current?.pause(!snapshot.paused)}>{snapshot.paused ? <Play size={18} /> : <Pause size={18} />}{snapshot.paused ? "继续对话" : "让我想想"}</button><button className="voice-end" disabled={snapshot.phase === "closing"} onClick={() => void end()}><Square size={15} fill="currentColor" />{snapshot.phase === "connecting" ? "取消连接" : "结束"}</button></> : <button className="primary voice-start" disabled={!canStart} onClick={() => void start()}><Mic size={18} />{snapshot.phase === "idle" ? "开始对话" : "开始新的对话"}</button>}</div>
              {!active && <div className="voice-diagnostic"><button className="text-button" disabled={!canStart} onClick={() => void start(true)}>测试 Live 连接（无需麦克风）</button><p className="voice-muted">约 20 秒自动结束，返回一段测试语音，会产生少量 API 用量。</p></div>}
              <p className="voice-cost-note">GPT-Live 语音约 $0.05/分钟，另计对话所用文字模型及课后反馈费用。静音和思考暂停仍计费；页面计时和关闭用于限制时长，并非绝对账单上限。</p>
              {status?.ready && <p className="voice-budget">设置已就绪，模型访问权限将在实际连接时确认。{typeof status.remainingSeconds === "number" && <> 今日还可预留约 {Math.floor(status.remainingSeconds / 60)} 分钟 / {Math.floor((status.dailySecondsLimit || 3600) / 60)} 分钟。整段时长在开始时预留，提前结束不退还额度；这是应用用量控制，不是实际账单。</>}</p>}{status?.activeSession && !active && <div className="voice-notice"><p>服务器还有上次未结束的语音。先关闭，再开始新的练习。</p><button className="secondary" onClick={async () => { try { await voiceRequest("/api/voice/close", { sessionId: status.activeSession!.sessionId }); await refreshStatus(); } catch (error) { setStatusError(error instanceof Error ? error.message : "关闭未确认，请稍后重试。"); } }}>关闭上次语音</button></div>}{!status && !statusError && <p className="voice-notice">正在检查语音设置…</p>}{statusError && <p className="voice-notice">{statusError} <button onClick={() => void refreshStatus()}>重新检查</button></p>}
              {status && !status.ready && <div className="voice-notice"><p>{!status.configured ? "先在 AI 设置中保存 OpenAI API key，就可以开始语音练习。" : unavailableReason}</p><button className="secondary" onClick={onOpenSettings}>打开 AI 设置</button><button className="text-button" onClick={() => void refreshStatus()}>重新检查</button></div>}
              {status?.ready && !browserSupported && !active && <p className="voice-notice">语音需要 HTTPS 安全连接、麦克风和 WebRTC。请用新版 Safari / Chrome 打开正式站点；本地词汇仍可学习。</p>}
            </section>
            <details className="voice-transcript" open={transcript.length > 0}><summary>对话转写 <span>{active ? "自动识别，可能有误" : "结束后可修正再获取反馈"}</span></summary>{transcript.length ? <div className="voice-transcript-list">{transcript.map((turn, index) => <label key={`${index}-${turn.role}`} className={`voice-turn ${turn.role}`}><span>{turn.role === "user" ? "你" : "英语伙伴"}</span>{active ? <p lang="en">{turn.text}</p> : <textarea aria-label={`${turn.role === "user" ? "你的" : "英语伙伴的"}第 ${index + 1} 段转写`} lang="en" value={turn.text} maxLength={3000} onChange={(event) => { feedbackAbort.current?.abort(); setFeedbackBusy(false); setFeedbackError(""); setTranscript((current) => current.map((row, i) => i === index ? { ...row, text: event.target.value } : row)); setFeedback(null); setSaved(false); }} />}</label>)}</div> : <p className="voice-empty-note">连接后，双方的话会显示在这里。没有录音保存。</p>}</details>
            {!active && transcript.some((turn) => turn.role === "user" && turn.text.trim()) && <section className="voice-feedback"><div className="voice-section-heading"><h2>把这次练习，留下一点收获。</h2><button className="secondary" disabled={feedbackBusy || !status?.configured} onClick={() => void requestFeedback()}><Sparkles size={16} />{feedbackBusy ? "正在整理…" : feedback ? "重新整理反馈" : "获取文字反馈"}</button></div><p className="voice-muted">先检查转写是否准确。反馈仅依据文字，不能评定发音或口音。{transcript.reduce((sum, turn) => sum + turn.text.length, 0) > 18000 && "转写较长，本次反馈使用最近 18,000 字符；本机会保留最近 150 段转写。"}</p>{feedbackError && <p role="alert" className="voice-notice">{feedbackError}</p>}{feedback && <><p>{feedback.strength}</p>{feedback.improvements?.map((item, index) => <div className="voice-correction" key={index}><span>可以这样说</span><p lang="en">{item.original}</p><strong lang="en">{item.suggestion}</strong><small>{item.reason}</small></div>)}<p className="voice-retry"><strong>再说一次</strong><span lang="en">{feedback.retryPrompt}</span></p>{feedback.expressions?.length > 0 && <div className="voice-expressions">{feedback.expressions.map((expression, index) => <button key={index} aria-pressed={review.some((row) => row.text === expression.text)} onClick={() => setReview((current) => current.some((row) => row.text === expression.text) ? current.filter((row) => row.text !== expression.text) : [...current, expression])}><strong lang="en">{expression.text}</strong><small>{expression.meaning}</small><span>{review.some((row) => row.text === expression.text) ? "已加入本次复习 ✓" : "+ 本地复习"}</span></button>)}</div>}</>}{saved && <p className="voice-saved"><Check size={14} />已保存到此浏览器，最近 12 次。仅含转写与反馈，不含音频。</p>}</section>}
            {review.length > 0 && <section className="voice-local-review"><div className="voice-section-heading"><h2>表达复习</h2><button className="text-button" onClick={() => setReview([])}>结束复习</button></div><span>{reviewIndex % review.length + 1} / {review.length}</span><p lang="en">{review[reviewIndex % review.length].text}</p>{reviewMeaning && <p>{review[reviewIndex % review.length].meaning}</p>}<div className="voice-controls"><button className="secondary" onClick={() => setReviewMeaning((value) => !value)}>{reviewMeaning ? "隐藏释义" : "显示释义"}</button><button className="secondary" onClick={() => { setReviewIndex((value) => value + 1); setReviewMeaning(false); }}>下一句</button></div><small>在本页快速复习，不改变单词的复习进度。</small></section>}
          </div>
        </div>
        <section className="voice-history"><div className="voice-section-heading"><h2>最近练习</h2>{history.length > 0 && <button className="text-button" disabled={active} onClick={() => { try { localStorage.removeItem(VOICE_HISTORY_KEY); setHistory([]); setSaved(false); recordMeta.current = null; setRecordId(null); setTranscript([]); setFeedback(null); } catch { setStorageError("清除未完成，请重试。"); } }}><Trash2 size={15} />清除本机全部记录</button>}</div><p className="voice-muted">每次最近 150 段转写仅在当前浏览器保存，不进入学习备份；其他设备看不到。</p>{storageError && <p role="alert" className="voice-notice">{storageError}</p>}{history.length ? <ul>{history.map((record) => <li key={record.id}><button disabled={active} aria-current={recordId === record.id ? "true" : undefined} onClick={() => openRecord(record)}><span>{getVoiceTopic(record.topicId).title}<small>{record.level} · {time(record.seconds)} · {new Date(record.createdAt).toLocaleDateString("zh-CN")}</small></span><ArrowLeft size={16} className="voice-history-arrow" /></button><button className="icon-button" disabled={active} aria-label="删除这次口语记录" onClick={() => { const next = history.filter((row) => row.id !== record.id); try { localStorage.setItem(VOICE_HISTORY_KEY, JSON.stringify(next)); setHistory(next); if (recordId === record.id) { recordMeta.current = null; setRecordId(null); setTranscript([]); setFeedback(null); } } catch { setStorageError("删除未完成，请重试。"); } }}><Trash2 size={16} /></button></li>)}</ul> : <p className="voice-empty-note">还没有口语记录。从一个熟悉的话题开始。</p>}</section>
      </section>
      <section id="dictation-panel" role="tabpanel" aria-labelledby="dictation-tab" hidden={tab !== "dictation"}><DictationPanel entries={entries} active={tab === "dictation"} /></section>
    </main>
  </div>;
}
