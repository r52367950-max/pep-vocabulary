"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Headphones, Mic, RotateCcw, Square, Volume2 } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { compareDictation, DICTATION_HISTORY_KEY, DICTATION_SENTENCES, parseDictationHistory, recordDictationAttempt, selectDictationRound, wordDictationItems, type DictationHistory, type DictationItem, type DictationMode } from "@/lib/voice/dictation";
import { DictationLiveInput, dictationVoiceCommand, canSubmitDictation, newDictationAttempt, reduceDictationAttempt, spellingDraft, type DictationAttemptEvent, type DictationLearningPreferences, type SpellingCaptureAdapter, type DictationVoiceCommand } from "@/lib/voice/dictation-session";
import { refreshLearningContext, contextStillCurrent } from "@/lib/learning-context-client";
import type { VoiceSnapshot } from "@/lib/voice/client";
import "./dictation.css";

type Playback = "idle" | "loading" | "playing";
export function DictationPanel({ entries, active = true, temporary = false, learningPreferences, spellingCapture: suppliedCapture, accountScope, contextEpoch = 0, onLiveActiveChange, onLiveUnconfirmedChange }: {
  entries: LexiconIndexEntry[]; active?: boolean; temporary?: boolean;
  learningPreferences?: DictationLearningPreferences; spellingCapture?: SpellingCaptureAdapter;
  accountScope?: string; contextEpoch?: number; onLiveActiveChange?: (active: boolean) => void; onLiveUnconfirmedChange?: (unconfirmed: boolean) => void;
}) {
  const live = useRef<DictationLiveInput | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<VoiceSnapshot | null>(null);
  const [liveUnconfirmed, setLiveUnconfirmed] = useState(false);
  const callbacks = useRef({ onLiveActiveChange, onLiveUnconfirmedChange });
  callbacks.current = { onLiveActiveChange, onLiveUnconfirmedChange };
  const [commandDraft, setCommandDraft] = useState<{ attemptId: string; command: DictationVoiceCommand } | null>(null);
  const [commandListening, setCommandListening] = useState(false);
  const commandCapture = useRef<{ handle: Awaited<ReturnType<SpellingCaptureAdapter["start"]>>; abort: AbortController; attemptId: string } | null>(null);
  const liveActive = !!liveSnapshot && ["connecting", "connected", "closing"].includes(liveSnapshot.phase);
  const historyKey = accountScope ? `${DICTATION_HISTORY_KEY}:account:${encodeURIComponent(accountScope)}` : null;
  const [mode, setMode] = useState<DictationMode>("words");
  const [queue, setQueue] = useState<DictationItem[]>([]);
  const [position, setPosition] = useState(0);
  const [attempt, setAttempt] = useState(() => newDictationAttempt("initial", ""));
  const attemptRef = useRef(attempt);
  const apply = useCallback((event: DictationAttemptEvent) => {
    const next = reduceDictationAttempt(attemptRef.current, event);
    if (next !== attemptRef.current) { attemptRef.current = next; setAttempt(next); }
    return next;
  }, []);
  const { answer, heard } = attempt;
  const submitted = attempt.phase === "submitted";
  const revealed = attempt.phase === "revealed";
  const [hintVisible, setHintVisible] = useState(false);
  const exposed = useRef(new Set<string>());
  const [roundResults, setRoundResults] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<DictationHistory[]>([]);
  const historyRef = useRef<DictationHistory[]>([]);
  const captureAbort = useRef<AbortController | null>(null);
  const captureHandle = useRef<Awaited<ReturnType<SpellingCaptureAdapter["start"]>> | null>(null);
  const [captureFinishing, setCaptureFinishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [playback, setPlayback] = useState<Playback>("idle");
  const [source, setSource] = useState("");
  const [voiceChoice, setVoiceChoice] = useState<"device" | "ai">("device");
  const [storageError, setStorageError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const requestId = useRef(0);
  const cache = useRef(new Map<string, Blob>());
  const input = useRef<HTMLTextAreaElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(learningPreferences?.preferredSpeed === "slow");
  const words = useMemo(() => wordDictationItems(entries), [entries]);
  const item = queue[position];
  const result = submitted && item ? compareDictation(item.text, answer) : null;
  const roundErrors = queue.filter((entry) => roundResults[entry.id] !== true);
  const mistakes = history.filter((row) => row.mistakes > 0);

  const stopMedia = useCallback(() => {
    requestId.current++;
    commandCapture.current?.abort.abort(); commandCapture.current?.handle.cancel(); commandCapture.current = null;
    captureAbort.current?.abort(); captureAbort.current = null;
    captureHandle.current?.cancel(); captureHandle.current = null;
    apply({ type: "interrupt", attemptId: attemptRef.current.id });
    controller.current?.abort(); controller.current = null;
    if (audio.current) { audio.current.pause(); audio.current.src = ""; audio.current = null; }
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [apply]);
  const stop = useCallback(() => { stopMedia(); setPlayback("idle"); setCaptureFinishing(false); setCommandListening(false); setCommandDraft(null); }, [stopMedia]);
  useEffect(() => {
    let mounted = true;
    const transport = new DictationLiveInput((state, pending) => {
      callbacks.current.onLiveActiveChange?.(["connecting", "connected", "closing"].includes(state.phase));
      callbacks.current.onLiveUnconfirmedChange?.(pending);
      if (mounted) { setLiveSnapshot(state); setLiveUnconfirmed(pending); }
    });
    live.current = transport;
    return () => { mounted = false; stopMedia(); transport.dispose(); if (live.current === transport) live.current = null; };
  }, [stopMedia]);
  const spellingCapture = useMemo<SpellingCaptureAdapter>(() => suppliedCapture ?? ({
    label: "Live 语音输入（可能计费，固定题目仍由设备或 AI 音频播放）",
    start: async ({ signal }) => {
      const transport = live.current;
      if (!transport || signal.aborted) throw new Error("语音输入已取消。");
      const cancelOpening = () => { void transport.close(); };
      signal.addEventListener("abort", cancelOpening, { once: true });
      try {
        const memory = await refreshLearningContext(signal);
        if (signal.aborted || !contextStillCurrent(memory, temporary) || (accountScope && accountScope !== memory.accountScope)) throw new Error("账户或学习模式已改变，请重新开始。");
        await transport.open(temporary, { accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion });
        if (signal.aborted) throw new Error("语音输入已取消。");
        return transport.begin(signal);
      } finally { signal.removeEventListener("abort", cancelOpening); }
    },
  }), [suppliedCapture, temporary, accountScope, contextEpoch]);
  useEffect(() => {
    let mounted = true;
    stopMedia(); void live.current?.close(); cache.current.clear(); historyRef.current = [];
    Promise.resolve().then(() => {
      if (!mounted) return;
      setQueue([]); setPosition(0); setHistory([]); setHistoryOpen(false); setStorageError(false); setHintVisible(false); setRoundResults({}); exposed.current.clear(); setCommandDraft(null); setCommandListening(false); setPlayback("idle");
      const fresh = newDictationAttempt(crypto.randomUUID(), ""); attemptRef.current = fresh; setAttempt(fresh);
      if (temporary || !historyKey) return;
      try { const rows = parseDictationHistory(localStorage.getItem(historyKey)); historyRef.current = rows; setHistory(rows); }
      catch { setStorageError(true); }
    });
    return () => { mounted = false; stopMedia(); };
  }, [stopMedia, temporary, historyKey, contextEpoch]);
  useEffect(() => {
    if (!active) { stopMedia(); void live.current?.close(); }
    // Reset the visible status on entry without delaying cancellation on exit.
    let mounted = true;
    Promise.resolve().then(() => { if (mounted) setPlayback("idle"); });
    return () => { mounted = false; };
  }, [active, stopMedia]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) { stop(); void live.current?.close(); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stop]);

  useEffect(() => {
    if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const transition = stage.current?.animate?.(
      [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    return () => transition?.cancel();
  }, [active, position, queue, historyOpen]);

  const resetAnswer = (nextItem = item) => {
    const next = newDictationAttempt(crypto.randomUUID(), nextItem?.id ?? "", attemptRef.current.answerMode, exposed.current.has(nextItem?.id ?? ""));
    attemptRef.current = next; setAttempt(next); setHintVisible(false); setNotice(""); setSource("");
  };
  const start = (items: DictationItem[]) => {
    stop(); setSlow(learningPreferences?.preferredSpeed === "slow"); exposed.current.clear(); setRoundResults({}); setQueue(items); setPosition(0); resetAnswer(items[0]); setHistoryOpen(false);
  };
  const changeMode = (next: DictationMode) => { setHistoryOpen(false); stop(); setMode(next); setQueue([]); setPosition(0); resetAnswer(); };
  const deviceSpeak = (text: string, rate: number, id: number, attemptId: string, commandId: string) => {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setNotice("此浏览器没有可用的设备朗读。可切换 AI 语音，或在 Safari 中重试。"); return;
    }
    const voices = window.speechSynthesis.getVoices();
    const english = voices.find((voice) => /^en[-_]/i.test(voice.lang) && voice.localService) ?? voices.find((voice) => /^en[-_]/i.test(voice.lang));
    if (voices.length && !english) { setNotice("设备未安装英语声音，请在系统中添加英语朗读声音，或使用 AI 语音。"); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-GB"; utterance.rate = rate; if (english) utterance.voice = english;
    utterance.onstart = () => { if (requestId.current === id) { setPlayback("playing"); apply({ type: "heard", attemptId, commandId }); } };
    utterance.onend = () => { if (requestId.current === id) setPlayback("idle"); };
    utterance.onerror = () => { if (requestId.current === id) { setPlayback("idle"); setNotice("设备朗读未能播放。请检查声音设置，再点一次播放；也可以切换 AI 语音。"); } };
    setSource(english?.localService ? "设备朗读 · 本地英语合成音" : "设备朗读 · 系统英语合成音（可能需要网络）");
    window.speechSynthesis.speak(utterance);
  };
  const play = async (rate: number) => {
    if (!item || !active) return;
    stop(); setNotice("");
    const id = requestId.current;
    const attemptId = attemptRef.current.id, commandId = crypto.randomUUID();
    apply({ type: "play", attemptId, commandId });
    if (voiceChoice === "device") { deviceSpeak(item.text, rate, id, attemptId, commandId); return; }
    setPlayback("loading"); setSource("AI 语音 · 合成音");
    const key = item.text;
    const abort = new AbortController(); controller.current = abort;
    try {
      // Safari may require another tap after loading; the catch keeps the paid result cached.
      const player = new Audio(); audio.current = player;
      let blob = cache.current.get(key);
      if (!blob) {
        const memory = await refreshLearningContext(abort.signal);
        if (abort.signal.aborted || id !== requestId.current || !contextStillCurrent(memory, temporary) || (accountScope && accountScope !== memory.accountScope)) return;
        const response = await fetch("/api/voice/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: item.text, rate: 1, temporary, accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion }), signal: abort.signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const message = payload?.error?.message || payload?.message || `语音请求失败（${response.status}）`;
          throw new Error(`${message}。可改用设备朗读。`);
        }
        if (!response.headers.get("content-type")?.startsWith("audio/")) throw new Error("服务未返回可播放的音频，可改用设备朗读。");
        blob = await response.blob();
        if (!blob.size) throw new Error("返回音频为空，可改用设备朗读。");
        if (id !== requestId.current) return;
        if (cache.current.size >= 24) cache.current.delete(cache.current.keys().next().value!);
        cache.current.set(key, blob);
      }
      if (id !== requestId.current) return;
      const url = URL.createObjectURL(blob); objectUrl.current = url;
      player.src = url;
      player.playbackRate = rate;
      player.onended = () => { if (id === requestId.current) setPlayback("idle"); };
      player.onerror = () => { if (id === requestId.current) { setPlayback("idle"); setNotice("音频未能播放，请检查声音输出。已缓存的音频可再次播放。"); } };
      await player.play();
      if (id === requestId.current) { setPlayback("playing"); apply({ type: "heard", attemptId, commandId }); }
    } catch (error) {
      if (id !== requestId.current || abort.signal.aborted) return;
      setPlayback("idle");
      setNotice(error instanceof DOMException && error.name === "NotAllowedError" ? "浏览器暂时阻止了声音播放。请再次点播放；音频已缓存，不会重复请求。" : error instanceof Error ? error.message : "语音暂时不可用，可改用设备朗读。");
    }
  };
  const submit = () => {
    const current = attemptRef.current;
    if (!item || current.itemId !== item.id || !canSubmitDictation(current)) return;
    const accepted = apply({ type: "submit", attemptId: current.id });
    if (accepted.phase !== "submitted" || accepted === current) return;
    stop();
    const correct = compareDictation(item.text, accepted.answer).correct;
    setRoundResults((previous) => ({ ...previous, [item.id]: correct && !accepted.assisted }));
    // Assisted answers can be reviewed, but never resolve a mistake or count as independent mastery.
    if (accepted.assisted || temporary || !historyKey) return;
    const next = recordDictationAttempt(historyRef.current, item, accepted.answer);
    historyRef.current = next; setHistory(next);
    try { localStorage.setItem(historyKey, JSON.stringify(next)); }
    catch { setStorageError(true); }
  };
  const beginSpelling = async () => {
    if (!spellingCapture || !active || !heard || submitted || revealed) return;
    stop(); setNotice("");
    const attemptId = attemptRef.current.id, captureId = crypto.randomUUID();
    const accepted = apply({ type: "capture", attemptId, captureId });
    if (accepted.captureId !== captureId) return;
    const abort = new AbortController(); captureAbort.current = abort;
    try {
      const handle = await spellingCapture.start({ signal: abort.signal });
      if (abort.signal.aborted || attemptRef.current.id !== attemptId || attemptRef.current.captureId !== captureId) { handle.cancel(); return; }
      captureHandle.current = handle;
    } catch (error) {
      if (abort.signal.aborted || attemptRef.current.id !== attemptId) return;
      apply({ type: "capture-failed", attemptId, captureId });
      setNotice(error instanceof Error ? error.message : "未能开始拼读，可以改用键盘作答。");
    }
  };
  const finishSpelling = async () => {
    const handle = captureHandle.current, abort = captureAbort.current;
    const { id: attemptId, captureId } = attemptRef.current;
    if (!handle || !abort || !captureId) return;
    captureHandle.current = null; setCaptureFinishing(true);
    try {
      const transcript = await handle.finish();
      if (abort.signal.aborted || attemptRef.current.id !== attemptId || attemptRef.current.captureId !== captureId) return;
      const draft = spellingDraft(transcript);
      apply({ type: "captured", attemptId, captureId, answer: draft.answer });
      setNotice(draft.uncertain ? "有些声音未能明确识别为字母。请根据自己的拼读修改下方文字，再确认；不会自动判错。" : "请核对识别出的字母。确认前不会判分。");
    } catch (error) {
      if (!abort.signal.aborted && attemptRef.current.id === attemptId) {
        apply({ type: "capture-failed", attemptId, captureId });
        setNotice(error instanceof Error ? error.message : "拼读识别未完成，请重新拼读或使用键盘。");
      }
    } finally {
      handle.cancel();
      if (captureAbort.current === abort) { captureAbort.current = null; setCaptureFinishing(false); }
    }
  };
  const showHint = () => { if (!item) return; exposed.current.add(item.id); stop(); apply({ type: "hint", attemptId: attemptRef.current.id }); setHintVisible(true); };
  const reveal = () => { if (!item) return; exposed.current.add(item.id); stop(); apply({ type: "reveal", attemptId: attemptRef.current.id }); };

  const beginCommand = async () => {
    if (!item || submitted || revealed || liveUnconfirmed) return;
    stop(); setNotice("");
    const attemptId = attemptRef.current.id, abort = new AbortController(); captureAbort.current = abort;
    setCommandListening(true);
    try {
      const handle = await spellingCapture.start({ signal: abort.signal });
      if (abort.signal.aborted || attemptRef.current.id !== attemptId) { handle.cancel(); return; }
      commandCapture.current = { handle, abort, attemptId };
    } catch (error) {
      if (!abort.signal.aborted) { setCommandListening(false); setNotice(error instanceof Error ? error.message : "无法开启语音指令。"); }
    }
  };
  const finishCommand = async () => {
    const capture = commandCapture.current;
    if (!capture) return;
    commandCapture.current = null;
    try {
      const transcript = await capture.handle.finish();
      if (capture.abort.signal.aborted || capture.attemptId !== attemptRef.current.id) return;
      const command = dictationVoiceCommand(transcript);
      if (command) setCommandDraft({ attemptId: capture.attemptId, command });
      else setNotice("未识别为单一指令。请只说“重读”“慢速”“提示”或“停止”，也可以直接点对应按钮。");
    } catch (error) { if (!capture.abort.signal.aborted) setNotice(error instanceof Error ? error.message : "语音指令未完成。"); }
    finally { capture.handle.cancel(); if (!capture.abort.signal.aborted) setCommandListening(false); }
  };
  const executeCommand = () => {
    const draft = commandDraft; setCommandDraft(null);
    if (!draft || draft.attemptId !== attemptRef.current.id) return;
    if (draft.command === "repeat") void play(slow ? 0.8 : 1);
    else if (draft.command === "slow") { setSlow(true); void play(0.8); }
    else if (draft.command === "hint") showHint();
    else stop();
  };
  const commandLabels = { repeat: "重读", slow: "慢速播放", hint: "显示提示", stop: "停止播放" };


  return <section className="dictation-panel" aria-label="听写练习" hidden={!active}>
    <div className="dictation-toolbar">
      <div className="segmented" aria-label="听写内容">
        <button type="button" aria-pressed={!historyOpen && mode === "words"} onClick={() => changeMode("words")}>词与短语</button>
        <button type="button" aria-pressed={!historyOpen && mode === "sentences"} onClick={() => changeMode("sentences")}>句子精听</button>
        {!temporary && <button type="button" aria-pressed={historyOpen} onClick={() => { stop(); setHistoryOpen(!historyOpen); }}>错题{mistakes.length ? ` · ${mistakes.length}` : ""}</button>}
      </div>
    </div>
    {(liveSnapshot || liveUnconfirmed) && <section className="dictation-live-status" aria-label="Live 连接与关闭">
      {liveSnapshot && <p className="dictation-note" role="status">{liveSnapshot.phase === "connected" ? `Live 输入已连接 · ${liveSnapshot.seconds} / ${liveSnapshot.maxSeconds} 秒（等待与静音仍计时）` : liveSnapshot.message}</p>}
      {liveActive && <button className="secondary" type="button" disabled={liveSnapshot?.phase === "closing"} onClick={() => { stop(); void live.current?.close(); }}>{liveSnapshot?.phase === "closing" ? "正在关闭 Live…" : "结束 Live 语音输入"}</button>}
      {liveUnconfirmed && !liveActive && <p className="dictation-notice">本机输入已停止，服务器尚未确认关闭。<button className="secondary" type="button" onClick={() => void live.current?.retryClose()}>重试关闭</button></p>}
    </section>}
    {temporary && <p className="dictation-note">临时练习 · 不读取或保存听写历史</p>}
    {storageError && <p className="dictation-notice" role="status">浏览器未能保存记录；本次仍可练习，离开页面后可能丢失。</p>}
    <div ref={stage} className="dictation-stage">
    {historyOpen && !temporary ? <div className="dictation-history">
      <h2>听写错题</h2><p className="dictation-note">保留在此浏览器，最多300条练习记录；不影响单词复习进度。</p>
      {mistakes.length ? <><button type="button" className="primary" onClick={() => start(mistakes.filter((row) => !row.resolved).map((row) => row.item).slice(0, 12))} disabled={!mistakes.some((row) => !row.resolved)}>再练尚未掌握的错题</button>
        <ul>{mistakes.map((row) => <li key={row.item.id}><div><strong lang="en">{row.item.text}</strong><small>{row.mistakes}次出错 · {row.resolved ? "最近一次已答对" : "待再练"} · {new Date(row.lastAt).toLocaleDateString("zh-CN")}</small></div><button type="button" className="secondary" onClick={() => start([row.item])}>再练</button></li>)}</ul></> : <p className="empty">还没有错题，先完成一组听写。</p>}
    </div> : !queue.length ? <div className="dictation-intro">
      <span className="dictation-emblem"><Headphones size={28} aria-hidden="true" /></span>
      <h2>{mode === "words" ? "从耳朵，到笔尖。" : "听清一句话。"}</h2>
      <p>{mode === "words" ? "听一遍，写下来，再看看哪里需要练习。本组12项。" : "日常与校园主题的原创短句，每组6句。"}</p>
      <button type="button" className="primary" disabled={mode === "words" && !words.length} onClick={() => start(mode === "words" ? selectDictationRound(words, 12) : selectDictationRound(DICTATION_SENTENCES, 6))}>开始听写 <ArrowRight size={16} aria-hidden="true" /></button>
      {mode === "words" && !words.length && <p role="status">当前范围没有可听写的词，请换一个教材范围。</p>}
      <p className="dictation-note">无需麦克风 · 默认使用设备英语声音</p>
    </div> : !item ? <div className="dictation-intro">
      <span className="dictation-emblem"><Check size={28} aria-hidden="true" /></span><h2>这一组，听完了。</h2>
      <p>{queue.length}项练习 · {roundErrors.length ? `${roundErrors.length}项还可以再练` : "本组已独立答对"}</p>
      <div className="dictation-actions">{roundErrors.length > 0 && <button type="button" className="primary" onClick={() => start(roundErrors)}>再练本轮错题</button>}<button type="button" className="secondary" onClick={() => { stop(); void live.current?.close(); setQueue([]); resetAnswer(); }}>返回选题</button></div>
    </div> : <div className="dictation-exercise">
      <div className="dictation-meta"><span>{item.mode === "words" ? "词与短语" : "句子精听"} · {position + 1} / {queue.length}</span><button type="button" onClick={() => { stop(); void live.current?.close(); setQueue([]); resetAnswer(); }}>结束本组</button></div>
      <div className={`dictation-audio is-${playback}`}>
        <label className="dictation-voice-label">朗读方式 <select value={voiceChoice} onChange={(event) => { stop(); setVoiceChoice(event.target.value as "device" | "ai"); setSource(""); }}><option value="device">设备朗读 · 不用 API</option><option value="ai">AI 语音 · 联网使用 API</option></select></label>
        <div className="dictation-actions">
          <button type="button" className="dictation-play" aria-busy={playback === "loading"} onClick={() => {
            if (playback !== "idle") { stop(); if (voiceChoice === "ai") setNotice("已停止播放或请求。服务已经处理的请求仍可能计费。"); }
            else void play(slow ? 0.8 : 1);
          }}>{playback !== "idle" ? <Square size={22} aria-hidden="true" /> : <Volume2 size={24} aria-hidden="true" />}{playback === "loading" ? "停止获取" : playback === "playing" ? "停止播放" : heard ? "再听一次" : "播放音频"}</button>
          <button type="button" className="dictation-speed" aria-pressed={slow} disabled={playback === "loading"} onClick={() => { const next = !slow; setSlow(next); if (playback === "playing") void play(next ? 0.8 : 1); }}>0.8× 慢速</button>
        </div>
        <p className="dictation-note" role="status">{playback === "loading" ? "正在获取音频…" : source || (voiceChoice === "ai" ? "AI 语音需已配置密钥，播放时请求。" : "播放后写下你听到的内容")}{voiceChoice === "ai" ? " · 本页重复播放使用缓存" : ""}</p>
      </div>
      <details className="dictation-live-options">
        <summary>Live 语音指令与拼读</summary>
        <p className="dictation-note">题目由设备或核验过的 AI 音频播放，Live 只识别语音输入，不播题、不判分。开启后预留 5 分钟，等待与静音仍计时；提前结束不退还预留，实际费用以服务商为准。键盘作答无需开启。</p>
        {!submitted && !revealed && <div className="dictation-actions">
          {commandListening ? <><button className="secondary" type="button" disabled={liveSnapshot?.phase === "connecting"} onClick={() => void finishCommand()}>说完了，确认指令</button><button className="secondary" type="button" onClick={stop}>取消</button></> : <button className="secondary" type="button" disabled={liveUnconfirmed} onClick={() => void beginCommand()}><Mic size={16} />{liveSnapshot?.phase === "connected" ? "说一个指令" : "开启 Live 并说指令"}</button>}
          {commandDraft && <button className="secondary" type="button" onClick={executeCommand}>确认：{commandLabels[commandDraft.command]}</button>}
        </div>}
      </details>
      {notice && <p className="dictation-notice" role="alert">{notice}</p>}
      {!submitted && !revealed && <div className="dictation-answer-mode">
        <div className="segmented" aria-label="作答方式">
          <button type="button" aria-pressed={attempt.answerMode === "typed"} onClick={() => { stop(); apply({ type: "mode", attemptId: attemptRef.current.id, mode: "typed" }); }}>键盘作答</button>
          <button type="button" aria-pressed={attempt.answerMode === "spelled"} disabled={item.mode !== "words" || liveUnconfirmed} onClick={() => { stop(); apply({ type: "mode", attemptId: attemptRef.current.id, mode: "spelled" }); }}>逐字母拼读</button>
        </div>
        {attempt.answerMode === "spelled" && <>
          <p className="dictation-note">{spellingCapture?.label} · 点按钮后才开启麦克风。逐个说出字母，词间说“空格”；识别后先确认文字。</p>
          {attempt.phase === "capturing" ? <button className="secondary" type="button" disabled={captureFinishing || liveSnapshot?.phase === "connecting"} onClick={() => void finishSpelling()}><Square size={16} />{captureFinishing ? "正在整理拼读…" : liveSnapshot?.phase === "connecting" ? "正在连接…" : "结束拼读"}</button> : <button className="secondary" type="button" disabled={!heard || liveUnconfirmed} onClick={() => void beginSpelling()}><Mic size={16} />{liveSnapshot?.phase === "connected" ? "开始拼读" : "开启 Live 并开始拼读"}</button>}
          {attempt.phase === "capturing" && <button type="button" className="secondary" onClick={stop}>取消拼读</button>}
        </>}
      </div>}
      {hintVisible && <p className="dictation-notice">提示：{item.hint || "当前题目没有额外提示。"} · 本题作为辅助练习，不计入独立掌握。</p>}
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label htmlFor="voice-dictation-answer">{item.mode === "words" ? "写下听到的词或短语" : "写下听到的句子"}</label>
        <textarea ref={input} id="voice-dictation-answer" lang="en" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} rows={item.mode === "words" ? 2 : 3} maxLength={3000} value={answer} disabled={submitted || attempt.phase === "capturing"} placeholder="Type what you hear…" onChange={(event) => apply({ type: "edit", attemptId: attemptRef.current.id, answer: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        {attempt.answerMode === "spelled" && attempt.phase === "confirming" && <button className="secondary" type="button" disabled={!answer.trim()} onClick={() => apply({ type: "confirm", attemptId: attemptRef.current.id })}>确认这些字母</button>}
        {!submitted && !revealed && <div className="dictation-actions"><button className="primary" type="submit" disabled={!canSubmitDictation(attempt)}>核对答案</button><button className="secondary" type="button" onClick={showHint}>给我提示</button><button className="secondary" type="button" onClick={reveal}>显示答案</button></div>}
      </form>
      {(revealed || submitted) && <div className="dictation-feedback">
        {result && <h3>{result.correct ? "听写正确" : `匹配 ${result.matched} / ${result.total} 词`}</h3>}
        <p className="dictation-target" lang="en">{item.text}</p><p className="dictation-note">{item.hint} · {item.source}</p>
        {!submitted && <p className="dictation-note">本次已看答案，不记入掌握记录。可重新听写；本轮看过答案的题仍作为辅助练习。</p>}
        {submitted && attempt.assisted && <p className="dictation-note">本题使用过提示或答案，仅供练习，不计入独立掌握或改变错题记录。</p>}
        {result && !result.correct && <><p className="dictation-note">逐词对照：划线为多写或写错，下方为应写内容。</p><div className="dictation-diff" lang="en">{result.differences.map((part, index) => <span key={index} className={`dictation-token is-${part.kind}`}>{part.kind === "equal" ? part.expected : <>{part.actual && <del>{part.actual}</del>}{part.expected && <ins>{part.expected}</ins>}<small>{part.kind === "missing" ? "漏写" : part.kind === "extra" ? "多写" : "替换"}</small></>}</span>)}</div></>}
        <p className="dictation-note">忽略大小写和标点；接受已列明的常见缩写、英美拼写变体。含歧义的缩写按原文核对。此结果仅比较听写文字。</p>
        <div className="dictation-actions">{submitted && <button type="button" className="primary" onClick={() => { stop(); if (position + 1 >= queue.length) void live.current?.close(); setPosition(position + 1); resetAnswer(queue[position + 1]); input.current?.focus(); }}>下一项 <ArrowRight size={16} aria-hidden="true" /></button>}<button type="button" className="secondary" onClick={() => { stop(); resetAnswer(); input.current?.focus(); }}><RotateCcw size={15} aria-hidden="true" />重新听写</button></div>
      </div>}
    </div>}
    </div>
  </section>;
}
export default DictationPanel;
