import { useEffect, useRef, useState } from "react";
import { ArrowUp, AudioLines, MicOff, Volume2, VolumeX, X } from "lucide-react";
import { respond } from "../engine";
import { AUDIO_ROUTE, buildRequest, checkSendable, classifyTask, MODEL_NAME, resolveRoute, routeTable, type RequestPayload } from "../routing";
import { useStore } from "../store";
import type { Block, Caption } from "../types";
import { TraceGlyph } from "./icons";

const SAMPLES = ["我今天只有 15 分钟", "这周我哪些词老写错？", "帮我安排两周复习，每天 20 分钟，周三没空，先复习错词再学新词"];

/**
 * Voice takes the whole conversation area, as voice modes do: captions above, controls below.
 * Nothing listens to a microphone; typed lines stand in for speech and the state never pretends
 * to follow a voice level.
 */
export function VoiceStage({ conversationId }: { conversationId: string }) {
  const { state, appendVoice, dispatch } = useStore();
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [phase, setPhase] = useState<"listening" | "speaking">("listening");
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState("");
  const kept = useRef<{ blocks: Block[]; request: RequestPayload | null; reason: string }>({ blocks: [], request: null, reason: "" });
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(captions);
  const lines = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    latest.current = captions;
    const element = lines.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [captions]);
  useEffect(() => {
    started.current = Date.now();
    input.current?.focus({ preventScroll: true });
    const saved = kept;
    return () => {
      clearTimeout(timer.current);
      if (canSpeak) window.speechSynthesis.cancel();
      // However the session ends, what was said returns to the same conversation.
      appendVoice(conversationId, latest.current, Math.round((Date.now() - started.current) / 1000), saved.current.blocks, saved.current.request, saved.current.reason);
    };
  }, [appendVoice, canSpeak, conversationId]);

  const end = () => { dispatch({ type: "voice-open", open: false }); dispatch({ type: "focus-composer" }); };

  const say = (text: string) => {
    const words = text.trim();
    if (!words || phase === "speaking") return;
    setTyped("");
    const draft = state.drafts[conversationId];
    const route = resolveRoute(classifyTask({ text: words, hasQuote: false }), { conversation: conversation?.model, preference: state.settings.routePreference }, routeTable(state.settings.complexPlanTier));
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

  const lastAi = captions.map((caption) => caption.speaker).lastIndexOf("ai");
  return (
    <section className="voice-stage" aria-label="语音会话" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); end(); } }}>
      <header className="voice-top">
        <span className="voice-title"><AudioLines size={18} aria-hidden="true" />语音会话</span>
        <span className="voice-badge"><MicOff size={13} aria-hidden="true" />演示 · 未接通语音，不使用麦克风</span>
      </header>
      <div className="voice-lines" ref={lines} aria-live="polite">
        {captions.length === 0 ? (
          <div className="voice-hello">
            <TraceGlyph size={34} />
            <p className="voice-greeting">说说今天想练什么</p>
            <p className="voice-note">在下方用文字代替说话，回答会以字幕出现在这里{canSpeak ? "，也会用系统朗读播放（可静音）" : ""}。结束后，整段字幕回到{conversation?.temporary ? "这段临时对话" : "当前对话"}。</p>
          </div>
        ) : (
          <ol className="voice-captions">
            {captions.map((caption, index) => (
              <li key={index} className={`voice-line line-${caption.speaker}${index === lastAi ? " is-latest" : ""}`}>
                <span className="who">{caption.speaker === "user" ? "你" : "AI"}</span>
                <p>{caption.text}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="voice-bottom">
        <p className={`voice-state is-${phase}`} role="status">
          <span className="state-dot" aria-hidden="true" />
          {phase === "speaking" ? (muted ? "AI 在回答 · 已静音，只看字幕" : "AI 在回答") : "轮到你说"}
          <span className="voice-route">{AUDIO_ROUTE.label} · 文字任务{conversation?.model && conversation.model !== "auto" ? `用 ${MODEL_NAME[conversation.model]}` : "按任务自动选择模型"}</span>
        </p>
        <ul className="suggestions compact voice-samples" aria-label="示例说法">
          {SAMPLES.map((text) => <li key={text}><button type="button" disabled={phase === "speaking"} onClick={() => say(text)}>{text}</button></li>)}
        </ul>
        <div className="voice-bar">
          <form className="voice-input" onSubmit={(event) => { event.preventDefault(); say(typed); }}>
            <label className="visually-hidden" htmlFor="voice-typed">用文字代替说话</label>
            <input id="voice-typed" ref={input} value={typed} placeholder="用文字代替说话" autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
            <button type="submit" className="voice-send" aria-label="说出这句" disabled={!typed.trim() || phase === "speaking"}><ArrowUp size={17} aria-hidden="true" /></button>
          </form>
          <button type="button" className={`voice-round${muted ? " is-on" : ""}`} aria-pressed={muted} disabled={!canSpeak}
            aria-label={muted ? "取消静音" : "静音：不播放 AI 语音"} title={muted ? "取消静音" : "静音"}
            onClick={() => { setMuted((value) => !value); if (canSpeak) window.speechSynthesis.cancel(); }}>
            {muted ? <VolumeX size={19} aria-hidden="true" /> : <Volume2 size={19} aria-hidden="true" />}
          </button>
          <button type="button" className="voice-round voice-end" aria-label="结束语音会话" title="结束" onClick={end}><X size={20} aria-hidden="true" /></button>
        </div>
      </div>
    </section>
  );
}
