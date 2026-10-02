"use client";

import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { localSentenceCheck, normalizeAnswer } from "@/lib/questions";
import { editDistance, headwordLookup, summarizeMistakes } from "@/lib/mistakes";
import { AiStatus, ContrastView, ExplainView, MnemonicView, SentenceCheckView } from "./ai-views";
import { useAssistant } from "./use-assistant";

type Tab = "explain" | "sentence" | "mnemonic" | "contrast";
const TABS: { id: Tab; label: string }[] = [
  { id: "explain", label: "讲解" },
  { id: "sentence", label: "造句" },
  { id: "mnemonic", label: "记忆" },
  { id: "contrast", label: "辨析" },
];
const FOCUS = [
  { id: "general", label: "综合" },
  { id: "meaning", label: "词义" },
  { id: "grammar", label: "语法" },
  { id: "collocation", label: "搭配" },
  { id: "exam", label: "考点" },
  { id: "mistakes", label: "我的错误" },
] as const;

/** Words this learner has mixed up with `entry`, then look-alike spellings from the lexicon. */
export function confusableCandidates(entry: LexiconIndexEntry, data: Vocabulary, limit = 6) {
  const lookup = headwordLookup(data.index);
  const found: LexiconIndexEntry[] = [];
  const add = (id: string) => {
    const word = data.byId.get(id);
    if (word && word.id !== entry.id && !found.some((item) => item.id === id)) found.push(word);
  };
  for (const pair of summarizeMistakes(data.history.active, lookup).confusions) {
    if (pair.cardId === entry.id) add(pair.withId);
    else if (pair.withId === entry.id) add(pair.cardId);
  }
  const target = normalizeAnswer(entry.headword);
  if (/^[a-z]{4,}$/.test(target)) {
    for (const word of data.index) {
      if (found.length >= limit) break;
      const other = normalizeAnswer(word.headword);
      if (other === target || !/^[a-z]+$/.test(other) || Math.abs(other.length - target.length) > 2 || other[0] !== target[0]) continue;
      if (editDistance(other, target, 2) <= 2) add(word.id);
    }
  }
  return found.slice(0, limit);
}

export default function WordAi({ entry, data }: { entry: LexiconIndexEntry; data: Vocabulary }) {
  const [tab, setTab] = useState<Tab>("explain");
  const [focus, setFocus] = useState<(typeof FOCUS)[number]["id"]>("general");
  const [sentence, setSentence] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const explain = useAssistant("explain", data);
  const check = useAssistant("check-sentence", data);
  const mnemonic = useAssistant("mnemonic", data);
  const contrast = useAssistant("contrast-words", data);
  const hasMistakes = useMemo(() => data.history.active.some((event) => event.cardId === entry.id && !event.correct), [data.history, entry.id]);
  const candidates = useMemo(() => (tab === "contrast" ? confusableCandidates(entry, data) : []), [tab, entry, data]);
  const explainInput = useMemo(() => ({ wordId: entry.id, focus }), [entry.id, focus]);
  const mnemonicInput = useMemo(() => ({ wordId: entry.id }), [entry.id]);
  const contrastInput = useMemo(() => ({ wordIds: [entry.id, ...picked] }), [entry.id, picked]);
  const { peek: peekExplain } = explain, { peek: peekMnemonic } = mnemonic;
  // Show a saved answer as soon as its tab opens; asking the model always takes a tap.
  useEffect(() => { if (tab === "explain") void peekExplain(explainInput); }, [tab, explainInput, peekExplain]);
  useEffect(() => { if (tab === "mnemonic") void peekMnemonic(mnemonicInput); }, [tab, mnemonicInput, peekMnemonic]);
  const local = sentence.trim() ? localSentenceCheck(sentence, entry.headword) : null;
  const words = data.byId;

  return (
    <section className="word-ai" aria-label="AI 学习助手">
      <div className="ai-tabs" role="tablist" aria-label="AI 功能">
        {TABS.map((item) => (
          <button key={item.id} role="tab" id={`ai-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="ai-panel" onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>
      <div className="ai-panel" role="tabpanel" id="ai-panel" aria-labelledby={`ai-tab-${tab}`}>
        {tab === "explain" && (
          <>
            <div className="ai-chips" role="group" aria-label="讲解重点">
              {FOCUS.filter((item) => item.id !== "mistakes" || hasMistakes).map((item) => (
                <button key={item.id} aria-pressed={focus === item.id} onClick={() => setFocus(item.id)}>{item.label}</button>
              ))}
            </div>
            {explain.state.status === "done" ? (
              <>
                <ExplainView result={explain.state.value.result} words={words} />
                <AiStatus state={explain.state} onRefresh={() => explain.run(explainInput, { refresh: true })} />
              </>
            ) : (
              <>
                <AiStatus state={explain.state} onCancel={explain.cancel} onRetry={() => explain.run(explainInput)} />
                {explain.state.status !== "loading" && (
                  <button className="secondary ai-go" onClick={() => explain.run(explainInput)}>
                    <Sparkles size={16} aria-hidden="true" />生成{FOCUS.find((item) => item.id === focus)?.label}讲解
                  </button>
                )}
              </>
            )}
          </>
        )}
        {tab === "sentence" && (
          <>
            <label className="ai-field">
              <span>用 <strong className="english">{entry.headword}</strong> 写一个句子</span>
              <textarea lang="en" className="english" rows={3} maxLength={600} value={sentence} spellCheck={false}
                onChange={(event) => setSentence(event.target.value)} placeholder="写完先看本机检查，需要时再让 AI 看语法和搭配。" />
            </label>
            {local && <p className="ai-note" data-tone={local.hasTarget && local.completeEnough ? "good" : "maybe"}>{local.message}</p>}
            {check.state.status === "done" && <SentenceCheckView result={check.state.value.result} words={words} />}
            <AiStatus state={check.state} onCancel={check.cancel} onRetry={() => check.run({ wordId: entry.id, sentence })}
              onRefresh={check.state.status === "done" ? () => check.run({ wordId: entry.id, sentence }, { refresh: true }) : undefined} />
            {check.state.status !== "loading" && (
              <button className="secondary ai-go" disabled={sentence.trim().length < 2} onClick={() => check.run({ wordId: entry.id, sentence })}>
                <Sparkles size={16} aria-hidden="true" />AI 检查句子
              </button>
            )}
          </>
        )}
        {tab === "mnemonic" && (
          mnemonic.state.status === "done" ? (
            <>
              <MnemonicView result={mnemonic.state.value.result} words={words} />
              <AiStatus state={mnemonic.state} onRefresh={() => mnemonic.run(mnemonicInput, { refresh: true })} />
            </>
          ) : (
            <>
              <p className="ai-note">按词根词缀拆开，再配一个好记的联想。拆不开的词只给联想。</p>
              <AiStatus state={mnemonic.state} onCancel={mnemonic.cancel} onRetry={() => mnemonic.run(mnemonicInput)} />
              {mnemonic.state.status !== "loading" && <button className="secondary ai-go" onClick={() => mnemonic.run(mnemonicInput)}><Sparkles size={16} aria-hidden="true" />生成记忆方法</button>}
            </>
          )
        )}
        {tab === "contrast" && (
          <>
            <p className="ai-note">选 1–3 个容易和 <span className="english">{entry.headword}</span> 混淆的词。{candidates.length ? "下面是你答错过或拼写相近的词。" : "暂时没有找到相近的词。"}</p>
            <div className="ai-chips" role="group" aria-label="对比的词">
              {candidates.map((word) => (
                <button key={word.id} className="english" aria-pressed={picked.includes(word.id)}
                  onClick={() => setPicked((current) => current.includes(word.id) ? current.filter((id) => id !== word.id) : [...current, word.id].slice(-3))}>
                  {word.headword}<small>{word.chineseCore}</small>
                </button>
              ))}
            </div>
            {contrast.state.status === "done" && <ContrastView result={contrast.state.value.result} words={words} />}
            <AiStatus state={contrast.state} onCancel={contrast.cancel} onRetry={() => contrast.run(contrastInput)}
              onRefresh={contrast.state.status === "done" ? () => contrast.run(contrastInput, { refresh: true }) : undefined} />
            {contrast.state.status !== "loading" && (
              <button className="secondary ai-go" disabled={!picked.length} onClick={() => contrast.run(contrastInput)}><Sparkles size={16} aria-hidden="true" />辨析这 {picked.length + 1} 个词</button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
