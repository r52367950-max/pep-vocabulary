import { useEffect, useRef, useState } from "react";
import { Check, Eye, EyeOff, Play, RotateCcw, Snail, X } from "lucide-react";
import { MISTAKE_TITLE, scopeItems, scoreAnswer, type CharPart, type Score } from "../practice";
import { PROGRAM_ROUTE } from "../routing";
import { newId, useStore } from "../store";

function speak(text: string, slow: boolean) {
  if (!("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = slow ? 0.6 : 0.9;
  window.speechSynthesis.speak(utterance);
  return true;
}

function Diff({ parts }: { parts: CharPart[] }) {
  return (
    <span className="letter-diff" aria-hidden="true">
      {parts.map((part, index) => (
        <span key={index} className={`ch ch-${part.kind}`}>{part.kind === "extra" ? part.actual : part.expected}</span>
      ))}
    </span>
  );
}

export function DictationView() {
  const { state, dispatch, returnResult, startPractice } = useStore();
  const session = state.practice;
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState<Score | null>(null);
  const [showHint, setShowHint] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const item = session && !session.finished ? session.items[session.index] : null;

  useEffect(() => {
    if (item) input.current?.focus({ preventScroll: true });
  }, [item]);
  useEffect(() => {
    if (checked) next.current?.focus({ preventScroll: true });
  }, [checked]);

  if (!session) {
    const items = scopeItems("unit4").slice(0, 8);
    return (
      <div className="page dictation-page">
        <header className="page-head"><p className="eyebrow">练习</p><h1>单词听写</h1></header>
        <div className="empty-panel">
          <p>现在没有进行中的听写。可以从对话里的计划卡开始，或直接练一组教材词。</p>
          <button type="button" className="button button-primary" onClick={() => startPractice(items, "8 词听写", "必修第一册 · Unit 4", "page")}>练必修第一册 Unit 4 的 8 个词</button>
        </div>
      </div>
    );
  }

  const roundNumber = session.rounds.length + (session.finished ? 0 : 1);
  const submit = () => {
    if (!item || checked) return;
    const score = scoreAnswer(item, answer);
    setChecked(score);
    dispatch({ type: "practice", session: { ...session, current: [...session.current, { item, answer: answer.trim(), score }] } });
  };
  const advance = () => {
    if (!checked) return;
    setChecked(null);
    setAnswer("");
    if (session.index + 1 < session.items.length) dispatch({ type: "practice", session: { ...session, index: session.index + 1 } });
    else dispatch({ type: "practice", session: { ...session, rounds: [...session.rounds, session.current], current: [], finished: true } });
  };
  const retryWrong = () => {
    const last = session.rounds.at(-1) ?? [];
    const wrong = last.filter((row) => !row.score.correct).map((row) => row.item);
    if (!wrong.length) return;
    dispatch({ type: "practice", session: { ...session, id: newId("practice"), items: wrong, index: 0, current: [], finished: false, returned: false } });
  };

  if (session.finished) {
    const last = session.rounds.at(-1) ?? [];
    const wrong = last.filter((row) => !row.score.correct);
    const conversation = state.conversations.find((item) => item.id === session.convId);
    return (
      <div className="page dictation-page">
        <header className="page-head">
          <p className="eyebrow">单词听写 · {session.source}</p>
          <h1>{roundNumber === 1 ? "第一轮" : `重练第 ${roundNumber - 1} 轮`}：{last.length - wrong.length} / {last.length} 正确</h1>
          {session.rounds.length > 1 && (
            <p className="page-sub">{session.rounds.map((round, index) => `${index === 0 ? "第一轮" : `重练第 ${index} 轮`} ${round.filter((row) => row.score.correct).length}/${round.length}`).join(" · ")}</p>
          )}
          <p className="page-sub">{PROGRAM_ROUTE.detail}。</p>
        </header>
        <ol className="review-list">
          {last.map((row) => (
            <li key={row.item.id} className={row.score.correct ? "is-correct" : "is-wrong"}>
              <span className="mark" aria-hidden="true">{row.score.correct ? <Check size={15} /> : <X size={15} />}</span>
              <div>
                <p className="review-word"><strong>{row.item.text}</strong><span className="hint">{row.item.hint}</span></p>
                {!row.score.correct && (
                  <p className="review-answer">
                    你写的：<span className="wrong">{row.answer || "（空）"}</span>
                    <span className="kind">{row.score.kind ? MISTAKE_TITLE[row.score.kind] : ""}</span>
                  </p>
                )}
                <p className="review-explain">{row.score.explanation}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="result-actions">
          {wrong.length > 0 && <button type="button" className="button button-primary" onClick={retryWrong}><RotateCcw size={16} aria-hidden="true" />只重练 {wrong.length} 个错项</button>}
          {session.convId !== null || conversation ? (
            <button type="button" className={`button ${wrong.length ? "button-secondary" : "button-primary"}`} disabled={session.returned} onClick={returnResult}>
              {session.returned ? "结果已带回对话" : conversation ? `把结果带回「${conversation.temporary ? "临时对话" : conversation.title.length > 12 ? `${conversation.title.slice(0, 12)}…` : conversation.title}」` : "把结果放进新对话"}
            </button>
          ) : null}
        </div>
        <p className="page-note">带回对话的是全部轮次的作答：第一轮与每次重练分别记录，反馈依据这些真实对错。</p>
      </div>
    );
  }

  return (
    <div className="page dictation-page">
      <header className="page-head">
        <p className="eyebrow">单词听写 · {session.source}{roundNumber > 1 ? ` · 重练第 ${roundNumber - 1} 轮` : ""}</p>
        <h1>{session.title}</h1>
        <div className="progress" role="progressbar" aria-label="听写进度" aria-valuemin={0} aria-valuemax={session.items.length} aria-valuenow={session.index + (checked ? 1 : 0)}>
          <span style={{ width: `${((session.index + (checked ? 1 : 0)) / session.items.length) * 100}%` }} />
        </div>
        <p className="page-sub">{session.index + 1} / {session.items.length}</p>
      </header>
      {item && (
        <div className="dictation-card">
          <div className="listen-row">
            <button type="button" className="play-button" disabled={!canSpeak} aria-label="播放读音" onClick={() => speak(item.text, false)}><Play size={22} aria-hidden="true" /></button>
            <button type="button" className="button button-quiet" disabled={!canSpeak} onClick={() => speak(item.text, true)}><Snail size={16} aria-hidden="true" />慢速</button>
            <button type="button" className="button button-quiet" aria-pressed={showHint} onClick={() => setShowHint((value) => !value)}>
              {showHint ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{showHint ? "隐藏释义" : "显示释义"}
            </button>
          </div>
          {!canSpeak && <p className="page-note">这个浏览器不支持系统朗读，请看释义作答。</p>}
          {showHint && <p className="hint-line">{item.hint}</p>}
          <form className="answer-form" onSubmit={(event) => { event.preventDefault(); if (checked) advance(); else submit(); }}>
            <label className="visually-hidden" htmlFor="dictation-answer">写出听到的单词</label>
            <input id="dictation-answer" ref={input} className="text-field large" value={answer} readOnly={Boolean(checked)}
              autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="写出听到的单词"
              onChange={(event) => setAnswer(event.target.value)} />
            {!checked && <button type="submit" className="button button-primary">核对</button>}
          </form>
          {checked && (
            <div className={`feedback ${checked.correct ? "is-correct" : "is-wrong"}`} role="status">
              <p className="feedback-title">{checked.correct ? <><Check size={16} aria-hidden="true" />正确</> : <><X size={16} aria-hidden="true" />{checked.kind ? MISTAKE_TITLE[checked.kind] : "不对"}</>}</p>
              {!checked.correct && <p className="feedback-word">正确拼写：<strong>{item.text}</strong> <Diff parts={checked.parts} /></p>}
              <p>{checked.explanation}</p>
              <button ref={next} type="button" className="button button-primary" onClick={advance}>{session.index + 1 < session.items.length ? "下一个" : "查看结果"}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
