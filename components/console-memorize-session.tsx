"use client";

import { ArrowLeft, Bot, Check, CircleAlert, Clock3, Keyboard, RotateCcw, Sparkles, Volume2, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getAcquisitionStats,
  getNextAcquisitionAction,
  type AcquisitionResponse,
  type AcquisitionSession,
} from "@/lib/acquisition";
import { compactUsage, postAssistant, type AssistantMeta } from "@/lib/assistant/client";
import { speakSystem, type LexiconDetail } from "@/lib/lexicon";

type MemoryCard = { wordId: string; hook: string; recallPrompt: string; answer: string; microExample: string; translation: string };
type MemoryResult = { cards: MemoryCard[] };

const stageLabels = { preview: "预习编码", "cue-recall": "线索回忆", spelling: "拼写提取", production: "主动产出", "delayed-recall": "延迟再测" };

function countdown(resumeAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((new Date(resumeAt).getTime() - now) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function ConsoleMemorizeSession({ session, details, aiEnabled, hasNextBatch, onSubmit, onExit, onNewBatch }: {
  session: AcquisitionSession;
  details: Map<string, LexiconDetail>;
  aiEnabled: boolean;
  hasNextBatch: boolean;
  onSubmit: (response: AcquisitionResponse) => Promise<void>;
  onExit: () => void;
  onNewBatch: () => void;
}) {
  const [now, setNow] = useState(() => Date.now()), [draft, setDraft] = useState({ actionId: "", value: "" }), [submitting, setSubmitting] = useState(false);
  const [memoryCards, setMemoryCards] = useState<Map<string, MemoryCard>>(new Map()), [aiLoading, setAiLoading] = useState(false), [aiError, setAiError] = useState<string | null>(null), [aiMeta, setAiMeta] = useState<AssistantMeta | null>(null);
  const next = getNextAcquisitionAction(session, new Date(now));
  const stats = getAcquisitionStats(session, new Date(now));
  const actionId = next.kind === "action" ? next.action.id : "none";
  const answer = draft.actionId === actionId ? draft.value : "";
  const setAnswer = (value: string) => setDraft({ actionId, value });
  const resumeAt = next.kind === "waiting" ? next.resumeAt : "";
  useEffect(() => {
    if (!resumeAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [resumeAt]);

  const detail = next.kind === "action" ? details.get(next.item.wordId) : undefined;
  const memory = next.kind === "action" ? memoryCards.get(next.item.wordId) : undefined;
  const completed = stats.promoted + stats.needsSupport;
  const progress = Math.min(1, (completed + session.history.length / Math.max(1, session.items.length * 5)) / Math.max(1, session.items.length));

  const submit = async (response: Omit<AcquisitionResponse, "actionId" | "wordId"> = {}) => {
    if (next.kind !== "action") return;
    setSubmitting(true);
    try { await onSubmit({ actionId: next.action.id, wordId: next.item.wordId, ...response }); setNow(Date.now()); }
    finally { setSubmitting(false); }
  };
  const loadAiCards = async () => {
    setAiLoading(true); setAiError(null);
    try {
      const response = await postAssistant<MemoryResult>("memorize", { wordIds: session.items.map((item) => item.wordId), mode: "mixed", difficulty: "standard" });
      setMemoryCards(new Map(response.result.cards.map((card) => [card.wordId, card]))); setAiMeta(response.meta);
    } catch (cause) { setAiError(cause instanceof Error ? cause.message : "AI 记忆线索暂时不可用"); }
    finally { setAiLoading(false); }
  };

  if (next.kind === "complete") return <main className="memorize-session complete-shell">
    <section className="memorize-complete"><span className="completion-mark"><Check size={28}/></span><p className="console-kicker">ACQUISITION COMPLETE</p><h1>这批词已完成背诵门槛。</h1><p>通过延迟再测的词已经进入唯一的 FSRS 主状态；需要帮助的词没有伪装成已学会。</p><div className="completion-metrics"><div className="metric"><span>进入复习</span><strong>{stats.promoted}</strong><small>延迟回忆通过</small></div><div className="metric"><span>需要重学</span><strong>{stats.needsSupport}</strong><small>未写入正式复习</small></div><div className="metric"><span>背诵正确率</span><strong>{Math.round((stats.accuracy ?? 0) * 100)}%</strong><small>只统计本次背诵</small></div></div><div className="button-row center"><button className="console-secondary" onClick={onExit}>返回今日</button>{hasNextBatch && <button className="console-primary" onClick={onNewBatch}><RotateCcw size={15}/>下一批新词</button>}</div></section>
  </main>;

  if (next.kind === "waiting") return <main className="memorize-session waiting-shell">
    <header className="memorize-top"><button onClick={onExit} aria-label="退出并保存"><X size={18}/></button><span>背诵 · 延迟间隔</span><div className="memorize-track"><i><b style={{ width: `${progress * 100}%` }}/></i><strong>{stats.promoted + stats.needsSupport}<em>/ {stats.total}</em></strong></div></header>
    <section className="memorize-wait"><Clock3 size={30}/><p className="console-kicker">SPACED RETRIEVAL</p><h1>{countdown(next.resumeAt, now)} 后再测</h1><p>先离开也没关系，进度已保存。短暂间隔能区分“刚看过”与“能从记忆里提取”。</p><button className="console-secondary" onClick={onExit}><ArrowLeft size={15}/>先去做其他任务</button></section>
  </main>;

  const { action, item } = next;
  return <main className="memorize-session">
    <header className="memorize-top"><button onClick={onExit} aria-label="退出并保存"><X size={18}/></button><span>背诵 · {stageLabels[action.stage]}</span><div className="memorize-track"><i><b style={{ width: `${progress * 100}%` }}/></i><strong>{Math.min(stats.total, stats.promoted + stats.needsSupport + 1)}<em>/ {stats.total}</em></strong></div><button className="memorize-ai-button" onClick={loadAiCards} disabled={!aiEnabled || aiLoading} title={aiEnabled ? "只发送本批正式词条 ID" : "请先在设置中启用 AI"}><Bot size={14}/>{aiLoading ? "生成中" : memoryCards.size ? "线索已缓存" : "AI 短线索"}</button></header>
    <div className="memorize-body"><section className="memorize-main">
      <div className="memorize-stage-label"><span>{stageLabels[action.stage]}</span>{action.remediation && <em>补救轮</em>}<small>第 {action.sequence + 1} 个动作</small></div>
      <article className="memorize-card">
        {action.stage === "preview" && <><button className="memorize-audio" onClick={() => speakSystem(item.headword)}><Volume2 size={20}/>播放系统语音</button><h1>{item.headword}</h1>{item.headword && <p className="memorize-ipa">{detail?.britishIpa ? `BrE /${detail.britishIpa}/` : "先看词形，再读出声音"}</p>}<div className="memorize-meaning"><span>核心义</span><strong>{item.meaning}</strong>{detail?.englishCore && <small>{detail.englishCore}</small>}</div>{detail?.openExample && <div className="memorize-example"><span>开放语料例句</span><p>{detail.openExample}</p></div>}{memory && <div className="memorize-hook"><Sparkles size={15}/><div><strong>{memory.hook}</strong><p>{memory.recallPrompt}</p><small>AI 生成短线索，不作为教材证据</small></div></div>}<button className="console-primary memorize-next" onClick={() => submit()} disabled={submitting}>遮住答案，开始回忆</button></>}
        {action.stage === "cue-recall" && <><p className="memorize-prompt-label">看到词形，先在脑中说出核心义</p><h1>{item.headword}</h1><button className="memorize-audio inline" onClick={() => speakSystem(item.headword)}><Volume2 size={17}/>读音</button><p className="memorize-instruction">不要翻回预习页。能完整想起主要含义再选“想起了”。</p><div className="memorize-judgment"><button onClick={() => submit({ judgment: "fail" })} disabled={submitting}>没想起</button><button className="pass" onClick={() => submit({ judgment: "pass" })} disabled={submitting}>想起了</button></div></>}
        {action.stage === "spelling" && <><p className="memorize-prompt-label">根据核心义写出完整词形</p><h2>{item.meaning}</h2><label className="memorize-answer"><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => event.key === "Enter" && answer.trim() && submit({ answer })} placeholder="输入英文词或短语" spellCheck={false} autoComplete="off"/></label><button className="console-primary memorize-next" onClick={() => submit({ answer })} disabled={submitting || !answer.trim()}>核对拼写</button></>}
        {action.stage === "production" && <><p className="memorize-prompt-label">不抄例句，用目标词写一个完整句子</p><h2>{item.headword}</h2><p className="memorize-instruction">至少 5 个词，必须包含目标词；正文只在本题内存中使用，不写入背诵进度。</p><label className="memorize-answer"><textarea autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={`用 ${item.headword} 写句子`}/></label><button className="console-primary memorize-next" onClick={() => submit({ answer })} disabled={submitting || !answer.trim()}>提交产出</button></>}
        {action.stage === "delayed-recall" && <><p className="memorize-prompt-label">延迟回忆：不看词形，根据含义写出英文</p><h2>{item.meaning}</h2><label className="memorize-answer"><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => event.key === "Enter" && answer.trim() && submit({ answer })} placeholder="输入英文词或短语" spellCheck={false} autoComplete="off"/></label><button className="console-primary memorize-next" onClick={() => submit({ answer })} disabled={submitting || !answer.trim()}>完成延迟再测</button></>}
      </article>
      {aiError && <p className="ai-insight-error"><CircleAlert size={14}/>{aiError}</p>}{aiMeta && <p className="ai-insight-meta">{compactUsage(aiMeta)} · 背诵线索可安全复用响应缓存</p>}
      <footer className="memorize-help"><Keyboard size={14}/><span>作答正文不落盘 · 可随时退出并继续 · 最后一关通过后才进入 FSRS</span></footer>
    </section><aside className="memorize-rail"><h2>为什么这样背</h2><ol><li><strong>先编码</strong><span>词形、声音、核心义和一个语境同时出现。</span></li><li><strong>再提取</strong><span>主动回忆与拼写，不用反复重读代替记忆。</span></li><li><strong>做产出</strong><span>用自己的句子建立可调用的词义连接。</span></li><li><strong>延迟再测</strong><span>通过后才进入长期复习排程。</span></li></ol><div><strong>本批状态</strong><p>完成 {stats.promoted + stats.needsSupport} / {stats.total}</p><p>交互 {stats.interactions} 次</p><p>未保存任何作答正文</p></div></aside></div>
  </main>;
}
