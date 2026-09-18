"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, EyeOff, Shuffle } from "lucide-react";
import { loadDetails, type LexiconDetail, type LexiconIndexEntry } from "@/lib/lexicon";
import { getEntryExample } from "@/lib/questions";
import { hasTextbookOrder, orderStudyEntries, type StudyOrder } from "@/lib/study-order";
import { Pronounce, sourceLabel } from "./shared";
import { StudyOrderPicker } from "./study-order";

export default function Memorize({ entries, bookId, unit, initialOrder, onOrder, notify, onExit, onPractice }: {
  entries: LexiconIndexEntry[]; bookId: string; unit: string; initialOrder: StudyOrder;
  onOrder: (order: StudyOrder) => void; notify: (message: string) => void; onExit: () => void;
  onPractice: (mode: "daily" | "dictation", entries: LexiconIndexEntry[]) => void;
}) {
  const [words, setWords] = useState(entries);
  const [position, setPosition] = useState(0);
  const [order, setOrder] = useState(initialOrder);
  const [selfTest, setSelfTest] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [details, setDetails] = useState(new Map<string, LexiconDetail>());
  const [detailError, setDetailError] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const entry = words[position];
  const currentSource = entry.sources.find(source => source.bookId === bookId && (unit === "all" || source.unit === unit));
  const textbookAvailable = hasTextbookOrder(words, bookId, unit);
  const showMeaning = !selfTest || revealed;
  const example = getEntryExample(entry, details.get(entry.id));
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    let active = true;
    loadDetails(entries.map(word => word.id)).then(rows => {
      if (active) setDetails(new Map(rows.map(row => [row.id, row])));
    }).catch(() => { if (active) setDetailError(true); });
    return () => {
      active = false;
      window.speechSynthesis?.cancel();
    };
  }, [entries]);
  const move = (next: number) => {
    window.speechSynthesis?.cancel();
    setPosition(next);
    setRevealed(false);
  };
  const reorder = (next: StudyOrder) => {
    setOrder(next);
    onOrder(next);
    setWords(orderStudyEntries(words, next, bookId, unit));
    move(0);
  };
  return (
    <main className="memorize-view">
      <header className="memorize-header">
        <button className="icon-button" onClick={onExit} aria-label="退出背诵"><ArrowLeft size={21} /></button>
        <h1>背单词</h1>
        <span>{position + 1} / {words.length}</span>
      </header>
      <progress className="memorize-progress" value={position + 1} max={words.length} aria-label="当前背诵位置" />
      <div className="memorize-toolbar">
        <StudyOrderPicker value={order} textbookAvailable={textbookAvailable} onChange={reorder} />
        <button className="text-button" onClick={() => reorder("random")}><Shuffle size={16} />重新打乱</button>
      </div>
      <article className="memorize-word" aria-labelledby="memorize-title">
        <p className="memorize-source">{currentSource ? `${currentSource.volume} · ${currentSource.unit}` : sourceLabel(entry)}</p>
        <div className="memorize-headword">
          <h2 id="memorize-title" ref={title} tabIndex={-1} lang="en">{entry.headword}</h2>
          <Pronounce text={entry.headword} notify={notify} />
        </div>
        <p className="memorize-ipa">{entry.britishIpa && `英 /${entry.britishIpa}/`}{entry.americanIpa && <span>美 /{entry.americanIpa}/</span>}</p>
        <button className="text-button memorize-selftest" aria-pressed={selfTest} onClick={() => { setSelfTest(!selfTest); setRevealed(false); }}>
          {selfTest ? <EyeOff size={16} /> : <Eye size={16} />}隐藏释义自测
        </button>
        <div className="memorize-definition">
          {showMeaning ? <>
            <p className="memorize-meaning"><small>{entry.partsOfSpeech.join(" / ")}</small>{entry.chineseCore}</p>
            {example && <div className="memorize-example"><p lang="en">{example.en}</p>{example.zh && <p>{example.zh}</p>}<small>{example.source}</small></div>}
            {detailError && <p className="memorize-detail-note">例句暂时未能载入，可继续背诵。</p>}
          </> : <button className="secondary reveal-meaning" onClick={() => setRevealed(true)}><Eye size={17} />显示释义</button>}
        </div>
      </article>
      <nav className="memorize-navigation" aria-label="翻看单词">
        <button className="secondary" disabled={position === 0} onClick={() => move(position - 1)}><ChevronLeft size={18} />上一个</button>
        <span aria-live="polite">{position === words.length - 1 ? "已到最后一个词" : `还有 ${words.length - position - 1} 个词`}</span>
        <button className="secondary" disabled={position === words.length - 1} onClick={() => move(position + 1)}>下一个<ChevronRight size={18} /></button>
      </nav>
      <footer className="memorize-footer">
        <p>用这 {words.length} 个词练一练</p>
        <div><button className="secondary" onClick={() => onPractice("dictation", words)}>开始听写</button><button className="primary" onClick={() => onPractice("daily", words)}>开始练习<ChevronRight size={16} /></button></div>
      </footer>
    </main>
  );
}
