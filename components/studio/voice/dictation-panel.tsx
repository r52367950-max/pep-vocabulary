"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Headphones, Mic, RotateCcw, Square, Volume2 } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { compareDictation, DICTATION_SENTENCES, readLocalDictationHistory, saveLocalDictationAttempt, selectDictationRound, wordDictationItems, type DictationHistory, type DictationItem, type DictationMode } from "@/lib/voice/dictation";
import { localPracticeGeneration, practiceGenerationCurrent, type PracticeGeneration } from "@/lib/local-practice-generation";
import { DictationLiveInput, dictationVoiceCommand, canSubmitDictation, newDictationAttempt, reduceDictationAttempt, spellingDraft, type DictationAttemptEvent, type DictationLearningPreferences, type SpellingCaptureAdapter, type DictationVoiceCommand } from "@/lib/voice/dictation-session";
import { learningContextStore, refreshLearningContext, contextStillCurrent } from "@/lib/learning-context-client";
import { voiceRequest, type VoiceSnapshot } from "@/lib/voice/client";
import { recordLearningActivity } from "@/lib/learning-journal-client";
import { PaperDictation } from "./paper-dictation";
import "./dictation.css";
export type PreparedDictationPlan = { items: DictationItem[]; reason: string; clarification: string; selection?: 'theme' | 'grounded' };

type Playback = "idle" | "loading" | "playing";
export function DictationPanel({ entries, active = true, temporary = false, learningPreferences, spellingCapture: suppliedCapture, accountScope, contextEpoch = 0, onLiveActiveChange, onLiveUnconfirmedChange, onAttempt, preparedPlan, conversationContext = "" }: {
  entries: LexiconIndexEntry[]; active?: boolean; temporary?: boolean; preparedPlan?: PreparedDictationPlan | null; conversationContext?: string;
  learningPreferences?: DictationLearningPreferences; spellingCapture?: SpellingCaptureAdapter;
  accountScope?: string; contextEpoch?: number; onLiveActiveChange?: (active: boolean) => void; onLiveUnconfirmedChange?: (unconfirmed: boolean) => void;
  onAttempt?: (attempt: { item: DictationItem; answer: string; correct: boolean; assisted: boolean }) => void;
}) {
  const [suggestion, setSuggestion] = useState<PreparedDictationPlan | null>(null);
  const [appliedPlan, setAppliedPlan] = useState<{ plan: PreparedDictationPlan | null; key: string } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [requestText, setRequestText] = useState("");
  const [paperMode, setPaperMode] = useState(false);
  const [heardItemIds, setHeardItemIds] = useState<string[]>([]);
  const planAbort = useRef<AbortController | null>(null);
  const planAttempted = useRef("");
  const live = useRef<DictationLiveInput | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<VoiceSnapshot | null>(null);
  const [liveUnconfirmed, setLiveUnconfirmed] = useState(false);
  const callbacks = useRef({ onLiveActiveChange, onLiveUnconfirmedChange });
  useEffect(() => { callbacks.current = { onLiveActiveChange, onLiveUnconfirmedChange }; }, [onLiveActiveChange, onLiveUnconfirmedChange]);
  const [commandDraft, setCommandDraft] = useState<{ attemptId: string; command: DictationVoiceCommand } | null>(null);
  const [commandListening, setCommandListening] = useState(false);
  const commandCapture = useRef<{ handle: Awaited<ReturnType<SpellingCaptureAdapter["start"]>>; abort: AbortController; attemptId: string } | null>(null);
  const [mode, setMode] = useState<DictationMode>("words");
  const [queue, setQueue] = useState<DictationItem[]>([]);
  const [position, setPosition] = useState(0);
  const [attempt, setAttempt] = useState(() => newDictationAttempt("initial", ""));
  const attemptRef = useRef(attempt);
  const apply = useCallback((event: DictationAttemptEvent) => {
    const next = reduceDictationAttempt(attemptRef.current, event);
    if (next !== attemptRef.current) { attemptRef.current = next; setAttempt(next); if (event.type === "heard" && next.heard) setHeardItemIds((ids) => ids.includes(next.itemId) ? ids : [...ids, next.itemId]); }
    return next;
  }, []);
  const { answer, heard } = attempt;
  const submitted = attempt.phase === "submitted";
  const revealed = attempt.phase === "revealed";
  const [hintVisible, setHintVisible] = useState(false);
  const exposed = useRef(new Set<string>());
  const [roundResults, setRoundResults] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<DictationHistory[]>([]);
  const roundGeneration = useRef<PracticeGeneration>(null);
  const historySequence = useRef(0);
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
  const adjustment = useRef<HTMLDetailsElement>(null);
  const [slow, setSlow] = useState(learningPreferences?.preferredSpeed === "slow");
  const words = useMemo(() => wordDictationItems(entries), [entries]);
  const item = queue[position];
  const result = submitted && item ? compareDictation(item.text, answer) : null;
  const roundErrors = queue.filter((entry) => roundResults[entry.id] !== true);
  const mistakes = history.filter((row) => row.mistakes > 0);
  const directItems = mode === "words" ? words : DICTATION_SENTENCES;
  const directCount = Math.min(mode === "words" ? 12 : 6, directItems.length);

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
  const captureLabel = suppliedCapture?.label ?? "Live 语音输入（可能计费，固定题目仍由设备或 AI 音频播放）";
  const spellingCapture = useMemo<SpellingCaptureAdapter>(() => suppliedCapture ?? ({
    label: "Live 语音输入（可能计费，固定题目仍由设备或 AI 音频播放）",
    start: async ({ signal }) => {
      const transport = live.current;
      if (!transport || signal.aborted) throw new Error("语音输入已取消。");
      const cancelOpening = () => { void transport.close(); };
      signal.addEventListener("abort", cancelOpening, { once: true });
      try {
        const globalTemporary = learningContextStore.get().temporary;
        const memory = await refreshLearningContext(signal);
        if (signal.aborted || !contextStillCurrent(memory, globalTemporary) || (accountScope && accountScope !== memory.accountScope)) throw new Error("账户或学习模式已改变，请重新开始。");
        await transport.open(temporary, { accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion });
        if (signal.aborted) throw new Error("语音输入已取消。");
        return transport.begin(signal);
      } finally { signal.removeEventListener("abort", cancelOpening); }
    },
  }), [suppliedCapture, temporary, accountScope]);
  useEffect(() => {
    let mounted = true;
    const sequence = ++historySequence.current;
    stopMedia(); void live.current?.close(); planAbort.current?.abort(); planAttempted.current = ""; cache.current.clear(); roundGeneration.current = null;
    Promise.resolve().then(() => {
      if (!mounted) return;
      setQueue([]); setHeardItemIds([]); setSuggestion(null); setAppliedPlan(null); setPosition(0); setHistory([]); setHistoryOpen(false); setStorageError(false); setHintVisible(false); setRoundResults({}); exposed.current.clear(); setCommandDraft(null); setCommandListening(false); setPlayback("idle");
      const fresh = newDictationAttempt(crypto.randomUUID(), ""); attemptRef.current = fresh; setAttempt(fresh);
      if (temporary || !accountScope) return;
      void readLocalDictationHistory(accountScope).then((snapshot) => {
        if (mounted && sequence === historySequence.current && practiceGenerationCurrent(snapshot.generation)) setHistory(snapshot.value);
      }).catch(() => { if (mounted && sequence === historySequence.current) setStorageError(true); });
    });
    return () => { mounted = false; stopMedia(); };
  }, [stopMedia, temporary, accountScope, contextEpoch]);
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
  const start = async (items: DictationItem[]) => {
    if (!items.length) return;
    planAbort.current?.abort();
    setPlanBusy(false); setPlanError("");
    adjustment.current?.removeAttribute("open");
    const sequence = ++historySequence.current;
    let generation = localPracticeGeneration();
    setHistory([]);
    if (!temporary && accountScope) {
      try {
        const snapshot = await readLocalDictationHistory(accountScope);
        if (sequence !== historySequence.current || !practiceGenerationCurrent(snapshot.generation)) return;
        generation = snapshot.generation; setHistory(snapshot.value);
      } catch { setStorageError(true); }
    }
    if (sequence !== historySequence.current) return;
    roundGeneration.current = generation;
    stop(); setHeardItemIds([]); setSlow(learningPreferences?.preferredSpeed === "slow"); exposed.current.clear(); setRoundResults({}); setQueue(items); setPosition(0); resetAnswer(items[0]); setHistoryOpen(false);
  };
  const prepare = async () => {
    planAbort.current?.abort(); const abort = new AbortController(); planAbort.current = abort;
    setPlanBusy(true); setPlanError("");
    try {
      const globalTemporary = learningContextStore.get().temporary;
      const context = await refreshLearningContext(abort.signal);
      const plan = await voiceRequest<PreparedDictationPlan>("/api/voice/dictation-plan", { operationId: crypto.randomUUID(), text: (requestText.trim() || conversationContext).slice(-2000), allowTopicWords: mode === "words", accountScope: context.accountScope, contextRevision: context.revision, contextVersion: context.contextVersion, temporary }, abort.signal);
      await refreshLearningContext(abort.signal);
      if (!abort.signal.aborted && contextStillCurrent(context, globalTemporary)) setSuggestion(plan);
    } catch (error) { if (!abort.signal.aborted) setPlanError(error instanceof Error ? error.message : "推荐暂时未完成，请重试。"); }
    finally { if (planAbort.current === abort) setPlanBusy(false); }
  };
  const cancelPlan = () => { planAbort.current?.abort(); planAbort.current = null; setPlanBusy(false); };
  // A plan prepared in conversation becomes the suggestion whenever no round is running,
  // and again after the account, learning context or round changes.
  const incomingPlan = preparedPlan && !queue.length ? preparedPlan : null;
  const planKey = `${accountScope}:${contextEpoch}`;
  if (!appliedPlan || appliedPlan.plan !== incomingPlan || appliedPlan.key !== planKey) {
    setAppliedPlan({ plan: incomingPlan, key: planKey });
    if (incomingPlan) setSuggestion(incomingPlan);
  }
  // A supplied plan counts as this context's recommendation, so none is requested for it.
  useEffect(() => {
    if (incomingPlan) planAttempted.current = planKey;
  }, [incomingPlan, planKey]);
  // Requests at most one recommendation per account and context, only when the panel opens
  // idle with conversation to draw on. Busy and supplied-plan state are read, not watched.
  const prepareOnEntry = useEffectEvent(() => {
    if (!active || !accountScope || !conversationContext.trim() || queue.length || planBusy || preparedPlan || planAttempted.current === planKey) return;
    planAttempted.current = planKey;
    void prepare();
  });
  useEffect(() => { prepareOnEntry(); }, [active, accountScope, contextEpoch, queue.length, conversationContext]);
  useEffect(() => () => { planAbort.current?.abort(); }, []);
  const changeMode = (next: DictationMode) => { cancelPlan(); setSuggestion(null); setPlanError(""); setHistoryOpen(false); stop(); setMode(next); setQueue([]); setPosition(0); resetAnswer(); };
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
        const globalTemporary = learningContextStore.get().temporary;
        const memory = await refreshLearningContext(abort.signal);
        if (abort.signal.aborted || id !== requestId.current) return;
        if (!contextStillCurrent(memory, globalTemporary) || (accountScope && accountScope !== memory.accountScope)) throw new Error("账户或学习设置已改变，请重新播放。");
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
      setNotice(error instanceof DOMException && error.name === "NotAllowedError" ? "请再点一次播放。音频已缓存。" : error instanceof Error ? error.message : "语音暂时不可用，可改用设备朗读。");
    }
  };
  const submit = async () => {
    const current = attemptRef.current;
    if (!item || current.itemId !== item.id || !canSubmitDictation(current)) return;
    const accepted = apply({ type: "submit", attemptId: current.id });
    if (accepted.phase !== "submitted" || accepted === current) return;
    stop();
    const correct = compareDictation(item.text, accepted.answer).correct;
    onAttempt?.({ item, answer: accepted.answer, correct, assisted: accepted.assisted });
    if (!temporary && accountScope) void recordLearningActivity({ eventId: `dictation-${accepted.id}`, kind: "dictation", title: "听写练习", counts: { total: 1, correct: correct && !accepted.assisted ? 1 : 0, assisted: accepted.assisted ? 1 : 0 } }, { accountScope });
    setRoundResults((previous) => ({ ...previous, [item.id]: correct && !accepted.assisted }));
    // Assisted answers can be reviewed, but never resolve a mistake or count as independent mastery.
    if (accepted.assisted || temporary || !accountScope) return;
    const generation = roundGeneration.current, sequence = historySequence.current;
    try {
      const next = await saveLocalDictationAttempt(accountScope, generation, item, accepted.answer, () => {
        const current = learningContextStore.get();
        return sequence === historySequence.current && !current.temporary && current.memory?.accountScope === accountScope;
      });
      if (sequence === historySequence.current && practiceGenerationCurrent(generation)) setHistory(next);
    }
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
      setNotice(draft.uncertain ? "请核对识别出的字母，修改标记为不确定的部分后确认。" : "核对识别出的字母后确认。");
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
  const endRound = () => { stop(); void live.current?.close(); setQueue([]); resetAnswer(); };
  const recordPaperGrade = ({ correct, total }: { correct: number; total: number }) => {
    if (temporary || !accountScope) return;
    void recordLearningActivity({
      eventId: `paper-${attemptRef.current.id}`,
      kind: "dictation",
      title: "纸上听写批改",
      counts: { total, correct, assisted: total },
    }, { accountScope });
  };

  return (
    <section className="dictation-panel" aria-label="听写练习" hidden={!active}>
      <div className="dictation-toolbar dictation-toolbar-simple">
        <span>{queue.length ? `本组 ${queue.length} 项` : mode === "words" ? "当前教材 · 词与短语" : "句子精听"}</span>
        <details ref={adjustment} className="dictation-adjust">
          <summary>调整</summary>
          <div>
            <label>
              练习内容 <select value={mode} onChange={(event) => changeMode(event.target.value as DictationMode)}>
                <option value="words">词与短语</option>
                <option value="sentences">句子精听</option>
              </select>
            </label>
            <button
              type="button"
              className="text-button"
              onClick={() => { stop(); setHistoryOpen(!historyOpen); adjustment.current?.removeAttribute("open"); }}
            >
              {historyOpen ? "返回听写" : "查看错题"}{!historyOpen && mistakes.length ? ` · ${mistakes.length}` : ""}
            </button>
            {queue.length > 0 && (
              <button type="button" className="text-button" onClick={() => void start(selectDictationRound(directItems, directCount))}>换一组</button>
            )}
          </div>
        </details>
      </div>
      {temporary && <p className="dictation-note">临时练习 · 不读取或保存听写历史</p>}
      {storageError && <p className="dictation-notice" role="status">浏览器未能保存记录；本次仍可练习，离开页面后可能丢失。</p>}
      <div ref={stage} className="dictation-stage">
        {historyOpen && !temporary ? (
          <div className="dictation-history">
            <h2>听写错题</h2>
            <p className="dictation-note">最近 300 条听写记录。</p>
            {mistakes.length ? (
              <>
                <button
                  type="button"
                  className="primary"
                  onClick={() => start(mistakes.filter((row) => !row.resolved).map((row) => row.item).slice(0, 12))}
                  disabled={!mistakes.some((row) => !row.resolved)}
                >
                  再练尚未掌握的错题
                </button>
                <ul>
                  {mistakes.map((row) => (
                    <li key={row.item.id}>
                      <div>
                        <strong lang="en">{row.item.text}</strong>
                        <small>{row.mistakes}次出错 · {row.resolved ? "最近一次已答对" : "待再练"} · {new Date(row.lastAt).toLocaleDateString("zh-CN")}</small>
                      </div>
                      <button type="button" className="secondary" onClick={() => start([row.item])}>再练</button>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="empty">还没有错题，先完成一组听写。</p>}
          </div>
        ) : !queue.length ? (
          <div className="dictation-intro">
            <span className="dictation-emblem"><Headphones size={28} aria-hidden="true" /></span>
            <h2>听一组，记下来。</h2>
            <p aria-live="polite">
              {suggestion?.items.length
                ? suggestion.selection === "theme"
                  ? `已按主题选好 ${suggestion.items.length} 个词与短语。`
                  : `已从学习材料中准备 ${suggestion.items.length} 项。`
                : directCount
                  ? `练习${mode === "words" ? "当前教材中的" : "一组"} ${directCount} ${mode === "words" ? "个词与短语" : "个短句"}。`
                  : "当前范围没有可听写的词，请换个教材或单元。"}
            </p>
            <button
              type="button"
              className="primary"
              disabled={!suggestion?.items.length && !directCount}
              onClick={() => void start(suggestion?.items.length ? suggestion.items : selectDictationRound(directItems, directCount))}
            >
              开始听写 <ArrowRight size={16} aria-hidden="true" />
            </button>
            <p className="dictation-note">可以用键盘，也可以写在纸上</p>
            <details className="dictation-plan-options">
              <summary>{mode === "words" ? "让 AI 按主题找词" : "按学习内容推荐"}</summary>
              <form
                className="dictation-request"
                onSubmit={(event) => { event.preventDefault(); if (planBusy) cancelPlan(); else if (requestText.trim()) void prepare(); }}
              >
                <label htmlFor="dictation-request">{mode === "words" ? "想找什么词？" : "想练习什么？"}</label>
                <div>
                  <textarea
                    id="dictation-request"
                    value={requestText}
                    rows={2}
                    maxLength={1000}
                    readOnly={planBusy}
                    aria-describedby="dictation-request-help"
                    placeholder={mode === "words" ? "例如：与冬天意象有关的词，适合高中水平" : "例如：必修一第一单元，或某篇文章的标题"}
                    onChange={(event) => setRequestText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <button className="text-button" disabled={!planBusy && !requestText.trim()}>{planBusy ? "取消" : mode === "words" ? "找词" : "推荐"}</button>
                </div>
                <p id="dictation-request-help" className="dictation-note">
                  {mode === "words" ? "可按主题、意境或教材选词，沿用已配置的 AI。" : "文章听写请提供标题或在阅读页选中片段。"}
                </p>
              </form>
              {planBusy && <p className="dictation-note" role="status">{mode === "words" ? "AI 正在选词…" : "正在准备推荐…"}</p>}
              {planError && (
                <p className="dictation-notice" role="alert">
                  {planError} <button className="text-button" onClick={() => void prepare()}>重试</button>
                </p>
              )}
              {!planBusy && !planError && suggestion?.clarification && <p className="dictation-note">{suggestion.clarification}</p>}
            </details>
          </div>
        ) : !item ? (
          <div className="dictation-intro">
            <span className="dictation-emblem"><Check size={28} aria-hidden="true" /></span>
            <h2>这一组，听完了。</h2>
            <p>{queue.length}项练习 · {roundErrors.length ? `${roundErrors.length}项待批改或再练` : "本组已独立答对"}</p>
            <div className="dictation-actions">
              {roundErrors.length > 0 && <button type="button" className="primary" onClick={() => start(roundErrors)}>继续练习</button>}
              <button type="button" className="secondary" onClick={endRound}>返回选题</button>
            </div>
          </div>
        ) : (
          <div className="dictation-exercise">
            <div className="dictation-meta">
              <span>{item.mode === "words" ? "词与短语" : "句子精听"} · {position + 1} / {queue.length}</span>
              <button type="button" onClick={endRound}>结束本组</button>
            </div>
            <div className={`dictation-audio is-${playback}`}>
              <label className="dictation-voice-label">
                朗读方式 <select value={voiceChoice} onChange={(event) => { stop(); setVoiceChoice(event.target.value as "device" | "ai"); setSource(""); }}>
                  <option value="device">设备朗读 · 不用 API</option>
                  <option value="ai">AI 语音 · 联网使用 API</option>
                </select>
              </label>
              <div className="dictation-actions">
                <button
                  type="button"
                  className="dictation-play"
                  aria-busy={playback === "loading"}
                  onClick={() => {
                    if (playback !== "idle") { stop(); if (voiceChoice === "ai") setNotice("已停止播放或请求。服务已经处理的请求仍可能计费。"); }
                    else void play(slow ? 0.8 : 1);
                  }}
                >
                  {playback !== "idle" ? <Square size={22} aria-hidden="true" /> : <Volume2 size={24} aria-hidden="true" />}
                  {playback === "loading" ? "停止获取" : playback === "playing" ? "停止播放" : heard ? "再听一次" : "播放音频"}
                </button>
                <button
                  type="button"
                  className="dictation-speed"
                  aria-pressed={slow}
                  disabled={playback === "loading"}
                  onClick={() => { const next = !slow; setSlow(next); if (playback === "playing") void play(next ? 0.8 : 1); }}
                >
                  0.8× 慢速
                </button>
              </div>
              <p className="dictation-note" role="status">
                {playback === "loading" ? "正在获取音频…" : source || (voiceChoice === "ai" ? "AI 语音需已配置密钥，播放时请求。" : "播放后写下你听到的内容")}
                {voiceChoice === "ai" ? " · 本页重复播放使用缓存" : ""}
              </p>
            </div>
            <details className="dictation-live-options">
              <summary>Live 语音指令与拼读</summary>
              <p className="dictation-note">开启后可说指令或拼读作答，预留 5 分钟额度；等待与静音计时，提前结束不退还预留额度。</p>
              {!submitted && !revealed && (
                <div className="dictation-actions">
                  {commandListening ? (
                    <>
                      <button className="secondary" type="button" disabled={liveSnapshot?.phase === "connecting"} onClick={() => void finishCommand()}>说完了，确认指令</button>
                      <button className="secondary" type="button" onClick={stop}>取消</button>
                    </>
                  ) : (
                    <button className="secondary" type="button" disabled={liveUnconfirmed} onClick={() => void beginCommand()}>
                      <Mic size={16} />{liveSnapshot?.phase === "connected" ? "说一个指令" : "开启 Live 并说指令"}
                    </button>
                  )}
                  {commandDraft && <button className="secondary" type="button" onClick={executeCommand}>确认：{commandLabels[commandDraft.command]}</button>}
                </div>
              )}
            </details>
            {notice && <p className="dictation-notice" role="alert">{notice}</p>}
            {!submitted && !revealed && (
              <div className="dictation-answer-mode">
                <div className="segmented" aria-label="作答方式">
                  <button type="button" aria-pressed={paperMode} onClick={() => { stop(); setPaperMode(!paperMode); }}>纸上作答</button>
                  <button
                    type="button"
                    aria-pressed={!paperMode && attempt.answerMode === "typed"}
                    onClick={() => { stop(); setPaperMode(false); apply({ type: "mode", attemptId: attemptRef.current.id, mode: "typed" }); }}
                  >
                    键盘作答
                  </button>
                  <button
                    type="button"
                    aria-pressed={!paperMode && attempt.answerMode === "spelled"}
                    disabled={item.mode !== "words" || liveUnconfirmed}
                    onClick={() => { stop(); setPaperMode(false); apply({ type: "mode", attemptId: attemptRef.current.id, mode: "spelled" }); }}
                  >
                    逐字母拼读
                  </button>
                </div>
                {!paperMode && attempt.answerMode === "spelled" && (
                  <>
                    <p className="dictation-note">{captureLabel} · 点按钮后才开启麦克风。逐个说出字母，词间说“空格”；识别后先确认文字。</p>
                    {attempt.phase === "capturing" ? (
                      <button className="secondary" type="button" disabled={captureFinishing || liveSnapshot?.phase === "connecting"} onClick={() => void finishSpelling()}>
                        <Square size={16} />{captureFinishing ? "正在整理拼读…" : liveSnapshot?.phase === "connecting" ? "正在连接…" : "结束拼读"}
                      </button>
                    ) : (
                      <button className="secondary" type="button" disabled={!heard || liveUnconfirmed} onClick={() => void beginSpelling()}>
                        <Mic size={16} />{liveSnapshot?.phase === "connected" ? "开始拼读" : "开启 Live 并开始拼读"}
                      </button>
                    )}
                    {attempt.phase === "capturing" && <button type="button" className="secondary" onClick={stop}>取消拼读</button>}
                  </>
                )}
              </div>
            )}
            {hintVisible && <p className="dictation-notice">提示：{item.hint || "当前题目没有额外提示。"} · 辅助练习</p>}
            {paperMode ? (
              <div className="dictation-paper-progress">
                <p className="dictation-note">在纸上写下第 {position + 1} 题。听完后可拍照，核对识别文字再批改。</p>
                <button
                  type="button"
                  className="primary"
                  disabled={!heard}
                  onClick={() => { stop(); if (position + 1 >= queue.length) void live.current?.close(); setPosition(position + 1); resetAnswer(queue[position + 1]); }}
                >
                  写好了，下一题
                </button>
              </div>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
                <label htmlFor="voice-dictation-answer">{item.mode === "words" ? "写下听到的词或短语" : "写下听到的句子"}</label>
                <textarea
                  ref={input}
                  id="voice-dictation-answer"
                  lang="en"
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  rows={item.mode === "words" ? 2 : 3}
                  maxLength={3000}
                  value={answer}
                  disabled={submitted || attempt.phase === "capturing"}
                  placeholder="Type what you hear…"
                  onChange={(event) => apply({ type: "edit", attemptId: attemptRef.current.id, answer: event.target.value })}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
                />
                {attempt.answerMode === "spelled" && attempt.phase === "confirming" && (
                  <button className="secondary" type="button" disabled={!answer.trim()} onClick={() => apply({ type: "confirm", attemptId: attemptRef.current.id })}>确认这些字母</button>
                )}
                {!submitted && !revealed && (
                  <div className="dictation-actions">
                    <button className="primary" type="submit" disabled={!canSubmitDictation(attempt)}>核对答案</button>
                    <button className="secondary" type="button" onClick={showHint}>给我提示</button>
                    <button className="secondary" type="button" onClick={reveal}>显示答案</button>
                  </div>
                )}
              </form>
            )}
            {(revealed || submitted) && (
              <div className="dictation-feedback">
                {result && <h3>{result.correct ? "听写正确" : `匹配 ${result.matched} / ${result.total} 词`}</h3>}
                <p className="dictation-target" lang="en">{item.text}</p>
                <p className="dictation-note">{item.hint} · {item.source}</p>
                {!submitted && <p className="dictation-note">已看答案 · 本轮记为辅助练习，可重新听写。</p>}
                {submitted && attempt.assisted && <p className="dictation-note">已使用提示或答案 · 辅助练习。</p>}
                {result && !result.correct && (
                  <>
                    <p className="dictation-note">逐词对照：划线为多写或写错，下方为应写内容。</p>
                    <div className="dictation-diff" lang="en">
                      {result.differences.map((part, index) => (
                        <span key={index} className={`dictation-token is-${part.kind}`}>
                          {part.kind === "equal" ? part.expected : (
                            <>
                              {part.actual && <del>{part.actual}</del>}
                              {part.expected && <ins>{part.expected}</ins>}
                              <small>{part.kind === "missing" ? "漏写" : part.kind === "extra" ? "多写" : "替换"}</small>
                            </>
                          )}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                <p className="dictation-note">忽略大小写和标点，接受常见缩写及英美拼写变体；有歧义时按原文核对。</p>
                <div className="dictation-actions">
                  {submitted && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => { stop(); if (position + 1 >= queue.length) void live.current?.close(); setPosition(position + 1); resetAnswer(queue[position + 1]); input.current?.focus(); }}
                    >
                      下一项 <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={() => { stop(); resetAnswer(); input.current?.focus(); }}>
                    <RotateCcw size={15} aria-hidden="true" />重新听写
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {queue.length > 0 && (
        <PaperDictation
          items={queue}
          heardItemIds={heardItemIds}
          temporary={temporary}
          accountScope={accountScope}
          contextEpoch={contextEpoch}
          onGraded={recordPaperGrade}
        />
      )}
    </section>
  );
}
export default DictationPanel;
