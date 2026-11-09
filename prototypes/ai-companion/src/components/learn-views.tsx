import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { StudioSymbol } from "@/components/studio/symbol";
import { dayLabel, LEXICON, SAMPLE_ATTEMPTS, SAMPLE_LABEL, sourceLabel, wordById, WEEKDAYS } from "../data";
import { itemFromWord, MISTAKE_TITLE, sampleStatus, scopeItems, scoreAnswer } from "../practice";
import { useStore } from "../store";

export function TodayView() {
  const { setView, startPractice, state } = useStore();
  const status = sampleStatus();
  const now = new Date();
  const items = scopeItems(state.settings.defaultScope).slice(0, 8);
  return (
    <div className="page today-page">
      <header className="page-head split">
        <div><h1>今日学习</h1><p className="page-sub">高中 · 必修第一册 · Unit 4</p></div>
        <p className="date">{now.getMonth() + 1}月{now.getDate()}日 星期{WEEKDAYS[now.getDay()]}</p>
      </header>
      <section className="today-lead" aria-label="今天">
        <div>
          <p className="sample-tag">{SAMPLE_LABEL}</p>
          <h2>今天复习 {status.due} 词，重练 {status.openMistakes} 个错词</h2>
          <p className="page-sub">每天 {state.settings.dailyMinutes} 分钟</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => startPractice(items, `${items.length} 词听写`, "今日学习", "page")}>开始今天的听写</button>
      </section>
      <h2 className="section-title">自主练习</h2>
      <ul className="entry-list">
        <li><button type="button" onClick={() => startPractice(items, `${items.length} 词听写`, "今日学习", "page")}><StudioSymbol name="listen" size={22} /><span className="entry-text"><strong>单词听写</strong><small>听音拼写，程序判分，只重练错项</small></span><ChevronRight size={18} aria-hidden="true" /></button></li>
        <li><button type="button" onClick={() => setView("reading")}><StudioSymbol name="reading" size={22} /><span className="entry-text"><strong>阅读</strong><small>Mangrove Forests · 选中原文即可提问</small></span><ChevronRight size={18} aria-hidden="true" /></button></li>
        <li><button type="button" onClick={() => setView("records")}><StudioSymbol name="activity" size={22} /><span className="entry-text"><strong>学习记录</strong><small>按练习表现查看本周状态</small></span><ChevronRight size={18} aria-hidden="true" /></button></li>
      </ul>
    </div>
  );
}

export function WordsView() {
  const [query, setQuery] = useState("");
  const words = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pool = LEXICON.filter((word) => word.headword.length > 3 && /^[a-z-]+$/i.test(word.headword));
    return term ? pool.filter((word) => word.headword.toLowerCase().includes(term) || word.chineseCore.includes(term)) : pool;
  }, [query]);
  return (
    <div className="page words-page">
      <header className="page-head"><h1>词库</h1><p className="page-sub">{LEXICON.length} 个词条</p></header>
      <label className="search-field wide">
        <Search size={17} aria-hidden="true" />
        <input type="search" value={query} placeholder="搜索单词或中文释义" aria-label="搜索词库" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className="word-table">
        {words.slice(0, 80).map((word) => (
          <li key={word.id}>
            <strong>{word.headword}</strong>
            {word.ipa && <span className="ipa">/{word.ipa}/</span>}
            <span className="word-zh">{word.chineseCore}</span>
            <span className="word-src">{sourceLabel(word)}</span>
          </li>
        ))}
      </ul>
      {words.length === 0 && <p className="empty-note">没有匹配的词。</p>}
    </div>
  );
}

export function RecordsView() {
  const status = sampleStatus();
  const byDay = new Map<number, { total: number; correct: number }>();
  for (const attempt of SAMPLE_ATTEMPTS) {
    const word = wordById(attempt.wordId)!;
    const row = byDay.get(attempt.daysAgo) ?? { total: 0, correct: 0 };
    row.total += 1;
    if (scoreAnswer(itemFromWord(word), attempt.answer).correct) row.correct += 1;
    byDay.set(attempt.daysAgo, row);
  }
  const max = Math.max(...[...byDay.values()].map((row) => row.total));
  return (
    <div className="page records-page">
      <header className="page-head"><h1>学习记录</h1><p className="sample-tag">{SAMPLE_LABEL}</p></header>
      <section className="records-week" aria-label="最近 7 天">
        <h2 className="section-title">最近 7 天</h2>
        <ol className="week-bars">
          {[6, 5, 4, 3, 2, 1, 0].map((daysAgo) => {
            const row = byDay.get(daysAgo);
            return (
              <li key={daysAgo}>
                <span className="bar-track" aria-hidden="true">
                  <span className="bar-total" style={{ height: `${row ? (row.total / max) * 100 : 0}%` }}><span className="bar-correct" style={{ height: `${row ? (row.correct / row.total) * 100 : 0}%` }} /></span>
                </span>
                <span className="bar-label">{daysAgo === 0 ? "今天" : dayLabel(daysAgo)}</span>
                <span className="bar-value">{row ? `${row.correct}/${row.total}` : "—"}</span>
              </li>
            );
          })}
        </ol>
      </section>
      <section aria-label="最近的作答">
        <h2 className="section-title">最近写错的词</h2>
        <ul className="attempt-list">
          {SAMPLE_ATTEMPTS.filter((attempt) => !scoreAnswer(itemFromWord(wordById(attempt.wordId)!), attempt.answer).correct).sort((a, b) => a.daysAgo - b.daysAgo).map((attempt, index) => {
            const word = wordById(attempt.wordId)!;
            const score = scoreAnswer(itemFromWord(word), attempt.answer);
            return (
              <li key={index}>
                <span className="when">{attempt.daysAgo === 0 ? "今天" : dayLabel(attempt.daysAgo)}</span>
                <span><span className="wrong">{attempt.answer || "（空）"}</span> → <strong>{word.headword}</strong></span>
                <span className="kind">{score.kind ? MISTAKE_TITLE[score.kind] : ""}</span>
              </li>
            );
          })}
        </ul>
        <p className="page-note">共 {status.dictationTotal + status.reviewTotal} 次作答，听写 {status.dictationCorrect}/{status.dictationTotal}，复习 {status.reviewCorrect}/{status.reviewTotal}。</p>
      </section>
    </div>
  );
}
