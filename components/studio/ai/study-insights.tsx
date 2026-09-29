"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { headwordLookup, MISTAKE_LABELS, summarizeMistakes, type MistakeKind } from "@/lib/mistakes";
import { suggestTargets } from "@/lib/writing";
import { AiStatus, ContrastView, DiagnoseView, PracticeView, StoryView } from "./ai-views";
import { useAssistant } from "./use-assistant";

const KINDS: MistakeKind[] = ["near-miss", "confusion", "spelling", "recall", "listening"];
const SKILL_FOR: Record<MistakeKind, string> = { "near-miss": "spelling", spelling: "spelling", confusion: "context", recall: "meaning", listening: "listening" };
type Tool = "diagnose" | "practice" | "story";

/** Mistake breakdown, confused pairs and the AI study tools on the record page. */
export default function StudyInsights({ data, onPractice, onWord }: {
  data: Vocabulary;
  onPractice: (entries: LexiconIndexEntry[]) => void;
  onWord: (entry: LexiconIndexEntry) => void;
}) {
  const lookup = useMemo(() => headwordLookup(data.index), [data.index]);
  const [since] = useState(() => Date.now() - 30 * 86_400_000);
  const summary = useMemo(() => summarizeMistakes(data.history.active, lookup, since), [data.history, lookup, since]);
  const entries = (ids: string[]) => ids.flatMap((id) => (data.byId.get(id) ? [data.byId.get(id)!] : []));
  const total = KINDS.reduce((sum, kind) => sum + summary.counts[kind], 0);
  const [pair, setPair] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const contrast = useAssistant("contrast-words", data);
  const diagnose = useAssistant("diagnose", data);
  const practice = useAssistant("generate-practice", data);
  const story = useAssistant("story", data);
  const weakIds = useMemo(() => [...new Set(KINDS.flatMap((kind) => summary.words[kind]))], [summary]);
  const dominant = KINDS.reduce((best, kind) => (summary.counts[kind] > summary.counts[best] ? kind : best), KINDS[0]);
  const storyWords = useMemo(() => suggestTargets(data.history.active, data.cards, data.byId, 8), [data.history, data.cards, data.byId]);
  const inputs = {
    diagnose: { wordIds: weakIds.slice(0, 20) },
    practice: { wordIds: weakIds.slice(0, 8), skill: SKILL_FOR[dominant], difficulty: "standard", count: 6 },
    story: { wordIds: storyWords.map((entry) => entry.id).slice(0, 8), level: "B1", length: "short" },
  };
  const runTool = (next: Tool, refresh = false) => {
    setTool(next);
    const hook = next === "diagnose" ? diagnose : next === "practice" ? practice : story;
    void hook.run(inputs[next], { refresh });
  };
  const active = tool === "diagnose" ? diagnose : tool === "practice" ? practice : tool === "story" ? story : null;

  return (
    <>
      <section className="insights" aria-labelledby="mistakes-title">
        <div className="section-heading">
          <h2 id="mistakes-title">错在哪里</h2>
          <span>最近 30 天，按作答内容细分</span>
        </div>
        {total ? (
          <ul className="insight-rows">
            {KINDS.filter((kind) => summary.counts[kind]).map((kind) => (
              <li key={kind}>
                <span><strong>{MISTAKE_LABELS[kind].title}</strong><small>{MISTAKE_LABELS[kind].detail}</small></span>
                <span className="insight-count learn-tabular">{summary.counts[kind]} 次 · {summary.words[kind].length} 词</span>
                <button className="text-button" onClick={() => onPractice(entries(summary.words[kind].slice(0, 40)))}>练这些词<ChevronRight size={14} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        ) : <p className="ai-note">最近 30 天没有答错的记录。</p>}
        {summary.confusions.length > 0 && (
          <>
            <h3 className="insight-subhead">容易混的词</h3>
            <ul className="insight-pairs">
              {summary.confusions.slice(0, 6).map((item) => {
                const key = `${item.cardId}|${item.withId}`;
                const words = entries([item.cardId, item.withId]);
                if (words.length < 2) return null;
                return (
                  <li key={key}>
                    <p>
                      <button className="english" onClick={() => onWord(words[0])}>{words[0].headword}</button>
                      <span aria-label="和">⇄</span>
                      <button className="english" onClick={() => onWord(words[1])}>{words[1].headword}</button>
                      <small className="learn-tabular">混了 {item.count} 次</small>
                    </p>
                    <div>
                      <button className="text-button" onClick={() => onPractice(words)}>一起练</button>
                      {data.settings.aiEnabled && (
                        <button className="text-button" onClick={() => { setPair(key); void contrast.run({ wordIds: [item.cardId, item.withId] }); }}>
                          <Sparkles size={13} aria-hidden="true" />AI 辨析
                        </button>
                      )}
                    </div>
                    {pair === key && (
                      <div className="insight-result">
                        {contrast.state.status === "done" && <ContrastView result={contrast.state.value.result} words={data.byId} />}
                        <AiStatus state={contrast.state} onCancel={contrast.cancel} onRetry={() => contrast.run({ wordIds: [item.cardId, item.withId] })}
                          onRefresh={contrast.state.status === "done" ? () => contrast.run({ wordIds: [item.cardId, item.withId] }, { refresh: true }) : undefined} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      {data.settings.aiEnabled && (
        <section className="insights" aria-labelledby="ai-tools-title">
          <div className="section-heading">
            <h2 id="ai-tools-title">AI 学习助手</h2>
            <span>结合你的作答记录；结果保存在本机</span>
          </div>
          <div className="insight-tools">
            <button aria-pressed={tool === "diagnose"} disabled={!data.history.active.length} onClick={() => runTool("diagnose")}>
              <strong>学习诊断</strong><small>看看最近的问题和一周计划</small>
            </button>
            <button aria-pressed={tool === "practice"} disabled={!weakIds.length} onClick={() => runTool("practice")}>
              <strong>针对错题出题</strong><small>{weakIds.length ? `用 ${Math.min(8, weakIds.length)} 个常错词出 6 题` : "还没有错题"}</small>
            </button>
            <button aria-pressed={tool === "story"} disabled={storyWords.length < 3} onClick={() => runTool("story")}>
              <strong>读一篇短文</strong><small>{storyWords.length >= 3 ? "用最近学的词写的新短文" : "至少学过 3 个词后可用"}</small>
            </button>
          </div>
          {tool && active && (
            <div className="insight-result">
              {active.state.status === "done" && (tool === "diagnose"
                ? <DiagnoseView result={active.state.value.result} words={data.byId} onWord={onWord} />
                : tool === "practice"
                  ? <PracticeView result={active.state.value.result} onFinish={(ids) => onPractice(entries(ids))} />
                  : <StoryView result={active.state.value.result} words={data.byId} />)}
              <AiStatus state={active.state} onCancel={active.cancel} onRetry={() => runTool(tool)} onRefresh={active.state.status === "done" ? () => runTool(tool, true) : undefined} />
            </div>
          )}
        </section>
      )}
    </>
  );
}
