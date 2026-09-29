"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, CircleHelp, X } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { locateIssues } from "@/lib/writing";

type Issue = { quote: string; type: string; suggestion: string; reason: string };
type TargetVerdict = { wordId: string; status: "good" | "issue" | "missing"; note: string };
type Upgrade = { original: string; better: string; note: string };

const ISSUE_TYPES: Record<string, string> = {
  grammar: "语法", spelling: "拼写", "word-choice": "用词", collocation: "搭配", coherence: "衔接", punctuation: "标点", style: "表达",
};
const DIMENSIONS = [["content", "内容"], ["vocabulary", "词汇"], ["grammar", "语法"], ["structure", "结构"]] as const;
const list = <T,>(value: unknown) => (Array.isArray(value) ? (value as T[]) : []);

function Annotated({ essay, issues }: { essay: string; issues: Issue[] }) {
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let at = 0;
    for (const mark of locateIssues(essay, issues)) {
      out.push(essay.slice(at, mark.start));
      out.push(<mark key={mark.index} className="essay-mark">{essay.slice(mark.start, mark.end)}<sup>{mark.index + 1}</sup></mark>);
      at = mark.end;
    }
    out.push(essay.slice(at));
    return out;
  }, [essay, issues]);
  return <div className="essay-annotated english" lang="en">{parts}</div>;
}

export default function EssayReview({ essay, result, previous, targets, words, reviewedAt, onPractice, onWord }: {
  essay: string;
  result: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  targets: LexiconIndexEntry[];
  words: ReadonlyMap<string, LexiconIndexEntry>;
  reviewedAt: string;
  onPractice: (wordIds: string[]) => void;
  onWord: (entry: LexiconIndexEntry) => void;
}) {
  const [showRevised, setShowRevised] = useState(false);
  const issues = list<Issue>(result.issues);
  const verdicts = list<TargetVerdict>(result.targetWords);
  const upgrades = list<Upgrade>(result.upgrades);
  const scores = (result.scores || {}) as Record<string, number>;
  const score = Number(result.estimatedScore), outOf = Number(result.outOf);
  const before = previous ? Number(previous.estimatedScore) : null;
  const needsWork = verdicts.filter((item) => item.status === "issue").map((item) => item.wordId);
  // Target words the model did not mention are listed too, as not yet judged.
  const judged = new Set(verdicts.map((item) => item.wordId));
  return (
    <article className="essay-review" aria-labelledby="review-title">
      <header className="essay-score">
        <div>
          <h1 id="review-title" tabIndex={-1}>批改结果</h1>
          <p className="ai-note">{new Date(reviewedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · AI 估分，仅供参考</p>
        </div>
        <p className="essay-total" aria-label={`估计得分 ${score} 分，满分 ${outOf} 分`}>
          <strong className="learn-tabular">{Number.isFinite(score) ? score : "—"}</strong><span>/ {outOf}</span>
          {before !== null && Number.isFinite(before) && <small data-trend={score > before ? "up" : score < before ? "down" : "same"}>上一版 {before}</small>}
        </p>
      </header>
      <dl className="essay-dimensions">
        {DIMENSIONS.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd aria-label={`${label} ${scores[key] ?? 0} / 5`}>
              {[1, 2, 3, 4, 5].map((step) => <i key={step} data-on={step <= (scores[key] ?? 0)} />)}
              <span className="learn-tabular">{scores[key] ?? 0}</span>
            </dd>
          </div>
        ))}
      </dl>
      {typeof result.overall === "string" && <p className="ai-lead essay-overall">{result.overall}</p>}

      <div className="essay-body">
        <section className="essay-text" aria-label="原文与批注">
          <Annotated essay={essay} issues={issues} />
        </section>
        <section className="essay-issues" aria-labelledby="issues-title">
          <h2 id="issues-title">{issues.length ? `${issues.length} 处需要修改` : "没有发现明显错误"}</h2>
          <ol>
            {issues.map((issue, i) => (
              <li key={i}>
                <span className="essay-issue-head"><b className="learn-tabular">{i + 1}</b><span className="essay-issue-type">{ISSUE_TYPES[issue.type] || issue.type}</span></span>
                <p><del className="english">{issue.quote}</del> → <ins className="english">{issue.suggestion}</ins></p>
                <small>{issue.reason}</small>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {targets.length > 0 && (
        <section className="essay-section" aria-labelledby="targets-review">
          <h2 id="targets-review">目标词用得怎么样</h2>
          <ul className="essay-targets">
            {verdicts.map((item) => {
              const entry = words.get(item.wordId);
              const Icon = item.status === "good" ? Check : item.status === "issue" ? X : CircleHelp;
              return (
                <li key={item.wordId} data-status={item.status}>
                  <Icon size={15} aria-hidden="true" />
                  <button className="english" onClick={() => entry && onWord(entry)}>{entry?.headword}</button>
                  <span className="sr-only">{item.status === "good" ? "用得恰当" : item.status === "issue" ? "有问题" : "没有用到"}</span>
                  <p>{item.note}</p>
                </li>
              );
            })}
            {targets.filter((entry) => !judged.has(entry.id)).map((entry) => (
              <li key={entry.id} data-status="missing"><CircleHelp size={15} aria-hidden="true" /><button className="english" onClick={() => onWord(entry)}>{entry.headword}</button><p>批改中没有评价这个词。</p></li>
            ))}
          </ul>
          {needsWork.length > 0 && <button className="secondary" onClick={() => onPractice(needsWork)}>把用错的 {needsWork.length} 个词加入练习</button>}
        </section>
      )}

      {upgrades.length > 0 && (
        <section className="essay-section" aria-labelledby="upgrades-title">
          <h2 id="upgrades-title">可以写得更好</h2>
          <ul className="essay-upgrades">
            {upgrades.map((item, i) => (
              <li key={i}><p><span className="english">{item.original}</span> → <strong className="english">{item.better}</strong></p><small>{item.note}</small></li>
            ))}
          </ul>
        </section>
      )}

      {list<string>(result.nextSteps).length > 0 && (
        <section className="essay-section" aria-labelledby="next-title">
          <h2 id="next-title">下次可以练</h2>
          <ul className="ai-bullets">{list<string>(result.nextSteps).map((step, i) => <li key={i}>{step}</li>)}</ul>
        </section>
      )}

      {typeof result.revised === "string" && result.revised && (
        <section className="essay-section">
          <button className="text-button" aria-expanded={showRevised} onClick={() => setShowRevised(!showRevised)}>{showRevised ? "收起修改稿" : "看 AI 修改稿"}</button>
          {showRevised && <div className="essay-revised english" lang="en">{result.revised}</div>}
        </section>
      )}
      {list<string>(result.limitations).length > 0 && <p className="ai-limits">{list<string>(result.limitations).join(" ")}</p>}
    </article>
  );
}
