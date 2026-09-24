"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Headphones,
  Lightbulb,
  RotateCcw,
  Volume2,
  X,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { loadDetails, speakSystem, type LexiconDetail } from "@/lib/lexicon";
import {
  buildQuestion,
  getEntryExample,
  gradeQuestion,
  localSentenceCheck,
  type QuestionType,
} from "@/lib/questions";
import { previewReviewIntervals, scheduleReview } from "@/lib/scheduler";
import { createLocalId, type ReviewEvent } from "@/lib/storage";
import { effectiveRating } from "@/lib/study";
import {
  advanceSession,
  sessionEventId,
  type StudySessionState,
} from "@/lib/session";
import { sourceLabel } from "./shared";
import { Artwork } from "./art";

const labels = { 1: "忘记了", 2: "有些费力", 3: "记得", 4: "很熟悉" };
export default function StudySession({
  data,
  session,
  onChange,
  onExit,
  onRetry,
}: {
  data: Vocabulary;
  session: StudySessionState;
  onChange: (session: StudySessionState) => void;
  onExit: () => void;
  onRetry: (ids: string[]) => void;
}) {
  const [details, setDetails] = useState(new Map<string, LexiconDetail>());
  const [detailError, setDetailError] = useState(false);
  const [readyStep, setReadyStep] = useState("");
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [hints, setHints] = useState(0);
  const [saving, setSaving] = useState(false);
  const [undo, setUndo] = useState<{
    event: ReviewEvent;
    previous: StudySessionState;
  } | null>(null);
  const [audioFailed, setAudioFailed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const busy = useRef(false);
  const start = useRef(0);
  const answerTime = useRef(0);
  const submission = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const index = data.byId;
  const { cards, notify, saveReview, reload } = data;
  const retention = data.settings.desiredRetention;
  const entry = index.get(session.queue[session.position]);
  const card = entry ? cards.get(entry.id) : undefined;
  const detail = entry ? details.get(entry.id) : undefined;
  const done = session.position >= session.queue.length;
  const type: QuestionType =
    session.mode === "dictation"
      ? "dictation"
      : session.mode === "context"
        ? "context-choice"
        : session.mode === "mistakes" ||
            Boolean(
              entry &&
                session.results.some((result) => result.wordId === entry.id),
            )
          ? "spelling"
          : !card?.lastReviewed
            ? "meaning-recall"
            : (
                [
                  "meaning-recall",
                  "spelling",
                  "context-choice",
                ] as QuestionType[]
              )[Number(card.fsrs.reps || 0) % 3];
  const question = useMemo(
    () => (entry ? buildQuestion(entry, detail, type, data.index) : null),
    [entry, detail, type, data.index],
  );
  const intervals = useMemo(
    () => previewReviewIntervals(card, retention),
    [card, retention],
  );
  const stepId = sessionEventId(session);
  // Details for the next five words are prefetched, so a cached card is ready at once
  // and the question stays on screen between cards instead of flashing the loader.
  const ready = readyStep === stepId || detailError || (entry ? details.has(entry.id) : false);
  const reset = useCallback(() => {
    setAnswer("");
    setRevealed(false);
    setCorrect(null);
    setHints(0);
    start.current = Date.now();
    answerTime.current = 0;
    setAudioFailed(false);
    setSpeaking(false);
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    let active = true;
    loadDetails(session.queue.slice(session.position, session.position + 5))
      .then((rows) => {
        if (active) {
          setDetails(
            (previous) =>
              new Map([
                ...previous,
                ...rows.map((row) => [row.id, row] as const),
              ]),
          );
          setDetailError(false);
          setReadyStep(stepId);
          start.current = Date.now();
        }
      })
      .catch(() => {
        if (active) {
          setDetailError(true);
          setReadyStep(stepId);
          start.current = Date.now();
        }
      });
    return () => {
      active = false;
    };
  }, [session.queue, session.position, stepId]);
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (entry && !revealed) input.current?.focus();
    // The answer field unmounts on reveal; hand focus to the next action instead of the page body.
    if (revealed) controls.current?.querySelector<HTMLButtonElement>(".recommended, .wrong-next .primary")?.focus({ preventScroll: true });
  }, [entry, revealed]);
  useEffect(
    () => () => {
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    [],
  );

  const play = useCallback(() => {
    if (!entry) return;
    if (!("speechSynthesis" in window)) {
      setAudioFailed(true);
      return;
    }
    // A user gesture is required by Safari. No autoplay or remote audio dependency.
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(entry.headword);
    const voice =
      speechSynthesis
        .getVoices()
        .find((v) => v.lang.toLowerCase() === "en-gb") ||
      speechSynthesis.getVoices().find((v) => /^en[-_]/i.test(v.lang));
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "en-GB";
    utterance.rate = 0.84;
    setAudioFailed(false);
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = (e) => {
      setSpeaking(false);
      if (e.error !== "canceled" && e.error !== "interrupted")
        setAudioFailed(true);
    };
    speechSynthesis.speak(utterance);
  }, [entry]);

  const check = useCallback(
    (forgot = false) => {
      if (!question || revealed || busy.current || !ready) return;
      if (!forgot && question.inputMode !== "reveal" && !answer.trim()) {
        notify("先输入答案，或选择暂时想不起来。");
        return;
      }
      answerTime.current = Math.min(
        300_000,
        Math.max(0, Date.now() - start.current),
      );
      setCorrect(forgot ? false : gradeQuestion(question, answer));
      setRevealed(true);
    },
    [question, revealed, answer, notify, ready],
  );

  const rate = useCallback(
    async (requested: 1 | 2 | 3 | 4) => {
      if (
        !entry ||
        !question ||
        !revealed ||
        busy.current ||
        done ||
        submission.current === stepId
      )
        return;
      busy.current = true;
      setSaving(true);
      const rating = effectiveRating({ rating: requested, correct, hints });
      const result = correct ?? rating > 1;
      const scheduled = scheduleReview({
        stored: cards.get(entry.id) || null,
        cardId: entry.id,
        rating,
        retention,
        skill: question.skill,
        questionType: question.type,
        correct: result,
        responseMs: answerTime.current,
        hints,
        errorType: result
          ? null
          : question.audio
            ? "listening"
            : question.skill === "spelling"
              ? "spelling"
              : "recall",
        prompt: question.prompt,
        answerGiven: answer.trim() || null,
        expectedAnswer: question.answer,
        sourceLine: sourceLabel(entry),
      });
      const event = {
        ...scheduled.event,
        eventType: "review" as const,
        eventId: stepId,
      };
      try {
        await saveReview(event);
        submission.current = stepId;
        setUndo({ event, previous: session });
        onChange(advanceSession(session, event));
        reset();
      } catch {
        notify(
          "本次评分尚未保存。可能有另一页面更新了此词，请重试。学习位置已保留。",
        );
        await reload().catch(() => undefined);
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [
      entry,
      question,
      revealed,
      done,
      stepId,
      correct,
      hints,
      cards,
      retention,
      saveReview,
      notify,
      reload,
      answer,
      session,
      onChange,
      reset,
    ],
  );

  const undoLast = useCallback(async () => {
    if (!undo || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const now = new Date();
      await saveReview({
        ...undo.event,
        eventId: createLocalId(),
        eventType: "undo",
        targetEventId: undo.event.eventId,
        timestampUtc: now.toISOString(),
        localDate: now.toLocaleDateString("sv-SE"),
      });
      onChange({ ...undo.previous, revision: (session.revision || 0) + 1 });
      submission.current = null;
      setUndo(null);
      reset();
    } catch {
      notify("撤销未完成，词条可能已在其他页面更新。请重新加载后检查。");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [undo, session.revision, saveReview, notify, onChange, reset]);

  // Reads the latest answer state when a key arrives, so the listener is bound once per session
  // instead of after every keypress.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      busy.current
    )
      return;
    const target = event.target as HTMLElement;
    if (
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
      target.isContentEditable
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      if (revealed) void rate(correct === false ? 1 : 3);
      else check();
    }
    if (revealed && /^[1-4]$/.test(event.key))
      void rate(Number(event.key) as 1 | 2 | 3 | 4);
    if (event.key.toLowerCase() === "r") play();
    if (event.key.toLowerCase() === "z") void undoLast();
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  if (done) {
    const first = session.results.filter((result) => !result.retry);
    const mistakes = [
      ...new Set(
        first
          .filter((result) => !result.correct)
          .map((result) => result.wordId),
      ),
    ];
    return (
      <main className="study-complete">
        <Artwork kind="botanical" seed={session.id} className="complete-art" eager />
        <h1>练习完成</h1>
        <p>学习记录已保存</p>
        <div className="complete-stats">
          <span>
            <strong>{first.length}</strong>学习词数
          </span>
          <span>
            <strong>
              {Math.round(
                (first.filter((r) => r.correct).length /
                  Math.max(1, first.length)) *
                  100,
              )}
              <small>%</small>
            </strong>
            首次作答正确
          </span>
          <span>
            <strong>{session.results.length - first.length}</strong>巩固次数
          </span>
        </div>
        {mistakes.length > 0 && (
          <div className="completion-mistakes">
            <h2>这一轮需要留意</h2>
            {mistakes.map((id) => {
              const result = first.find((r) => r.wordId === id)!;
              return (
                <div key={id}>
                  <strong>{index.get(id)?.headword}</strong>
                  <span>
                    {result.answer ? `写成 ${result.answer}` : "未能独立回忆"}
                  </span>
                  <small>{result.expected}</small>
                </div>
              );
            })}
          </div>
        )}
        <p className="muted">作答已保存在本机，下次复习会按记忆情况安排。</p>
        <div className="button-row">
          <button className="primary" onClick={onExit}>
            返回今日
          </button>
          {mistakes.length > 0 && (
            <button className="secondary" onClick={() => onRetry(mistakes)}>
              再练这些词
            </button>
          )}
          {undo && (
            <button
              className="text-button"
              disabled={saving}
              onClick={undoLast}
            >
              <RotateCcw size={16} aria-hidden="true" />
              撤销最后评分
            </button>
          )}
        </div>
      </main>
    );
  }
  if (!entry || !question)
    return (
      <main className="boot-screen">
        <h1>这一轮的词条已更新</h1>
        <button className="primary" onClick={onExit}>
          返回重新选择
        </button>
      </main>
    );
  if (!ready)
    return (
      <main className="boot-screen">
        <p role="status">正在准备词条…</p>
        <button className="text-button" onClick={onExit}>
          稍后继续
        </button>
      </main>
    );
  const example = getEntryExample(entry, detail);
  const hint =
    question.hint ||
    (question.audio || question.inputMode === "text"
      ? `首字母 ${entry.headword[0]} · 共 ${entry.headword.replace(/\s/g, "").length} 个字母`
      : `词性：${entry.partsOfSpeech.join(" / ") || "请先尝试回忆"}`);
  const retrying = session.results.some((result) => result.wordId === entry.id);
  const sentenceCheck =
    question.inputMode === "textarea" && answer
      ? localSentenceCheck(answer, entry.headword)
      : null;
  return (
    <main className="study-screen">
      <header className="study-header">
        <button
          className="icon-button"
          disabled={saving}
          onClick={onExit}
          aria-label="保存进度并退出"
        >
          <X size={22} aria-hidden="true" />
        </button>
        <span>{session.title}</span>
        <div className="study-track" role="progressbar" aria-label="本轮进度" aria-valuemin={0} aria-valuemax={session.queue.length} aria-valuenow={session.position}>
          <span
            style={{
              transform: `scaleX(${session.position / session.queue.length})`,
            }}
          />
        </div>
        <strong>
          {session.position + 1}
          <small> / {session.queue.length}</small>
        </strong>
        {undo && (
          <button
            className="icon-button"
            disabled={saving}
            onClick={undoLast}
            aria-label="撤销上一次评分"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>
        )}
      </header>
      <div className="study-stage">
        <div className="study-meta">
          <span className="pill">
            {retrying ? "本轮巩固" : card?.lastReviewed ? "复习" : "新词"} ·{" "}
            {question.label}
          </span>
          <span>{sourceLabel(entry)}</span>
        </div>
        <section
          key={stepId}
          className={`study-question ${revealed ? "is-revealed" : ""}`}
          aria-label="学习卡片"
        >
          <p className="sr-only" aria-live="polite">
            {revealed && correct !== null ? (correct ? "答对了" : `这次没记住，正确答案是 ${entry.headword}`) : ""}
          </p>
          <span className="question-instruction">
            {question.audio
              ? "听一听，再写下来"
              : question.inputMode === "reveal"
                ? "先试着回忆它的意思"
                : question.inputMode === "choice"
                  ? "读懂语境，选出合适的词"
                  : "不用看答案，试着写下来"}
          </span>
          {question.audio ? (
            <>
              <button
                className={`audio-orb${speaking ? " is-speaking" : ""}`}
                onClick={play}
                aria-label="播放听写发音"
                aria-pressed={speaking}
              >
                <Volume2 size={37} aria-hidden="true" />
              </button>
              <p className="audio-note" role="status">
                {speaking ? "正在播放…" : "轻点播放 · 系统英语语音"}
              </p>
              {audioFailed && (
                <p role="alert" className="inline-error">
                  语音暂不可用。可以退出后选择文字练习；离线发音需要设备已安装英语语音。
                </p>
              )}
            </>
          ) : (
            <h1
              className={
                question.inputMode === "reveal"
                  ? "english recall-word"
                  : "question-text"
              }
              translate={question.inputMode === "reveal" ? "no" : undefined}
            >
              {question.prompt}
            </h1>
          )}
          {!question.audio && question.inputMode === "reveal" && (
            <div className="study-pronunciation">
              <span className="ipa">
                {entry.britishIpa ? `/${entry.britishIpa}/` : ""}
              </span>
              <button
                className="icon-button"
                onClick={() => speakSystem(entry.headword)}
                aria-label="播放单词发音"
              >
                <Volume2 size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {question.support &&
            !question.audio &&
            question.inputMode !== "reveal" && (
              <p className="question-support">{question.support}</p>
            )}
          {question.fallbackReason && (
            <p className="question-support">{question.fallbackReason}</p>
          )}
          {question.exampleSource && !question.audio && (
            <p className="question-support">{question.exampleSource}</p>
          )}
          {!revealed && (
            <>
              {question.inputMode === "text" && (
                <input
                  ref={input}
                  className="spelling-input"
                  aria-label="输入答案"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      check();
                    }
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="输入完整拼写…"
                  name="answer"
                  enterKeyHint="done"
                />
              )}
              {question.inputMode === "textarea" && (
                <textarea
                  className="sentence-input"
                  aria-label="输入英文句子"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  maxLength={2000}
                  placeholder="写下你的句子…"
                />
              )}
              {question.inputMode === "choice" && (
                <div className="study-choices">
                  {question.choices.map((choice, i) => (
                    <button
                      key={choice}
                      aria-pressed={answer === choice}
                      onClick={() => setAnswer(choice)}
                    >
                      <span>{String.fromCharCode(65 + i)}</span>
                      {choice}
                    </button>
                  ))}
                </div>
              )}
              {hints > 0 && (
                <p className="hint-text" role="status">
                  <Lightbulb size={16} aria-hidden="true" />
                  {hint}
                </p>
              )}
              {sentenceCheck && (
                <p className="question-support">{sentenceCheck.message}</p>
              )}
            </>
          )}
          {revealed && (
            <div className="answer-feedback">
              {correct !== null && (
                <p className={correct ? "feedback-good" : "feedback-again"}>
                  {correct ? <Check size={18} aria-hidden="true" /> : <RotateCcw size={18} aria-hidden="true" />}{" "}
                  {correct
                    ? hints
                      ? "借助提示答对了，再巩固一次"
                      : "答对了"
                    : "这次没记住，稍后再练一次"}
                </p>
              )}
              {answer && correct === false && (
                <p className="your-answer">
                  你的答案：<s>{answer}</s>
                </p>
              )}
              <h2
                className={
                  question.inputMode === "reveal"
                    ? "answer-zh"
                    : "english answer-en"
                }
                translate={question.inputMode === "reveal" ? undefined : "no"}
              >
                {question.answer}
              </h2>
              {question.inputMode !== "reveal" && <p>{entry.chineseCore}</p>}
              {example && (
                <div className="example-block">
                  <span>{example.source}</span>
                  <p className="english">{example.en}</p>
                  {example.zh && <small>{example.zh}</small>}
                </div>
              )}
              {detailError && (
                <small>例句详情未能加载，基础练习仍可完成。</small>
              )}
            </div>
          )}
        </section>
        <div className="study-controls" ref={controls}>
          {!revealed ? (
            <>
              <div className="study-main-actions">
                <button className="secondary" onClick={() => check(true)}>
                  暂时想不起来
                </button>
                <button className="primary" onClick={() => check()}>
                  {question.inputMode === "reveal" ? "显示词义" : "核对答案"}
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </div>
              <button
                className="text-button hint-button"
                disabled={hints > 0}
                onClick={() => setHints(1)}
              >
                <Lightbulb size={15} aria-hidden="true" />
                {hints ? "已使用提示" : "给我一点提示"}
              </button>
            </>
          ) : correct === false ? (
            <div className="wrong-next">
              <p>继续后会保存这次作答，并安排本轮巩固。</p>
              <button
                className="primary"
                disabled={saving}
                onClick={() => rate(1)}
              >
                {saving ? "正在保存…" : "继续学习"}
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <p className="rating-instruction">{hints ? "用了提示，这次最高记为「有些费力」" : "这次回忆有多费力？"}</p>
              <div className="rating-buttons">
                {intervals.map((item) => (
                  <button
                    key={item.rating}
                    className={
                      item.rating === (hints ? 2 : 3) ? "recommended" : ""
                    }
                    disabled={saving || (hints > 0 && item.rating > 2)}
                    onClick={() => rate(item.rating)}
                  >
                    <strong>{labels[item.rating]}</strong>
                    <small>{item.label}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <footer className="study-footer">
          <span>
            <Headphones size={14} aria-hidden="true" />R 播放
          </span>
          <span>空格核对 · 1–4 评分</span>
          <button className="text-button" onClick={onExit} disabled={saving}>
            <ArrowLeft size={14} aria-hidden="true" />
            稍后继续
          </button>
        </footer>
      </div>
    </main>
  );
}
