"use client";

import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Headphones,
  Leaf,
  PenLine,
  RotateCcw,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { BOOKS, type StudyMode } from "@/lib/study";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { studyStats } from "@/lib/progress";
import { CoursePicker, Pronounce } from "./shared";

export default function Today({
  data,
  bookId,
  unit,
  onCourse,
  due,
  newCount,
  weak,
  total,
  learned,
  queue,
  onStart,
  onWords,
  onReading,
  resume,
}: {
  data: Vocabulary;
  bookId: string;
  unit: string;
  onCourse: (book: string, unit: string) => void;
  due: number;
  newCount: number;
  weak: number;
  total: number;
  learned: number;
  queue: LexiconIndexEntry[];
  onStart: (mode: StudyMode) => void;
  onWords: () => void;
  onReading: () => void;
  resume: (() => void) | null;
}) {
  const stats = studyStats(data.events);
  const book = BOOKS.find((b) => b.id === bookId);
  const featured =
    queue[0] ||
    data.index.find((e) => e.headword === "curiosity") ||
    data.index[0];
  const goal = Math.max(1, stats.todayWords + queue.length);
  const progress = Math.min(100, Math.round((stats.todayWords / goal) * 100));
  return (
    <div className="today-view">
      <div className="page-heading">
        <div>
          <p>
            {new Date().toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </p>
          <h1>今天，继续积累。</h1>
        </div>
        <span className="quiet-badge">
          <Leaf size={16} />
          {stats.streak
            ? `已连续学习 ${stats.streak} 天`
            : "每天一点，慢慢记住"}
        </span>
      </div>
      {resume && (
        <div className="resume-banner">
          <span>上一轮还没有完成，已保留学习位置。</span>
          <button className="text-button" onClick={resume}>
            继续上一轮 <ChevronRight size={16} />
          </button>
        </div>
      )}
      <div className="today-top">
        <section className="daily-card">
          <div className="daily-copy">
            <span className="pill">
              <BookOpen size={14} />
              {book?.label || "教材词汇"}
            </span>
            <h2>
              从记住一个词，
              <br />
              到读懂一句话。
            </h2>
            <p>先复习，再学新词。按照你的记忆安排。</p>
            <div className="daily-counts">
              <span>
                <strong>{Math.min(due, queue.length)}</strong>待复习
              </span>
              <i />
              <span>
                <strong>{newCount}</strong>新词
              </span>
              <i />
              <span>
                <strong>
                  {queue.length
                    ? Math.max(1, Math.ceil(queue.length * 0.7))
                    : 0}
                  <small> 分钟</small>
                </strong>
                预计用时
              </span>
            </div>
            <button
              className="primary"
              disabled={!queue.length}
              onClick={() => onStart("daily")}
            >
              {queue.length ? "开始今日学习" : "本轮计划已完成"}
              <ChevronRight size={19} />
            </button>
          </div>
          <div className="word-leaf">
            <span className="paper-tab" />
            <div className="paper-rule" />
            <small>今日词页</small>
            <div className="serif featured-word">{featured?.headword}</div>
            <p className="ipa">
              {featured?.britishIpa ? `/${featured.britishIpa}/` : ""}
            </p>
            <div className="paper-line" />
            <p className="featured-meaning">{featured?.chineseCore}</p>
            {featured && (
              <Pronounce text={featured.headword} notify={data.notify} />
            )}
            <span className="paper-footer">每一次回忆，都算数。</span>
          </div>
        </section>
        <section className="today-progress">
          <div className="section-heading">
            <h2>今日足迹</h2>
            <span>本机记录</span>
          </div>
          <div
            className="progress-circle"
            role="img"
            aria-label={`今日已学习 ${stats.todayWords} 词`}
            style={{ "--progress": `${progress}%` } as React.CSSProperties}
          >
            <div>
              <strong>{stats.todayWords}</strong>
              <span>已学习词数</span>
            </div>
          </div>
          <div className="progress-detail">
            <span>
              <Clock3 size={15} />
              {stats.todayMinutes} 分钟
            </span>
            <span>
              <Check size={15} />
              {stats.accuracy === null ? "尚未作答" : `${stats.accuracy}% 正确`}
            </span>
          </div>
          <p>完成适合今天的量，就很好。</p>
        </section>
      </div>
      <div className="practice-heading section-heading">
        <h2>换一种方式，记得更清楚</h2>
        <span>与你的教材同步</span>
      </div>
      <div className="practice-grid">
        <button className="practice-card" onClick={() => onStart("dictation")}>
          <span className="practice-icon blue">
            <Headphones size={24} />
          </span>
          <div>
            <h3>单词听写</h3>
            <p>听发音，独立写出完整拼写</p>
          </div>
          <ArrowUpRight size={18} />
        </button>
        <button className="practice-card" onClick={() => onStart("mistakes")}>
          <span className="practice-icon amber">
            <RotateCcw size={23} />
          </span>
          <div>
            <h3>
              错词重练 <small>{weak}</small>
            </h3>
            <p>
              {weak ? "重新回忆，看看这次记住了多少" : "暂无待巩固词，继续保持"}
            </p>
          </div>
          <ArrowUpRight size={18} />
        </button>
        <button className="practice-card" onClick={onReading}>
          <span className="practice-icon green">
            <PenLine size={23} />
          </span>
          <div>
            <h3>在短文中学习</h3>
            <p>读一点英语，让词汇有上下文</p>
          </div>
          <ArrowUpRight size={18} />
        </button>
      </div>
      <section className="course-section">
        <div className="section-heading">
          <h2>我的教材</h2>
          <button className="text-button" onClick={onWords}>
            浏览词表 <ChevronRight size={16} />
          </button>
        </div>
        <div className="course-body">
          <div className="book-cover">
            <BookOpen size={25} />
            <span>英语</span>
            <strong>{book?.shortLabel}</strong>
            <small>人教版</small>
          </div>
          <div className="course-info">
            <CoursePicker
              entries={data.index}
              bookId={bookId}
              unit={unit}
              onChange={onCourse}
            />
            <div className="course-progress-copy">
              <span>
                {unit === "all" ? "当前教材" : unit} · {total} 词
              </span>
              <span>已接触 {learned} 词</span>
            </div>
            <div
              className="linear-progress"
              role="progressbar"
              aria-label="教材学习进度"
              aria-valuenow={learned}
              aria-valuemin={0}
              aria-valuemax={Math.max(1, total)}
            >
              <span
                style={{ width: `${(learned / Math.max(1, total)) * 100}%` }}
              />
            </div>
          </div>
          <button className="secondary" onClick={() => onStart("context")}>
            语境练习 <ChevronRight size={17} />
          </button>
        </div>
      </section>
    </div>
  );
}
