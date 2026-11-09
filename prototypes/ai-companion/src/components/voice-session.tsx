import { useEffect, useRef, useState } from "react";
import { AudioLines, MicOff, PhoneOff, Send, Volume2, VolumeX } from "lucide-react";
import { respond } from "../engine";
import { AUDIO_ROUTE, buildRequest, checkSendable, classifyTask, MODEL_NAME, resolveRoute, routeTable, type RequestPayload } from "../routing";
import { useStore } from "../store";
import type { Block, Caption } from "../types";
import { Modal } from "./modal";

const SAMPLES = ["我今天只有 15 分钟", "这周我哪些词老写错？", "帮我安排两周复习，每天 20 分钟，周三没空，先复习错词再学新词"];

export function VoiceSession() {
  const { state, dispatch } = useStore();
  const open = state.voiceOpen;
  return (
    <Modal open={open} onClose={() => dispatch({ type: "voice-open", open: false })} title="语音会话" className="voice-modal">
      {open && <VoiceBody />}
    </Modal>
  );
}

function VoiceBody() {
  const { state, active, appendVoice, dispatch } = useStore();
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [phase, setPhase] = useState<"listening" | "speaking">("listening");
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState("");
  const kept = useRef<{ blocks: Block[]; request: RequestPayload | null; reason: string }>({ blocks: [], request: null, reason: "" });
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(captions);
  const list = useRef<HTMLOListElement>(null);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => { latest.current = captions; list.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [captions]);
  useEffect(() => {
    started.current = Date.now();
    const saved = kept;
    return () => {
      clearTimeout(timer.current);
      if (canSpeak) window.speechSynthesis.cancel();
      // Closing the session in any way returns what was said to the same conversation.
      appendVoice(latest.current, Math.round((Date.now() - started.current) / 1000), saved.current.blocks, saved.current.request, saved.current.reason);
    };
  }, [appendVoice, canSpeak]);

  const say = (text: string) => {
    const words = text.trim();
    if (!words || phase === "speaking") return;
    setTyped("");
    const draft = state.drafts[active.id];
    const classification = classifyTask({ text: words, hasQuote: false });
    const route = resolveRoute(classification, { nextOnly: null, preference: state.settings.routePreference }, routeTable(state.settings.complexPlanTier));
    const check = checkSendable(route, state.settings.service);
    let reply: string;
    if (!check.ok) {
      reply = `这句没有发出：${check.message}`;
    } else {
      const blocks = respond({ route, text: words, quotes: [], attachments: [], includeRecords: draft?.includeRecords ?? true, article: "none", settings: state.settings });
      const lead = blocks[0]?.type === "text" ? blocks[0].text.split("\n\n")[0] : "好的。";
      const rest = blocks.filter((block) => block.type !== "text");
      if (rest.length) {
        kept.current = {
          blocks, reason: `语音中委派：${route.reason}`,
          request: buildRequest(route, { records: draft?.includeRecords ?? true, article: "none", quotes: 0, quoteChars: 0, readFiles: [], attachmentsOnly: [] }),
        };
      }
      reply = rest.length ? `${lead}卡片会在结束语音后放进对话。` : lead;
    }
    setCaptions((value) => [...value, { speaker: "user", text: words }, { speaker: "ai", text: reply }]);
    setPhase("speaking");
    if (canSpeak && !muted) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(reply);
      utterance.lang = "zh-CN";
      utterance.onend = () => setPhase("listening");
      window.speechSynthesis.speak(utterance);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPhase("listening"), Math.min(4000, 900 + reply.length * 30));
  };

  return (
    <div className="voice">
      <p className="voice-banner"><MicOff size={15} aria-hidden="true" />演示：没有接通实时语音，不会使用麦克风。用下方文字代替说话；AI 的回答显示为字幕{canSpeak ? "，可用系统朗读播放" : ""}。</p>
      <div className="voice-state" role="status">
        <AudioLines size={20} aria-hidden="true" />
        <span>{phase === "speaking" ? (muted ? "AI 在回答（已静音，只看字幕）" : "AI 在回答") : "轮到你说"}</span>
        <span className="voice-route">{AUDIO_ROUTE.label} · 文字任务按学习路由{state.settings.routePreference !== "auto" ? `（默认 ${MODEL_NAME[state.settings.routePreference]}）` : ""}</span>
      </div>
      <ol className="caption-list live" ref={list} aria-label="字幕">
        {captions.length === 0 && <li className="caption-empty">字幕会显示在这里。结束后，整段字幕回到当前对话。</li>}
        {captions.map((caption, index) => <li key={index} className={`caption caption-${caption.speaker}`}><span className="who">{caption.speaker === "user" ? "你" : "AI"}</span>{caption.text}</li>)}
      </ol>
      <ul className="suggestions compact" aria-label="示例说法">
        {SAMPLES.map((text) => <li key={text}><button type="button" disabled={phase === "speaking"} onClick={() => say(text)}>{text}</button></li>)}
      </ul>
      <form className="voice-input" onSubmit={(event) => { event.preventDefault(); say(typed); }}>
        <label className="visually-hidden" htmlFor="voice-typed">用文字代替说话</label>
        <input id="voice-typed" className="text-field" value={typed} placeholder="用文字代替说话" onChange={(event) => setTyped(event.target.value)} />
        <button type="submit" className="icon-button" aria-label="说出这句" disabled={!typed.trim() || phase === "speaking"}><Send size={17} aria-hidden="true" /></button>
      </form>
      <div className="voice-controls">
        <button type="button" className="button button-secondary" aria-pressed={muted} disabled={!canSpeak}
          onClick={() => { setMuted((value) => !value); if (canSpeak) window.speechSynthesis.cancel(); }}>
          {muted ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}{muted ? "已静音" : "静音"}
        </button>
        <button type="button" className="button button-danger" onClick={() => dispatch({ type: "voice-open", open: false })}><PhoneOff size={17} aria-hidden="true" />结束</button>
      </div>
    </div>
  );
}
