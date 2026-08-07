"use client";

import { BookOpen, Brain, ChevronRight, Play, Search, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import { speakSystem, type LexiconIndexEntry } from "@/lib/lexicon";
import type { AppSettings, StoredCard } from "@/lib/storage";

const books = [
  ["HS-R1", "必修一"], ["HS-R2", "必修二"], ["HS-R3", "必修三"],
  ["HS-S1", "选必一"], ["HS-S2", "选必二"], ["HS-S3", "选必三"], ["HS-S4", "选必四"],
  ["JH-7A", "七上"], ["JH-7B", "七下"], ["JH-8A", "八上"], ["JH-8B", "八下"], ["JH-9", "九年级"],
] as const;

const stateLabel = (card?: StoredCard) => card?.status === "weak" ? "薄弱" : card?.status === "mastered" ? "已掌握" : card?.lastReviewed ? "学习中" : "未学";
const sourceOrder = (entry: LexiconIndexEntry, bookId: string, unit: string) => {
  const source = entry.sources.find((item) => item.bookId === bookId && item.unit === unit);
  const sourceSequence = Number(source?.recordId?.split(":").at(-1)) || 9999;
  return `${String(source?.printedPage || 9999).padStart(4, "0")}-${String(sourceSequence).padStart(5, "0")}-${entry.headword}`;
};

export default function ConsoleLearnHub({ index, cards, settings, weakMemory, onUpdate, onMemorize, onReview, onOpenEntry }: {
  index: LexiconIndexEntry[];
  cards: Map<string, StoredCard>;
  settings: AppSettings;
  weakMemory: LexiconIndexEntry[];
  onUpdate: (patch: Partial<AppSettings>) => void;
  onMemorize: (entries: LexiconIndexEntry[]) => void;
  onReview: (entries: LexiconIndexEntry[]) => void;
  onOpenEntry: (entry: LexiconIndexEntry) => void;
}) {
  const [memoryQuery, setMemoryQuery] = useState("");
  const units = useMemo(() => [...new Set(index.flatMap((entry) => entry.sources.filter((source) => source.bookId === settings.unitBook).map((source) => source.unit)))].sort((a, b) => Number(a.match(/\d+/)?.[0] || 999) - Number(b.match(/\d+/)?.[0] || 999) || a.localeCompare(b)), [index, settings.unitBook]);
  const activeUnit = units.includes(settings.unit) ? settings.unit : units[0] || "Unit 1";
  const unitEntries = useMemo(() => index.filter((entry) => entry.sources.some((source) => source.bookId === settings.unitBook && source.unit === activeUnit)).sort((a, b) => sourceOrder(a, settings.unitBook, activeUnit).localeCompare(sourceOrder(b, settings.unitBook, activeUnit))), [index, settings.unitBook, activeUnit]);
  const unseen = unitEntries.filter((entry) => !cards.get(entry.id)?.lastReviewed);
  const learned = unitEntries.filter((entry) => cards.get(entry.id)?.lastReviewed);
  const weak = unitEntries.filter((entry) => cards.get(entry.id)?.status === "weak");
  const visibleMemory = weakMemory.filter((entry) => !memoryQuery.trim() || `${entry.headword} ${entry.chineseCore}`.toLowerCase().includes(memoryQuery.trim().toLowerCase()));
  const chooseBook = (bookId: string) => {
    const nextUnits = [...new Set(index.flatMap((entry) => entry.sources.filter((source) => source.bookId === bookId).map((source) => source.unit)))].sort((a, b) => Number(a.match(/\d+/)?.[0] || 999) - Number(b.match(/\d+/)?.[0] || 999));
    onUpdate({ mode: "unit", unitBook: bookId, unit: nextUnits[0] || "Unit 1", selectedBooks: settings.selectedBooks.includes(bookId) ? settings.selectedBooks : [...settings.selectedBooks, bookId] });
  };

  return <div className="learn-console">
    <header className="learn-title"><div><span className="console-kicker">LEARN BEFORE TEST</span><h1>先学会，再进入复习。</h1><p>新词先看词形、读音、核心义和语境，再做提取、拼写、产出与延迟回忆。</p></div><Brain size={30}/></header>

    <section className="unit-learning-board">
      <div className="unit-selector-block"><span className="console-kicker">按教材单元学习</span><div className="unit-selectors"><label><span>册次</span><select value={settings.unitBook} onChange={(event) => chooseBook(event.target.value)}>{books.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label><span>单元</span><select value={activeUnit} onChange={(event) => onUpdate({ mode: "unit", unit: event.target.value })}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label></div><p>顺序依据教材位置，不再按 A、B、C、D 字母分组。</p></div>
      <div className="unit-stat-grid"><div><strong>{unitEntries.length}</strong><span>本单元全部（含专名）</span></div><div><strong>{unseen.length}</strong><span>尚未学习</span></div><div><strong>{learned.length}</strong><span>已进入复习</span></div><div className={weak.length ? "danger" : ""}><strong>{weak.length}</strong><span>当前薄弱</span></div></div>
      <div className="unit-actions"><button className="console-primary" onClick={() => onMemorize(unitEntries)} disabled={!unseen.length}><BookOpen size={17}/>学习下一组新词</button><button className="console-secondary" onClick={() => onReview(learned.length ? learned : unitEntries)} disabled={!unitEntries.length}><Play size={16}/>复习本单元</button><small>每组最多 8 个；完成后可继续下一组，进度自动保存。</small></div>
    </section>

    <section className="unit-word-section"><header><div><span className="console-kicker">UNIT WORDS · ALL</span><h2>{books.find(([id]) => id === settings.unitBook)?.[1]} · {activeUnit}</h2></div><span>完整显示 {unitEntries.length} 词</span></header><div className="unit-word-table"><div className="unit-word-head"><span>词语</span><span>核心义</span><span>教材位置</span><span>状态</span><span/></div>{unitEntries.map((entry) => { const card = cards.get(entry.id); const source = entry.sources.find((item) => item.bookId === settings.unitBook && item.unit === activeUnit); return <div className={`unit-word-row${entry.flags.properName ? " proper-name" : ""}`} key={entry.id}><button className="unit-word-name" onClick={() => onOpenEntry(entry)}><strong>{entry.headword}</strong><small>{entry.britishIpa ? `/${entry.britishIpa}/` : "IPA 待核"}</small></button><span>{entry.chineseCore}</span><small>{source?.printedPage ? `p.${source.printedPage}` : activeUnit}</small><em data-status={card?.status || "unseen"}>{stateLabel(card)}</em><button className="unit-audio" onClick={() => speakSystem(entry.headword)} aria-label={`播放 ${entry.headword} 的系统语音`}><Volume2 size={15}/></button></div>; })}</div></section>

    <section className="memory-board"><header><div><span className="console-kicker">LOCAL MEMORY · TOP 100</span><h2>我的薄弱词记忆</h2><p>按六项能力、错题次数、FSRS 难度和逾期程度排序，保存在本机并随私有备份同步。</p></div><button className="console-secondary" onClick={() => onReview(visibleMemory.slice(0, 20))} disabled={!visibleMemory.length}>练前 20 个<ChevronRight size={15}/></button></header><label className="memory-search"><Search size={16}/><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="在薄弱 100 词中中英双语搜索"/></label><div className="memory-word-grid">{visibleMemory.map((entry, indexValue) => { const card = cards.get(entry.id); const weakest = card ? Math.round(Math.min(...Object.values(card.skills)) * 100) : 0; return <button key={entry.id} onClick={() => onOpenEntry(entry)}><span>{String(indexValue + 1).padStart(2, "0")}</span><div><strong>{entry.headword}</strong><small>{entry.chineseCore}</small></div><em>{weakest}</em></button>; })}{!visibleMemory.length && <p>完成一些练习后，这里会出现最值得优先复习的词。</p>}</div></section>
  </div>;
}
