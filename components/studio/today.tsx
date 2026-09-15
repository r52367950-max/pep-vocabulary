"use client";

import { ChevronRight, Play } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { StudyMode } from "@/lib/study";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { studyStats } from "@/lib/progress";
import { CoursePicker } from "./shared";
import { StudioSymbol } from "./symbol";

export default function Today({ data, bookId, unit, onCourse, due, newCount, weak, total, learned, queue, onStart, onWords, onReading, onActivity, resume, resumeLabel }: {
  data: Vocabulary; bookId: string; unit: string; onCourse: (book: string, unit: string) => void;
  due: number; newCount: number; weak: number; total: number; learned: number;
  queue: LexiconIndexEntry[]; onStart: (mode: StudyMode) => void; onWords: () => void;
  onReading: () => void; onActivity: () => void; resume: (() => void) | null; resumeLabel: string | null;
}) {
  const stats = studyStats(data.events);
  const minutes = queue.length ? Math.max(1, Math.ceil(queue.length * 0.7)) : 0;
  const date = new Date();
  return (
    <div className="today-view">
      <header className="page-heading today-heading">
        <h1>今日学习</h1>
        <time dateTime={date.toLocaleDateString("sv-SE")}>
          {date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
        </time>
      </header>
      <section className="current-course" aria-label="当前教材与进度">
        <div className="course-context">
          <StudioSymbol name="lexicon" tile size={22} />
          <CoursePicker entries={data.index} bookId={bookId} unit={unit} onChange={onCourse} />
        </div>
        <button className="course-progress" onClick={onWords} aria-label={`查看词库，已学习 ${learned} / ${total} 词`}>
          <span>已学 {learned} / {total} 词 <ChevronRight size={14} aria-hidden="true" /></span>
          <progress value={learned} max={Math.max(1, total)} aria-label="教材学习进度" />
        </button>
      </section>
      <section className="daily-feature" aria-labelledby="daily-title">
        {/* eslint-disable-next-line @next/next/no-img-element -- Local artwork with reserved intrinsic dimensions. */}
        <img className="daily-art" src="/images/daily-book.webp" alt="" width={1536} height={1024} fetchPriority="high" />
        <div className="daily-feature-copy">
          <span className="lesson-label"><StudioSymbol name="today" size={20} />今日计划</span>
          <h2 id="daily-title">{resume ? "继续学习" : queue.length ? `今天学 ${queue.length} 个词` : "今日计划已完成"}</h2>
          <p>{resume ? resumeLabel : queue.length ? `复习 ${Math.min(due, queue.length)} 词，学习 ${newCount} 个新词。` : "可以在词库中选择单词，继续练习。"}</p>
          <div className="feature-action">
            <button className="primary" disabled={!resume && !queue.length} onClick={resume ?? (() => onStart("daily"))}>
              <Play size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              {resume ? "继续学习" : queue.length ? "开始学习" : "已完成"}
            </button>
            {!resume && minutes > 0 && <span>约 {minutes} 分钟</span>}
          </div>
          {resume && queue.length > 0 && <button className="fresh-plan" onClick={() => onStart("daily")}>开始今日计划<ChevronRight size={14} aria-hidden="true" /></button>}
        </div>
      </section>
      <section className="practice-section" aria-labelledby="practice-title">
        <div className="section-heading"><h2 id="practice-title">专项练习</h2></div>
        <div className="practice-grid">
          <button className="practice-option" onClick={() => onStart("dictation")}>
            <StudioSymbol name="listen" tile size={27} />
            <span><strong>单词听写</strong><small>听发音，写单词</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
          <button className="practice-option" onClick={onReading}>
            <StudioSymbol name="reading" tile size={27} />
            <span><strong>短文阅读</strong><small>阅读短文，理解词义</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </section>
      <div className="today-footnotes">
        <button onClick={() => onStart("mistakes")}>
          <StudioSymbol name="review" size={24} />
          <span><strong>错词复习</strong><small>{weak ? `${weak} 个词待巩固` : "暂无待巩固词"}</small></span>
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
