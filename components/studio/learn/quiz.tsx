"use client";

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Check, ChevronRight, Volume2, X } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { gradeQuestion, type Question } from "@/lib/questions";
import {
  QUIZ_MAX,
  buildQuizPlan,
  buildQuizQuestion,
  learnPool,
  quizDistractorPool,
  quizLength,
  scoreQuiz,
  shortMeaning,
  type QuizAnswer,
  type QuizItem,
  type QuizLength,
} from "@/lib/learn";
import {
  CompletionArt,
  HearList,
  LearnHeader,
  LearnIntro,
  LiveRegion,
  speak,
  useScreenFocus,
  type LearnModeProps,
} from "./parts";

type Quiz = {
  seed: number;
  items: QuizItem[];
  questions: Question[];
  answers: QuizAnswer[];
};
const LENGTHS: readonly QuizLength[] = [10, 20, "all"];

/** Choice labels read better without POS tags and notes, unless shortening makes two alike. */
function choiceLabels(question: Question) {
  if (question.type === "context-choice") return question.choices;
  const short = question.choices.map((choice) => shortMeaning(choice, 22));
  return new Set(short).size === short.length ? short : question.choices;
}

export default function QuizMode({
  data,
  bookId,
  unit,
  onCourse,
  onExit,
  onPractice,
}: LearnModeProps) {
  const [length, setLength] = useState<QuizLength>(10);
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const byId = useMemo(
    () => new Map(data.index.map((entry) => [entry.id, entry])),
    [data.index],
  );
  const distractors = useMemo(() => quizDistractorPool(data.index), [data.index]);
  const available = useMemo(
    () => learnPool(data.index, data.cards, { bookId, unit }).length,
    [data.index, data.cards, bookId, unit],
  );
  // A fixed length the range cannot fill is the same test as "all".
  const effective: QuizLength =
    length !== "all" && length >= available ? "all" : length;
  const count = quizLength(effective, available);

  const start = (size: QuizLength = effective) => {
    const seed = Date.now();
    const audio = typeof window !== "undefined" && "speechSynthesis" in window;
    const items = buildQuizPlan(data.index, data.cards, {
      bookId,
      unit,
      length: size,
      seed,
      audio,
    }).filter((item) => byId.has(item.id));
    if (!items.length) {
      data.notify("这个范围没有可以自测的词，换一个单元试试。");
      return;
    }
    const questions = items.map((item) =>
      buildQuizQuestion(byId.get(item.id)!, item.kind, distractors),
    );
    setQuiz({ seed, items, questions, answers: [] });
    // Started by a click, so Safari lets the first listening question speak.
    if (questions[0].audio) speak(byId.get(items[0].id)!.headword, data.notify);
  };

  if (!quiz)
    return (
      <LearnIntro
        symbol="quiz"
        title="单元自测"
        lead="不给提示，一题一屏，答完马上看对错。测完能看到哪些词还没掌握。"
        data={data}
        bookId={bookId}
        unit={unit}
        onCourse={onCourse}
        onExit={onExit}
        meta={
          available
            ? `这个范围有 ${available} 个词可以出题。`
            : "这个范围没有可以自测的词，换一个单元试试。"
        }
        note="自测不改变复习计划。答错的词可以随后进入练习。"
        action={
          <button
            type="button"
            className="primary learn-start"
            disabled={!count}
            onClick={() => start()}
          >
            开始自测{count ? `（${count} 题）` : ""}
          </button>
        }
      >
        <fieldset className="learn-lengths">
          <legend>题量</legend>
          {LENGTHS.map((option) => {
            const size = quizLength(option, available);
            const label =
              option === "all" ? `全部 ${size} 题` : `${option} 题`;
            const redundant = option !== "all" && option >= available;
            return (
              <label key={String(option)} className="learn-length">
                <input
                  type="radio"
                  name="quiz-length"
                  value={String(option)}
                  checked={effective === option}
                  disabled={!available || redundant}
                  onChange={() => setLength(option)}
                />
                <span>{label}</span>
              </label>
            );
          })}
          {available > QUIZ_MAX ? (
            <small className="learn-lengths-note">“全部”最多 {QUIZ_MAX} 题，随机抽取。</small>
          ) : null}
        </fieldset>
      </LearnIntro>
    );

  if (quiz.answers.length >= quiz.questions.length)
    return (
      <QuizResult
        data={data}
        quiz={quiz}
        byId={byId}
        onAgain={() => start()}
        onExit={onExit}
        onPractice={onPractice}
      />
    );

  return (
    <QuizPlay
      key={quiz.seed}
      data={data}
      quiz={quiz}
      byId={byId}
      onAnswer={(answer) =>
        setQuiz((current) =>
          current && current.seed === quiz.seed
            ? { ...current, answers: [...current.answers, answer] }
            : current,
        )
      }
      onExit={onExit}
    />
  );
}

function QuizPlay({
  data,
  quiz,
  byId,
  onAnswer,
  onExit,
}: {
  data: LearnModeProps["data"];
  quiz: Quiz;
  byId: ReadonlyMap<string, LexiconIndexEntry>;
  onAnswer: (answer: QuizAnswer) => void;
  onExit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [response, setResponse] = useState("");
  const [result, setResult] = useState<{ correct: boolean; given: string } | null>(
    null,
  );
  const [nudge, setNudge] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const item = quiz.items[index];
  const question = quiz.questions[index];
  const entry = item ? byId.get(item.id) : undefined;
  const labels = useMemo(() => (question ? choiceLabels(question) : []), [question]);
  const last = index + 1 >= quiz.questions.length;

  // Each new question: focus the answer field, or the prompt so it is read out.
  useEffect(() => {
    window.scrollTo(0, 0);
    if (question?.inputMode === "text") input.current?.focus();
    else heading.current?.focus({ preventScroll: true });
  }, [index, question]);
  useEffect(() => {
    if (result) nextButton.current?.focus({ preventScroll: true });
  }, [result]);

  const answer = (given: string, gaveUp = false) => {
    if (!question || !item || result) return;
    if (!gaveUp && question.inputMode === "text" && !given.trim()) {
      setNudge(true);
      input.current?.focus();
      return;
    }
    const correct = !gaveUp && gradeQuestion(question, given) === true;
    setResponse(given);
    setResult({ correct, given: gaveUp ? "" : given });
    setNudge(false);
  };

  const next = () => {
    if (!result || !item || !question) return;
    onAnswer({
      id: item.id,
      kind: item.kind,
      correct: result.correct,
      given: result.given,
      expected: question.answer,
    });
    if (last) return;
    const upcoming = quiz.questions[index + 1];
    const upcomingEntry = byId.get(quiz.items[index + 1].id);
    setIndex(index + 1);
    setResponse("");
    setResult(null);
    setNudge(false);
    // Speak inside the click/keypress, which Safari requires for audio.
    if (upcoming?.audio && upcomingEntry) speak(upcomingEntry.headword, data.notify);
  };

  const play = () => {
    if (entry) speak(entry.headword, data.notify);
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey)
      return;
    const target = event.target as HTMLElement | null;
    const typing = Boolean(
      target?.closest?.("input, textarea, select, [contenteditable]"),
    );
    if (event.key === "Enter" && result && !event.repeat) {
      // A focused button handles Enter itself.
      if (target?.tagName === "BUTTON" || typing) return;
      event.preventDefault();
      next();
      return;
    }
    if (typing || result || !question || event.repeat) return;
    if (question.inputMode === "choice") {
      const letter = event.key.toLowerCase();
      const at = /^[1-9]$/.test(letter)
        ? Number(letter) - 1
        : "abcdefgh".indexOf(letter);
      if (at >= 0 && at < question.choices.length) {
        event.preventDefault();
        answer(question.choices[at]);
        return;
      }
    }
    if (question.audio && event.key.toLowerCase() === "r") play();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  if (!question || !item || !entry)
    return (
      <main className="learn-stage learn-intro">
        <h1>题目已更新</h1>
        <button type="button" className="primary" onClick={onExit}>
          返回今日
        </button>
      </main>
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    answer(response);
  };
  const correctLabel =
    question.inputMode === "choice"
      ? labels[question.choices.indexOf(question.answer)] ?? question.answer
      : question.answer;
  const answerIsEnglish =
    question.type !== "listening-choice" || question.inputMode !== "choice";
  const status = result
    ? result.correct
      ? "答对了。"
      : `答错了。正确答案是 ${correctLabel}。`
    : "";

  return (
    <>
      <LearnHeader
        title="单元自测"
        done={index + (result ? 1 : 0)}
        total={quiz.questions.length}
        count={
          <>
            {index + 1}
            <small> / {quiz.questions.length}</small>
          </>
        }
        onExit={onExit}
      />
      <main className="learn-stage learn-quiz">
        <LiveRegion message={status} />
        <p className="learn-q-kind">{question.label}</p>
        <div className="learn-q-prompt">
          {question.audio ? (
            <>
              <h1 ref={heading} tabIndex={-1} className="learn-q-listen">
                {question.inputMode === "choice"
                  ? "听发音，选出它的中文意思"
                  : "听发音，写出这个词"}
              </h1>
              <button
                type="button"
                className="learn-audio"
                onClick={play}
                aria-label="播放发音"
                title="播放发音（R）"
              >
                <Volume2 size={34} aria-hidden="true" />
              </button>
            </>
          ) : question.type === "context-choice" ? (
            <h1 ref={heading} tabIndex={-1} className="learn-q-sentence" lang="en">
              {question.prompt.split("____").map((part, at, parts) => (
                <span key={at}>
                  {part}
                  {at < parts.length - 1 ? (
                    <span className="learn-blank">
                      <span className="learn-sr">空格</span>
                    </span>
                  ) : null}
                </span>
              ))}
            </h1>
          ) : question.inputMode === "choice" ? (
            <h1
              ref={heading}
              tabIndex={-1}
              className="learn-q-word"
              lang="en"
              translate="no"
            >
              {question.prompt}
            </h1>
          ) : (
            <h1 ref={heading} tabIndex={-1} className="learn-q-meaning">
              {question.prompt}
            </h1>
          )}
          {question.support && !question.audio ? (
            <p className="learn-q-support">{question.support}</p>
          ) : null}
        </div>

        {question.inputMode === "choice" ? (
          <div className="learn-choices" role="group" aria-label="选项">
            {question.choices.map((choice, at) => {
              const chosen = result && response === choice;
              const isAnswer = choice === question.answer;
              const state = result
                ? isAnswer
                  ? " is-correct"
                  : chosen
                    ? " is-wrong"
                    : " is-dim"
                : "";
              return (
                <button
                  key={choice}
                  type="button"
                  className={`learn-choice${state}`}
                  disabled={Boolean(result)}
                  onClick={() => answer(choice)}
                  lang={question.type === "context-choice" ? "en" : undefined}
                >
                  <span className="learn-choice-key" aria-hidden="true">
                    {String.fromCharCode(65 + at)}
                  </span>
                  <span className="learn-choice-text">{labels[at]}</span>
                  {result && (isAnswer || chosen) ? (
                    isAnswer ? (
                      <Check size={18} aria-hidden="true" />
                    ) : (
                      <X size={18} aria-hidden="true" />
                    )
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <form className="learn-answer" onSubmit={submit}>
            <input
              ref={input}
              className={`learn-input${result ? (result.correct ? " is-correct" : " is-wrong") : ""}`}
              name="answer"
              aria-label="输入英文拼写"
              aria-invalid={result ? !result.correct : undefined}
              value={response}
              readOnly={Boolean(result)}
              onChange={(event) => {
                setResponse(event.target.value);
                if (nudge) setNudge(false);
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              placeholder="输入完整拼写…"
              lang="en"
            />
            {nudge ? (
              <p className="learn-nudge" role="alert">
                先输入答案，或选择“不会”。
              </p>
            ) : null}
          </form>
        )}

        {result ? (
          <div className={`learn-feedback ${result.correct ? "is-right" : "is-wrong"}`}>
            <p className="learn-feedback-title">
              {result.correct ? (
                <Check size={18} aria-hidden="true" />
              ) : (
                <X size={18} aria-hidden="true" />
              )}
              {result.correct ? "答对了" : result.given ? "答错了" : "没关系，记下它"}
            </p>
            {!result.correct ? (
              <p className="learn-feedback-answer">
                正确答案
                <strong lang={answerIsEnglish ? "en" : undefined}>
                  {correctLabel}
                </strong>
              </p>
            ) : null}
            {!result.correct && result.given && question.inputMode === "text" ? (
              <p className="learn-feedback-given">
                你的答案 <s lang="en">{result.given}</s>
              </p>
            ) : null}
            <p className="learn-feedback-word">
              <span lang="en" translate="no">
                {entry.headword}
              </span>
              {shortMeaning(entry.chineseCore, 24)}
            </p>
          </div>
        ) : null}

        <div className="learn-quiz-actions">
          {result ? (
            <button
              ref={nextButton}
              type="button"
              className="primary"
              onClick={next}
            >
              {last ? "查看结果" : "下一题"}
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => answer("", true)}
              >
                不会
              </button>
              {question.inputMode === "text" ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => answer(response)}
                >
                  核对
                </button>
              ) : null}
            </>
          )}
        </div>
        <p className="learn-keys" aria-hidden="true">
          {question.inputMode === "choice" ? (
            <span>
              <kbd>A</kbd>–<kbd>{String.fromCharCode(64 + question.choices.length)}</kbd> 选择
            </span>
          ) : null}
          {question.audio ? (
            <span>
              <kbd>R</kbd> 重播
            </span>
          ) : null}
          <span>
            <kbd>Enter</kbd> {result ? "下一题" : "提交"}
          </span>
        </p>
      </main>
    </>
  );
}

function QuizResult({
  data,
  quiz,
  byId,
  onAgain,
  onExit,
  onPractice,
}: {
  data: LearnModeProps["data"];
  quiz: Quiz;
  byId: ReadonlyMap<string, LexiconIndexEntry>;
  onAgain: () => void;
  onExit: () => void;
  onPractice: LearnModeProps["onPractice"];
}) {
  const heading = useScreenFocus<HTMLHeadingElement>("result");
  const score = scoreQuiz(quiz.answers);
  const wrong = score.wrongIds
    .map((id) => byId.get(id))
    .filter((entry): entry is LexiconIndexEntry => Boolean(entry));
  const verdict =
    score.percent >= 90
      ? "这一单元掌握得很扎实。"
      : score.percent >= 70
        ? "大部分都掌握了，把答错的再练一遍。"
        : "先把答错的词练熟，再来测一次。";
  return (
    <>
      <LearnHeader
        title="单元自测"
        done={score.total}
        total={score.total}
        onExit={onExit}
      />
      <main className="learn-stage learn-done">
        <CompletionArt
          kind="ink"
          seed={`quiz-${quiz.seed}`}
          theme={data.settings.theme}
        />
        <h1 ref={heading} tabIndex={-1}>
          自测完成
        </h1>
        <p className="learn-score" aria-label={`答对 ${score.correct} 题，共 ${score.total} 题`}>
          <strong className="learn-tabular">{score.correct}</strong>
          <span className="learn-tabular">/ {score.total}</span>
        </p>
        <ol className="learn-score-strip" aria-hidden="true">
          {quiz.answers.map((answer, at) => (
            <li key={at} className={answer.correct ? "is-right" : "is-wrong"} />
          ))}
        </ol>
        <p className="learn-done-lead">
          正确率 {score.percent}%。{verdict}
        </p>
        <HearList
          title="逐题回顾"
          notify={data.notify}
          items={quiz.answers.map((answer) => {
            const entry = byId.get(answer.id);
            return {
              id: answer.id,
              headword: entry?.headword ?? answer.expected,
              meaning: entry ? shortMeaning(entry.chineseCore, 18) : "",
              mark: answer.correct ? "right" : "wrong",
              note: answer.correct
                ? undefined
                : answer.given
                  ? `你的答案：${/\p{Script=Han}/u.test(answer.given) ? shortMeaning(answer.given, 18) : answer.given}`
                  : "未作答",
            };
          })}
        />
        <div className="learn-done-actions">
          {wrong.length ? (
            <button
              type="button"
              className="primary"
              onClick={() => onPractice(wrong, "mistakes")}
            >
              练习答错的 {wrong.length} 个词
            </button>
          ) : null}
          <button
            type="button"
            className={wrong.length ? "secondary" : "primary"}
            onClick={onAgain}
          >
            再测一次
          </button>
          <button type="button" className="text-button" onClick={onExit}>
            返回今日
          </button>
        </div>
        <p className="learn-note">自测不改变复习计划；在“练习”里作答后才会安排复习。</p>
      </main>
    </>
  );
}
