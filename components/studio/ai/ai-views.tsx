"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Check, CircleAlert, CircleHelp, RotateCcw, X } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { targetMatcher } from "@/lib/writing";
import { useElapsed, type AssistantState } from "./use-assistant";

type Words = ReadonlyMap<string, LexiconIndexEntry>;
const texts = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const list = <T,>(value: unknown) => (Array.isArray(value) ? (value as T[]) : []);
const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Waiting, failure and "where did this answer come from" for one assistant request. */
export function AiStatus<T>({ state, onRetry, onCancel, onRefresh, busyLabel = "AI 正在生成" }: {
  state: AssistantState<T>; onRetry?: () => void; onCancel?: () => void; onRefresh?: () => void; busyLabel?: string;
}) {
  const seconds = useElapsed(state.status === "loading" ? state.startedAt : null);
  if (state.status === "loading") return (
    <div className="ai-status" role="status">
      <span className="ai-spinner" aria-hidden="true" />
      <span>{busyLabel}{seconds >= 3 ? `… ${seconds} 秒` : "…"}{seconds >= 25 ? "（长回答需要一两分钟）" : ""}</span>
      {onCancel && <button className="text-button" onClick={onCancel}>取消</button>}
    </div>
  );
  if (state.status === "error") return (
    <div className="ai-status is-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <span>{state.message}</span>
      {onRetry && state.code !== "token_budget_exhausted" && <button className="text-button" onClick={onRetry}>重试</button>}
    </div>
  );
  if (state.status !== "done") return null;
  const { cachedAt, usage } = state.value;
  return (
    <p className="ai-meta">
      <span>
        {cachedAt ? `本机保存的回答 · ${time(cachedAt)}` : usage
          ? `本次 ${usage.total.toLocaleString()} token${usage.cacheHit ? `，其中 ${usage.cacheHit.toLocaleString()} 命中缓存` : ""}${usage.estimated ? "（估算）" : ""}`
          : "刚刚生成"}
        {" · "}AI 生成，仅供参考
      </span>
      {onRefresh && <button className="text-button" onClick={onRefresh}><RotateCcw size={13} aria-hidden="true" />重新生成</button>}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ai-section"><h4>{title}</h4>{children}</section>;
}

function Bullets({ items }: { items: string[] }) {
  return items.length ? <ul className="ai-bullets">{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : null;
}

function PersonalNote({ value }: { value: unknown }) {
  return typeof value === "string" && value ? <p className="ai-personal"><strong>结合你的记录</strong>{value}</p> : null;
}

function Limitations({ value }: { value: unknown }) {
  const items = texts(value);
  return items.length ? <p className="ai-limits">{items.join(" ")}</p> : null;
}

const english = (text: string) => <span className="english" lang="en">{text}</span>;

export function ExplainView({ result }: { result: Record<string, unknown> }) {
  return (
    <div className="ai-result">
      {typeof result.summary === "string" && <p className="ai-lead">{result.summary}</p>}
      <PersonalNote value={result.personalNote} />
      {texts(result.meaning).length > 0 && <Section title="词义"><Bullets items={texts(result.meaning)} /></Section>}
      {texts(result.grammar).length > 0 && <Section title="用法与语法"><Bullets items={texts(result.grammar)} /></Section>}
      {texts(result.collocations).length > 0 && <Section title="常见搭配"><Bullets items={texts(result.collocations)} /></Section>}
      {list<{ sentence: string; translation: string }>(result.examples).length > 0 && (
        <Section title="例句（AI 新写）">
          {list<{ sentence: string; translation: string }>(result.examples).map((example, i) => (
            <p key={i} className="ai-example">{english(example.sentence)}<small>{example.translation}</small></p>
          ))}
        </Section>
      )}
      <Limitations value={result.limitations} />
    </div>
  );
}

const STATUS = {
  ok: { Icon: Check, label: "没问题", tone: "good" },
  issue: { Icon: X, label: "需要修改", tone: "bad" },
  uncertain: { Icon: CircleHelp, label: "不确定", tone: "maybe" },
} as const;

export function SentenceCheckView({ result }: { result: Record<string, unknown> }) {
  const verdict = result.verdict === "correct" ? "句子正确" : result.verdict === "needs-revision" ? "需要修改" : "无法确定";
  return (
    <div className="ai-result">
      <p className="ai-verdict" data-verdict={String(result.verdict)}>{verdict}</p>
      <dl className="ai-checks">
        {([["grammar", "语法"], ["collocation", "用词与搭配"], ["style", "表达"]] as const).map(([key, label]) => {
          const block = result[key] as { status?: keyof typeof STATUS; feedback?: string } | undefined;
          const status = STATUS[block?.status || "uncertain"] || STATUS.uncertain;
          return (
            <div key={key} data-tone={status.tone}>
              <dt><status.Icon size={15} aria-hidden="true" />{label}<span className="sr-only">：{status.label}</span></dt>
              <dd>{block?.feedback}</dd>
            </div>
          );
        })}
      </dl>
      {typeof result.revision === "string" && result.revision && <Section title="参考改写"><p className="ai-example">{english(result.revision)}</p></Section>}
      <PersonalNote value={result.personalNote} />
      <Limitations value={result.limitations} />
    </div>
  );
}

export function ContrastView({ result, words }: { result: Record<string, unknown>; words: Words }) {
  return (
    <div className="ai-result">
      {typeof result.summary === "string" && <p className="ai-lead">{result.summary}</p>}
      <PersonalNote value={result.personalNote} />
      <div className="ai-contrast">
        {list<{ wordId: string; use: string; pattern: string; contrast: string }>(result.differences).map((item) => (
          <div key={item.wordId}>
            <h4 className="english">{words.get(item.wordId)?.headword || "词条"}</h4>
            <p>{item.use}</p>
            <p className="english ai-pattern">{item.pattern}</p>
            <p className="ai-note">{item.contrast}</p>
          </div>
        ))}
      </div>
      {list<{ sentences: string[]; note: string }>(result.examplePairs).length > 0 && (
        <Section title="对比例句">
          {list<{ sentences: string[]; note: string }>(result.examplePairs).map((pair, i) => (
            <div key={i} className="ai-example">
              {texts(pair.sentences).map((sentence, j) => <Fragment key={j}>{english(sentence)}</Fragment>)}
              <small>{pair.note}</small>
            </div>
          ))}
        </Section>
      )}
      <Limitations value={result.limitations} />
    </div>
  );
}

export function MnemonicView({ result }: { result: Record<string, unknown> }) {
  const parts = list<{ part: string; meaning: string }>(result.breakdown);
  const confidence = { high: "较有把握", medium: "部分有把握", low: "把握不大，仅作联想" }[String(result.confidence)] || "";
  return (
    <div className="ai-result">
      {parts.length > 0 && (
        <div className="ai-parts" aria-label="词根词缀拆分">
          {parts.map((part, i) => <span key={i}><strong className="english">{part.part}</strong><small>{part.meaning}</small></span>)}
        </div>
      )}
      {confidence && <p className="ai-note">词源：{confidence}</p>}
      {typeof result.memoryHook === "string" && <Section title="联想"><p>{result.memoryHook}</p></Section>}
      {typeof result.story === "string" && <Section title="小场景"><p>{result.story}</p></Section>}
      {texts(result.family).length > 0 && <Section title="同族词"><p className="english">{texts(result.family).join(" · ")}</p></Section>}
      <Limitations value={result.limitations} />
    </div>
  );
}

type PracticeItem = { type: string; prompt: string; options: string[]; answer: string; explanation: string; evidenceIds: string[] };
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/[.!?。]$/, "") === b.trim().toLowerCase().replace(/[.!?。]$/, "");

/** Generated practice. Answers here are not written to the review schedule. */
export function PracticeView({ result, onFinish }: { result: Record<string, unknown>; onFinish?: (wrongWordIds: string[]) => void }) {
  const items = list<PracticeItem>(result.items);
  const [answers, setAnswers] = useState<Record<number, { given: string; correct: boolean | null }>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const done = Object.keys(answers).length === items.length;
  const wrong = [...new Set(items.flatMap((item, i) => (answers[i]?.correct === false ? item.evidenceIds : [])))];
  const answer = (index: number, given: string, correct: boolean | null) => setAnswers((current) => ({ ...current, [index]: { given, correct } }));
  return (
    <div className="ai-result ai-practice">
      {typeof result.title === "string" && <p className="ai-lead">{result.title}</p>}
      {typeof result.focusReason === "string" && <p className="ai-note">{result.focusReason}</p>}
      <ol>
        {items.map((item, i) => {
          const state = answers[i];
          return (
            <li key={i} data-state={state ? (state.correct === null ? "self" : state.correct ? "right" : "wrong") : "open"}>
              <p className="english"><b className="ai-no">{i + 1}</b>{item.prompt}</p>
              {item.type === "choice" ? (
                <div className="ai-options">
                  {item.options.map((option) => (
                    <button key={option} className="english" disabled={Boolean(state)} data-picked={state?.given === option || undefined}
                      data-answer={state && option === item.answer ? true : undefined} onClick={() => answer(i, option, option === item.answer)}>{option}</button>
                  ))}
                </div>
              ) : state ? null : (
                <form className="ai-answer" onSubmit={(event) => {
                  event.preventDefault();
                  const given = drafts[i] || "";
                  // Open answers (rewrite, own sentence) cannot be graded by string match.
                  answer(i, given, item.type === "gap" ? same(given, item.answer) : null);
                }}>
                  <input className="english" lang="en" aria-label={`第 ${i + 1} 题答案`} value={drafts[i] || ""} autoComplete="off" autoCapitalize="off" spellCheck={false}
                    onChange={(event) => setDrafts((current) => ({ ...current, [i]: event.target.value }))} />
                  <button className="secondary" type="submit">对答案</button>
                </form>
              )}
              {state && (
                <div className="ai-reveal">
                  {state.correct === false && <p>你的答案：<span className="english">{state.given || "（空）"}</span></p>}
                  <p>参考答案：<span className="english">{item.answer}</span></p>
                  <small>{item.explanation}</small>
                  {state.correct === null && (
                    <div className="ai-self">
                      <span>和参考答案比，你写得：</span>
                      <button className="text-button" onClick={() => answer(i, state.given, true)}>基本正确</button>
                      <button className="text-button" onClick={() => answer(i, state.given, false)}>有错</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {done && onFinish && (
        <div className="ai-finish">
          <span>{wrong.length ? `答错的题涉及 ${wrong.length} 个词。` : "全部答对。"}这些练习不改变复习计划。</span>
          {wrong.length > 0 && <button className="primary" onClick={() => onFinish(wrong)}>把这些词加入练习</button>}
        </div>
      )}
      <Limitations value={result.limitations} />
    </div>
  );
}

/** Highlights the target words inside generated English text. */
function Marked({ text, words }: { text: string; words: LexiconIndexEntry[] }) {
  const parts = useMemo(() => {
    const ranges: [number, number][] = [];
    for (const word of words) {
      const pattern = targetMatcher(word.headword);
      if (pattern) for (const match of text.matchAll(pattern)) ranges.push([match.index!, match.index! + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const out: ReactNode[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue;
      out.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>);
      at = end;
    }
    out.push(text.slice(at));
    return out;
  }, [text, words]);
  return <>{parts}</>;
}

export function StoryView({ result, words }: { result: Record<string, unknown>; words: Words }) {
  const used = texts(result.usedWordIds).flatMap((id) => (words.get(id) ? [words.get(id)!] : []));
  const [picked, setPicked] = useState<Record<number, number>>({});
  return (
    <div className="ai-result ai-story">
      {typeof result.title === "string" && <h4 className="english ai-story-title">{result.title}</h4>}
      <div className="ai-story-body english" lang="en">
        {texts(result.paragraphs).map((paragraph, i) => <p key={i}><Marked text={paragraph} words={used} /></p>)}
      </div>
      {list<{ wordId: string; meaningInContext: string }>(result.glossary).length > 0 && (
        <Section title="文中词义">
          <dl className="ai-glossary">
            {list<{ wordId: string; meaningInContext: string }>(result.glossary).map((item) => (
              <div key={item.wordId}><dt className="english">{words.get(item.wordId)?.headword}</dt><dd>{item.meaningInContext}</dd></div>
            ))}
          </dl>
        </Section>
      )}
      {list<{ prompt: string; options: string[]; answerIndex: number; explanation: string }>(result.questions).length > 0 && (
        <Section title="理解题">
          <ol className="ai-practice-list">
            {list<{ prompt: string; options: string[]; answerIndex: number; explanation: string }>(result.questions).map((question, i) => (
              <li key={i} data-state={picked[i] === undefined ? "open" : picked[i] === question.answerIndex ? "right" : "wrong"}>
                <p className="english"><b className="ai-no">{i + 1}</b>{question.prompt}</p>
                <div className="ai-options">
                  {question.options.map((option, j) => (
                    <button key={j} className="english" disabled={picked[i] !== undefined} data-picked={picked[i] === j || undefined}
                      data-answer={picked[i] !== undefined && j === question.answerIndex ? true : undefined}
                      onClick={() => setPicked((current) => ({ ...current, [i]: j }))}>{option}</button>
                  ))}
                </div>
                {picked[i] !== undefined && <small className="ai-note">{question.explanation}</small>}
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Limitations value={result.limitations} />
    </div>
  );
}

export function DiagnoseView({ result, words, onWord }: { result: Record<string, unknown>; words: Words; onWord?: (entry: LexiconIndexEntry) => void }) {
  const focus = texts(result.wordsToFocus).flatMap((id) => (words.get(id) ? [words.get(id)!] : []));
  return (
    <div className="ai-result">
      {typeof result.summary === "string" && <p className="ai-lead">{result.summary}</p>}
      {texts(result.strengths).length > 0 && <Section title="做得好的地方"><Bullets items={texts(result.strengths)} /></Section>}
      {list<{ pattern: string; evidence: string; advice: string }>(result.problems).length > 0 && (
        <Section title="需要注意">
          <dl className="ai-problems">
            {list<{ pattern: string; evidence: string; advice: string }>(result.problems).map((problem, i) => (
              <div key={i}><dt>{problem.pattern}</dt><dd><small>{problem.evidence}</small>{problem.advice}</dd></div>
            ))}
          </dl>
        </Section>
      )}
      {list<{ day: string; focus: string; minutes: number }>(result.plan).length > 0 && (
        <Section title="接下来一周">
          <table className="ai-plan">
            <tbody>
              {list<{ day: string; focus: string; minutes: number }>(result.plan).map((day, i) => (
                <tr key={i}><th scope="row">{day.day}</th><td>{day.focus}</td><td>{day.minutes} 分钟</td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {focus.length > 0 && (
        <Section title="优先练这些词">
          <div className="ai-chips">{focus.map((entry) => <button key={entry.id} className="english" onClick={() => onWord?.(entry)}>{entry.headword}</button>)}</div>
        </Section>
      )}
      <Limitations value={result.limitations} />
    </div>
  );
}
