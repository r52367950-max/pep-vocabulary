"use client";

import { useMemo } from "react";
import { ChevronRight, Play } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { StudyMode } from "@/lib/study";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import type { LearnMode } from "@/lib/learn";
import { studyStats } from "@/lib/progress";
import { timeOfDay } from "@/lib/art";
import { CoursePicker } from "./shared";
import { StudioSymbol, type SymbolName } from "./symbol";
import { Artwork, useDarkAppearance } from "./art";

const ways: Array<{ id: LearnMode | "dictation"; symbol: SymbolName; title: string; detail: string }> = [
  { id: "cards", symbol: "cards", title: "词卡速记", detail: "滑动翻看，先熟悉新词" },
  { id: "match", symbol: "match", title: "配对消除", detail: "英文和中文，一对一对消掉" },
  { id: "quiz", symbol: "quiz", title: "单元自测", detail: "测一遍，找出薄弱词" },
  { id: "dictation", symbol: "listen", title: "单词听写", detail: "听发音，写单词" },
];

export default function Today({ data, bookId, unit, onCourse, due, newCount, weak, total, learned, queue, onStart, onLearn, onWords, onReading, onActivity, resume, resumeLabel }: {
  data: Vocabulary; bookId: string; unit: string; onCourse: (book: string, unit: string) => void;
  due: number; newCount: number; weak: number; total: number; learned: number;
  queue: LexiconIndexEntry[]; onStart: (mode: StudyMode) => void; onLearn: (mode: LearnMode) => void; onWords: () => void;
  onReading: () => void; onActivity: () => void; resume: (() => void) | null; resumeLabel: string | null;
}) {
  const stats = useMemo(() => studyStats(data.events), [data.events]);
  const dark = useDarkAppearance(data.settings.theme);
  const minutes = queue.length ? Math.max(1, Math.ceil(queue.length * 0.7)) : 0;
  const date = new Date();
  const day = date.toLocaleDateString("sv-SE");
  const finished = !resume && !queue.length;
  const time = dark ? "night" : timeOfDay(date);
  return (
    <div className="today-view">
      <header className="page-heading today-heading">
        <h1>今日学习</h1>
        <time dateTime={day}>
          {date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
        </time>
      </header>
      <section className="current-course" aria-label="当前教材与进度">
        <div className="course-context">
          <StudioSymbol name="lexicon" size={22} />
          <CoursePicker entries={data.index} bookId={bookId} unit={unit} onChange={onCourse} />
        </div>
        <button className="course-progress" onClick={onWords} aria-label={`查看词库，已学习 ${learned} / ${total} 词`}>
          <span>已学 {learned} / {total} 词 <ChevronRight size={14} aria-hidden="true" /></span>
          <progress value={learned} max={Math.max(1, total)} aria-label="教材学习进度" />
        </button>
      </section>
      <section className="daily-feature" data-time={time} aria-labelledby="daily-title">
        <Artwork kind="shanshui" seed={day} time={time} className="today-artwork" eager />
        <div className="daily-feature-copy">
          <h2 id="daily-title">{resume ? "接着上次学" : queue.length ? `今天学 ${queue.length} 个词` : "今日计划已完成"}</h2>
          <p>{resume ? resumeLabel : queue.length ? `复习 ${Math.min(due, queue.length)} 词，学习 ${newCount} 个新词。` : "可以去词库挑些单词，继续练习。"}</p>
          <div className="feature-action">
            {finished
              ? <button className="primary" onClick={onWords}>去词库选词</button>
              : <button className="primary" onClick={resume ?? (() => onStart("daily"))}>
                  <Play size={14} fill="currentColor" style={{ strokeWidth: 0 }} aria-hidden="true" />
                  {resume ? "继续学习" : "开始学习"}
                </button>}
            {!resume && minutes > 0 && <span>约 {minutes} 分钟</span>}
          </div>
          {resume && queue.length > 0 && <button className="fresh-plan" onClick={() => onStart("daily")}>开始今日计划<ChevronRight size={14} aria-hidden="true" /></button>}
        </div>
      </section>
      <section className="practice-section" aria-labelledby="practice-title">
        <div className="section-heading"><h2 id="practice-title">记单词</h2></div>
        <div className="practice-grid">
          {ways.map((way) => (
            <button key={way.id} className="practice-option" onClick={() => way.id === "dictation" ? onStart("dictation") : onLearn(way.id)}>
              <StudioSymbol name={way.symbol} size={28} />
              <span><strong>{way.title}</strong><small>{way.detail}</small></span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
      <div className="today-footnotes">
        <button onClick={() => onStart("mistakes")}>
          <StudioSymbol name="review" size={24} />
          <span><strong>错词重练</strong><small>{weak ? `${weak} 个词待巩固` : "暂无待巩固词"}</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button onClick={onReading}>
          <StudioSymbol name="reading" size={24} />
          <span><strong>阅读</strong><small>在文章里遇见学过的词</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button onClick={onActivity}>
          <StudioSymbol name="activity" size={24} />
          <span><strong>学习记录</strong><small>{stats.streak ? `连续 ${stats.streak} 天，今日已学 ${stats.todayWords} 词` : `今日已学 ${stats.todayWords} 词`}</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
