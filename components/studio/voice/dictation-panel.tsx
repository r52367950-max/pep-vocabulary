"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Headphones, RotateCcw, Square, Volume2 } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { compareDictation, DICTATION_HISTORY_KEY, DICTATION_SENTENCES, parseDictationHistory, recordDictationAttempt, selectDictationRound, wordDictationItems, type DictationHistory, type DictationItem, type DictationMode } from "@/lib/voice/dictation";
import "./dictation.css";

type Playback = "idle" | "loading" | "playing";
export function DictationPanel({ entries, active = true }: { entries: LexiconIndexEntry[]; active?: boolean }) {
  const [mode, setMode] = useState<DictationMode>("words");
  const [queue, setQueue] = useState<DictationItem[]>([]);
  const [position, setPosition] = useState(0);
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [heard, setHeard] = useState(false);
  const [history, setHistory] = useState<DictationHistory[]>([]);
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
  const [slow, setSlow] = useState(false);
  const words = useMemo(() => wordDictationItems(entries), [entries]);
  const item = queue[position];
  const result = submitted && item ? compareDictation(item.text, answer) : null;
  const roundErrors = queue.filter((entry) => history.find((row) => row.item.id === entry.id && !row.resolved));
  const mistakes = history.filter((row) => row.mistakes > 0);

  const stopMedia = useCallback(() => {
    requestId.current++;
    controller.current?.abort(); controller.current = null;
    if (audio.current) { audio.current.pause(); audio.current.src = ""; audio.current = null; }
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);
  const stop = useCallback(() => { stopMedia(); setPlayback("idle"); }, [stopMedia]);
  useEffect(() => {
    let mounted = true;
    Promise.resolve().then(() => {
      if (!mounted) return;
      try { setHistory(parseDictationHistory(localStorage.getItem(DICTATION_HISTORY_KEY))); }
      catch { setStorageError(true); }
    });
    return () => { mounted = false; stopMedia(); };
  }, [stopMedia]);
  useEffect(() => {
    if (!active) stopMedia();
    // Reset the visible status on entry without delaying cancellation on exit.
    let mounted = true;
    Promise.resolve().then(() => { if (mounted) setPlayback("idle"); });
    return () => { mounted = false; };
  }, [active, stopMedia]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) stop(); };
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

  const resetAnswer = () => { setAnswer(""); setSubmitted(false); setRevealed(false); setHeard(false); setNotice(""); setSource(""); };
  const start = (items: DictationItem[]) => {
    stop(); setQueue(items); setPosition(0); resetAnswer(); setHistoryOpen(false);
  };
  const changeMode = (next: DictationMode) => { setHistoryOpen(false); stop(); setMode(next); setQueue([]); setPosition(0); resetAnswer(); };
  const deviceSpeak = (text: string, rate: number, id: number) => {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setNotice("此浏览器没有可用的设备朗读。可切换 AI 语音，或在 Safari 中重试。"); return;
    }
    const voices = window.speechSynthesis.getVoices();
    const english = voices.find((voice) => /^en[-_]/i.test(voice.lang) && voice.localService) ?? voices.find((voice) => /^en[-_]/i.test(voice.lang));
    if (voices.length && !english) { setNotice("设备未安装英语声音，请在系统中添加英语朗读声音，或使用 AI 语音。"); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-GB"; utterance.rate = rate; if (english) utterance.voice = english;
    utterance.onstart = () => { if (requestId.current === id) { setPlayback("playing"); setHeard(true); } };
    utterance.onend = () => { if (requestId.current === id) setPlayback("idle"); };
    utterance.onerror = () => { if (requestId.current === id) { setPlayback("idle"); setNotice("设备朗读未能播放。请检查声音设置，再点一次播放；也可以切换 AI 语音。"); } };
    setSource(english?.localService ? "设备朗读 · 本地英语合成音" : "设备朗读 · 系统英语合成音（可能需要网络）");
    window.speechSynthesis.speak(utterance);
  };
  const play = async (rate: number) => {
    if (!item || !active) return;
    stop(); setNotice("");
    const id = requestId.current;
    if (voiceChoice === "device") { deviceSpeak(item.text, rate, id); return; }
    setPlayback("loading"); setSource("AI 语音 · 合成音");
    const key = item.text;
    const abort = new AbortController(); controller.current = abort;
    try {
      // Safari may require another tap after loading; the catch keeps the paid result cached.
      const player = new Audio(); audio.current = player;
      let blob = cache.current.get(key);
      if (!blob) {
        const response = await fetch("/api/voice/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: item.text, rate: 1 }), signal: abort.signal });
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
      if (id === requestId.current) { setPlayback("playing"); setHeard(true); }
    } catch (error) {
      if (id !== requestId.current || abort.signal.aborted) return;
      setPlayback("idle");
      setNotice(error instanceof DOMException && error.name === "NotAllowedError" ? "浏览器暂时阻止了声音播放。请再次点播放；音频已缓存，不会重复请求。" : error instanceof Error ? error.message : "语音暂时不可用，可改用设备朗读。");
    }
  };
  const submit = () => {
    if (!item || !heard || !answer.trim() || submitted || revealed) return;
    stop(); setSubmitted(true); setRevealed(true);
    const next = recordDictationAttempt(history, item, answer);
    setHistory(next);
    try { localStorage.setItem(DICTATION_HISTORY_KEY, JSON.stringify(next)); }
    catch { setStorageError(true); }
  };

  return <section className="dictation-panel" aria-label="听写练习" hidden={!active}>
    <div className="dictation-toolbar">
      <div className="segmented" aria-label="听写内容">
        <button type="button" aria-pressed={!historyOpen && mode === "words"} onClick={() => changeMode("words")}>词与短语</button>
        <button type="button" aria-pressed={!historyOpen && mode === "sentences"} onClick={() => changeMode("sentences")}>句子精听</button>
        <button type="button" aria-pressed={historyOpen} onClick={() => { stop(); setHistoryOpen(!historyOpen); }}>错题{mistakes.length ? ` · ${mistakes.length}` : ""}</button>
      </div>
    </div>
    {storageError && <p className="dictation-notice" role="status">浏览器未能保存记录；本次仍可练习，离开页面后可能丢失。</p>}
    <div ref={stage} className="dictation-stage">
    {historyOpen ? <div className="dictation-history">
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
      <p>{queue.length}项练习 · {roundErrors.length ? `${roundErrors.length}项还可以再练` : "本组最近一次均已答对"}</p>
      <div className="dictation-actions">{roundErrors.length > 0 && <button type="button" className="primary" onClick={() => start(roundErrors)}>再练本轮错题</button>}<button type="button" className="secondary" onClick={() => { setQueue([]); resetAnswer(); }}>返回选题</button></div>
    </div> : <div className="dictation-exercise">
      <div className="dictation-meta"><span>{item.mode === "words" ? "词与短语" : "句子精听"} · {position + 1} / {queue.length}</span><button type="button" onClick={() => { stop(); setQueue([]); resetAnswer(); }}>结束本组</button></div>
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
      {notice && <p className="dictation-notice" role="alert">{notice}</p>}
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label htmlFor="voice-dictation-answer">{item.mode === "words" ? "写下听到的词或短语" : "写下听到的句子"}</label>
        <textarea ref={input} id="voice-dictation-answer" lang="en" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} rows={item.mode === "words" ? 2 : 3} maxLength={3000} value={answer} disabled={submitted} placeholder="Type what you hear…" onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        {!submitted && <div className="dictation-actions"><button className="primary" type="submit" disabled={!heard || !answer.trim() || revealed}>核对答案</button><button className="secondary" type="button" onClick={() => setRevealed(true)}>显示答案</button></div>}
      </form>
      {(revealed || submitted) && <div className="dictation-feedback">
        {result && <h3>{result.correct ? "听写正确" : `匹配 ${result.matched} / ${result.total} 词`}</h3>}
        <p className="dictation-target" lang="en">{item.text}</p><p className="dictation-note">{item.hint} · {item.source}</p>
        {!submitted && <p className="dictation-note">本次已看答案，不记入掌握记录。隐藏答案后可重新听写。</p>}
        {result && !result.correct && <><p className="dictation-note">逐词对照：划线为多写或写错，下方为应写内容。</p><div className="dictation-diff" lang="en">{result.differences.map((part, index) => <span key={index} className={`dictation-token is-${part.kind}`}>{part.kind === "equal" ? part.expected : <>{part.actual && <del>{part.actual}</del>}{part.expected && <ins>{part.expected}</ins>}<small>{part.kind === "missing" ? "漏写" : part.kind === "extra" ? "多写" : "替换"}</small></>}</span>)}</div></>}
        <p className="dictation-note">忽略大小写和标点；接受已列明的常见缩写、英美拼写变体。含歧义的缩写按原文核对。此结果仅比较听写文字。</p>
        <div className="dictation-actions">{submitted && <button type="button" className="primary" onClick={() => { stop(); setPosition(position + 1); resetAnswer(); input.current?.focus(); }}>下一项 <ArrowRight size={16} aria-hidden="true" /></button>}<button type="button" className="secondary" onClick={() => { stop(); resetAnswer(); input.current?.focus(); }}><RotateCcw size={15} aria-hidden="true" />重新听写</button></div>
      </div>}
    </div>}
    </div>
  </section>;
}
export default DictationPanel;
