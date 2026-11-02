"use client";

import { useEffect, useEffectEvent } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LearnMode } from "@/lib/learn";
import { CoursePicker } from "./shared";
import { StudioSymbol, type SymbolName } from "./symbol";

const ways: Array<{ id: LearnMode; symbol: SymbolName; title: string; detail: string }> = [
  { id: "cards", symbol: "cards", title: "词卡速记", detail: "滑动翻看，先熟悉新词" },
  { id: "match", symbol: "match", title: "配对消除", detail: "把英文和中文配成一对" },
  { id: "quiz", symbol: "quiz", title: "单元自测", detail: "测一遍，找出薄弱词" },
];

export default function VocabularyPractice({ data, bookId, unit, weak, onCourse, onLearn, onMistakes, onBack }: {
  data: Vocabulary; bookId: string; unit: string; weak: number;
  onCourse: (book: string, unit: string) => void;
  onLearn: (mode: LearnMode) => void; onMistakes: () => void; onBack: () => void;
}) {
  const back = useEffectEvent(onBack);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) { target.blur(); return; }
      event.preventDefault();
      back();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="vocabulary-practice">
      <button className="text-button practice-back" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" />返回今日</button>
      <header className="page-heading">
        <div><h1>词汇练习</h1><p>选一种方式，练习当前教材中的词。</p></div>
      </header>
      <section className="current-course" aria-label="练习范围">
        <div className="course-context">
          <StudioSymbol name="lexicon" size={22} />
          <CoursePicker entries={data.index} bookId={bookId} unit={unit} onChange={onCourse} />
        </div>
      </section>
      <div className="practice-grid">
        {ways.map(way => (
          <button key={way.id} className="practice-option" onClick={() => onLearn(way.id)}>
            <StudioSymbol name={way.symbol} size={28} />
            <span><strong>{way.title}</strong><small>{way.detail}</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        ))}
        <button className="practice-option" onClick={onMistakes}>
          <StudioSymbol name="review" size={28} />
          <span><strong>错词重练</strong><small>{weak ? `${weak} 个词待巩固` : "当前范围暂无待巩固词"}</small></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
