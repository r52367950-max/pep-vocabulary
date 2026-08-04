"use client";

import { BarChart3, Bot, CalendarRange, ChevronRight, CircleAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { compactUsage, postAssistant, type AssistantMeta } from "@/lib/assistant/client";
import type { LexiconIndexEntry } from "@/lib/lexicon";

type SkillStat = { skill: "meaning" | "listening" | "spelling" | "context" | "collocation" | "output"; attempts: number; accuracyPercent: number };
type AnalysisRequest = { wordIds: string[]; periodDays: number; reviewCount: number; uniqueWords: number; retentionPercent: number; averageSeconds: number; skillStats: SkillStat[] };
type AnalysisResult = {
  summary: string;
  findings: Array<{ signal: "retention" | "speed" | "consistency" | "skill-gap"; note: string; evidenceIds: string[] }>;
  actions: Array<{ action: "review" | "recall" | "spell" | "context" | "rest"; detail: string; wordIds: string[] }>;
};
type PlanRequest = { wordIds: string[]; days: number; minutesPerDay: number; newWordsPerDay: number; dueByDay: number[]; skillStats: SkillStat[] };
type PlanResult = {
  summary: string;
  sessions: Array<{ day: number; minutes: number; focus: string; wordIds: string[]; steps: string[] }>;
};

const signalLabels = { retention: "保持", speed: "速度", consistency: "稳定性", "skill-gap": "能力缺口" };
const actionLabels = { review: "复习", recall: "回忆", spell: "拼写", context: "语境", rest: "减负" };

function WordLine({ ids, byId }: { ids: string[]; byId: Map<string, LexiconIndexEntry> }) {
  const words = ids.map((id) => byId.get(id)?.headword).filter(Boolean);
  return words.length ? <small>{words.join(" · ")}</small> : null;
}

function AssistantState({ error, meta }: { error: string | null; meta: AssistantMeta | null }) {
  if (error) return <p className="ai-insight-error"><CircleAlert size={14}/>{error}</p>;
  const detail = compactUsage(meta);
  return detail ? <p className="ai-insight-meta">{detail} · 只发送匿名聚合与正式词条 ID</p> : null;
}

export function AiAnalysisPanel({ enabled, request, entries, onPractice }: { enabled: boolean; request: AnalysisRequest; entries: LexiconIndexEntry[]; onPractice: (wordIds: string[], action: AnalysisResult["actions"][number]["action"]) => void }) {
  const [loading, setLoading] = useState(false), [result, setResult] = useState<AnalysisResult | null>(null), [error, setError] = useState<string | null>(null), [meta, setMeta] = useState<AssistantMeta | null>(null);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const run = async () => {
    setLoading(true); setError(null);
    try { const response = await postAssistant<AnalysisResult>("analyze-learning", request); setResult(response.result); setMeta(response.meta); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "AI 分析暂时不可用"); }
    finally { setLoading(false); }
  };
  return <section className="analysis-panel ai-insight-panel span-two">
    <div className="panel-title"><div><span className="section-kicker">BOUNDED AI ANALYSIS</span><h2>AI 学习分析</h2></div><BarChart3 size={20}/></div>
    {!result ? <div className="ai-insight-empty"><div><strong>从匿名聚合找一项最值得先改的能力。</strong><p>不上传作答正文、注释、姓名或整份事件记录；模型只看有限统计和最多 12 个正式词条。</p></div><button className="console-primary" onClick={run} disabled={!enabled || loading || !request.wordIds.length}><Bot size={15}/>{loading ? "分析中…" : enabled ? "生成深度分析" : "先在设置启用 AI"}</button></div> : <><p className="ai-insight-summary"><Sparkles size={15}/>{result.summary}</p><div className="ai-finding-grid">{result.findings.map((finding, index) => <article key={`${finding.signal}-${index}`}><span>{signalLabels[finding.signal]}</span><p>{finding.note}</p><WordLine ids={finding.evidenceIds} byId={byId}/></article>)}</div><div className="ai-action-list">{result.actions.map((action, index) => <button key={`${action.action}-${index}`} onClick={() => onPractice(action.wordIds, action.action)} disabled={action.action === "rest"}><span>{actionLabels[action.action]}</span><div><strong>{action.detail}</strong><WordLine ids={action.wordIds} byId={byId}/></div>{action.action !== "rest" && <ChevronRight size={15}/>}</button>)}</div><button className="ai-refresh" onClick={run} disabled={loading}>{loading ? "更新中…" : "按当前数据更新"}</button></>}
    <AssistantState error={error} meta={meta}/>
  </section>;
}

export function AiPlanPanel({ enabled, request, entries, onStart }: { enabled: boolean; request: PlanRequest; entries: LexiconIndexEntry[]; onStart: (wordIds: string[]) => void }) {
  const [loading, setLoading] = useState(false), [result, setResult] = useState<PlanResult | null>(null), [error, setError] = useState<string | null>(null), [meta, setMeta] = useState<AssistantMeta | null>(null);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const run = async () => {
    setLoading(true); setError(null);
    try { const response = await postAssistant<PlanResult>("plan-study", request); setResult(response.result); setMeta(response.meta); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "AI 计划暂时不可用"); }
    finally { setLoading(false); }
  };
  return <section className="settings-section ai-plan-panel span-two">
    <div className="section-heading compact"><div><span className="section-kicker">LOAD-AWARE AI PLAN</span><h2>AI 七日微计划</h2></div><CalendarRange size={22}/></div>
    {!result ? <div className="ai-insight-empty"><div><strong>在现有 FSRS 负担上安排背诵、复习和专项。</strong><p>每日分钟数是硬上限；AI 不能改写卡片状态或绕过到期复习。</p></div><button className="console-primary" onClick={run} disabled={!enabled || loading || !request.wordIds.length}><Bot size={15}/>{loading ? "规划中…" : enabled ? "生成详细计划" : "先在设置启用 AI"}</button></div> : <><p className="ai-insight-summary"><Sparkles size={15}/>{result.summary}</p><div className="ai-plan-days">{result.sessions.map((session) => <article key={session.day}><header><span>第 {session.day} 天</span><strong>{session.minutes} 分钟</strong></header><p>{session.steps.join(" · ")}</p><WordLine ids={session.wordIds} byId={byId}/><button onClick={() => onStart(session.wordIds)} disabled={!session.wordIds.length}>开始这组<ChevronRight size={14}/></button></article>)}</div><button className="ai-refresh" onClick={run} disabled={loading}>{loading ? "更新中…" : "按当前负担更新"}</button></>}
    <AssistantState error={error} meta={meta}/>
  </section>;
}
