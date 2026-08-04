"use client";

import { Bot, CircleAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { compactUsage, postAssistant, type AssistantMeta } from "@/lib/assistant/client";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import type { Question } from "@/lib/questions";

type Explain = { kind: "explain"; summary: string; meaning: string[]; grammar: string[]; collocations: string[]; examples: Array<{ sentence: string; translation: string }> };
type CheckSentence = { kind: "check-sentence"; verdict: string; grammar: { feedback: string }; collocation: { feedback: string }; style: { feedback: string }; revision: string | null };
type Practice = { kind: "generate-practice"; title: string; items: Array<{ prompt: string; answer: string; explanation: string }> };
type CoachResult = Explain | CheckSentence | Practice;

export default function StudyAiCoach({ enabled, entry, question, answer }: { enabled: boolean; entry: LexiconIndexEntry; question: Question; answer: string }) {
  const [loading, setLoading] = useState<"explain" | "practice" | null>(null), [result, setResult] = useState<CoachResult | null>(null), [error, setError] = useState<string | null>(null), [meta, setMeta] = useState<AssistantMeta | null>(null);
  const run = async (mode: "explain" | "practice") => {
    setLoading(mode); setError(null);
    try {
      const response = mode === "practice"
        ? await postAssistant<Practice>("generate-practice", { wordIds: [entry.id], skill: question.skill, difficulty: "foundation", count: 2, masteryTags: question.skill === "spelling" ? ["spelling-weak"] : [] })
        : question.type === "sentence-output" && answer.trim()
          ? await postAssistant<CheckSentence>("check-sentence", { wordId: entry.id, sentence: answer.trim(), masteryTags: ["output-weak"] })
          : await postAssistant<Explain>("explain", { wordId: entry.id, focus: question.skill === "collocation" ? "collocation" : question.skill === "context" ? "meaning" : "general", masteryTags: [] });
      setResult(response.result); setMeta(response.meta);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "AI 学习辅助暂时不可用"); }
    finally { setLoading(null); }
  };
  return <section className="study-ai-coach">
    <header><div><Bot size={16}/><strong>AI 短辅导</strong><small>不参与评分或 FSRS 排程</small></div><span><button onClick={() => run("explain")} disabled={!enabled || loading !== null}>{loading === "explain" ? "生成中…" : question.type === "sentence-output" ? "检查这句话" : "精讲本题"}</button><button onClick={() => run("practice")} disabled={!enabled || loading !== null}>{loading === "practice" ? "生成中…" : "出 2 道加练"}</button></span></header>
    {!enabled && <p className="study-ai-note">AI 未启用；当前题仍可完整学习和评分。</p>}
    {error && <p className="ai-insight-error"><CircleAlert size={14}/>{error}</p>}
    {result?.kind === "explain" && <div className="study-ai-result"><p><Sparkles size={14}/>{result.summary}</p>{result.meaning.slice(0,3).map((line) => <span key={line}>{line}</span>)}{result.collocations.slice(0,3).map((line) => <span key={line}>{line}</span>)}{result.examples.slice(0,1).map((example) => <blockquote key={example.sentence}>{example.sentence}<small>{example.translation} · AI 新写例句</small></blockquote>)}</div>}
    {result?.kind === "check-sentence" && <div className="study-ai-result"><p><Sparkles size={14}/>{result.verdict === "correct" ? "句子可用" : result.verdict === "needs-revision" ? "建议修改" : "需要更多语境"}</p><span>{result.grammar.feedback}</span><span>{result.collocation.feedback}</span><span>{result.style.feedback}</span>{result.revision && <blockquote>{result.revision}<small>AI 建议改写</small></blockquote>}</div>}
    {result?.kind === "generate-practice" && <div className="study-ai-result"><p><Sparkles size={14}/>{result.title}</p>{result.items.map((item, index) => <details key={`${item.prompt}-${index}`}><summary>{item.prompt}</summary><strong>{item.answer}</strong><small>{item.explanation}</small></details>)}</div>}
    {meta && <p className="ai-insight-meta">{compactUsage(meta)} · 输出受任务预算约束</p>}
  </section>;
}
