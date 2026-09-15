"use client";

import {
  BookOpen,
  ChevronRight,
  Headphones,
  Play,
  RotateCcw,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { StudyMode } from "@/lib/study";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { studyStats } from "@/lib/progress";
import { CoursePicker } from "./shared";

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
  onActivity,
  resume,
  resumeLabel,
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
  onActivity: () => void;
  resume: (() => void) | null;
  resumeLabel: string | null;
}) {
  const stats = studyStats(data.events);
  const minutes = queue.length ? Math.max(1, Math.ceil(queue.length * 0.7)) : 0;
  return (
    <div className="today-view">
      <header className="page-heading today-heading">
        <div>
          <p>为每一次进步</p>
          <h1>今天</h1>
        </div>
        <time dateTime={new Date().toISOString().slice(0, 10)}>
          {new Date().toLocaleDateString("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
          })}
        </time>
      </header>
      <section className="daily-feature" aria-labelledby="daily-title">
        {/* eslint-disable-next-line @next/next/no-img-element -- Local WebP; layout and intrinsic size are specified. */}
        <img
          className="daily-art"
          src="/images/daily-book.webp"
          alt="蓝色封面的书，轻盈展开的白色书页"
          width={1536}
          height={1024}
          fetchPriority="high"
        />
        <div className="daily-feature-copy">
          <span className="feature-kicker">每日词汇 · DAILY PRACTICE</span>
          <h2 id="daily-title">
            从认识，
            <br />
            到自然表达。
          </h2>
          <p>
            一个词，一句话。
            <br />
            让学过的英语，成为自己的语言。
          </p>
          <div className="feature-action">
            <button
              className="primary"
              disabled={!resume && !queue.length}
              onClick={resume ?? (() => onStart("daily"))}
            >
              <Play size={16} fill="currentColor" strokeWidth={0} />
              {resume
                ? "继续上一轮"
                : queue.length
                  ? "开始学习"
                  : "今日计划已完成"}
            </button>
            <span>
              {resume
                ? resumeLabel
                : `${minutes} 分钟 · ${Math.min(due, queue.length)} 复习 · ${newCount} 新词`}
            </span>
          </div>
          {resume && queue.length > 0 && (
            <button className="fresh-plan" onClick={() => onStart("daily")}>
              开始新的今日计划 <ChevronRight size={13} />
            </button>
          )}
        </div>
      </section>
      <section className="current-course" aria-label="当前教材与进度">
        <div className="course-context">
          <BookOpen size={20} />
          <CoursePicker
            entries={data.index}
            bookId={bookId}
            unit={unit}
            onChange={onCourse}
          />
        </div>
        <button className="course-progress" onClick={onWords}>
          <span>
            已学习 {learned} / {total} 词 <ChevronRight size={15} />
          </span>
          <progress
            value={learned}
            max={Math.max(1, total)}
            aria-label="教材学习进度"
          />
        </button>
      </section>
      <section className="discovery-section" aria-labelledby="discovery-title">
        <div className="section-heading">
          <h2 id="discovery-title">换一种方式，也会记得</h2>
          <span>听见 · 理解 · 运用</span>
        </div>
        <div className="discovery-grid">
          <button
            className="discovery-card listening-card"
            onClick={() => onStart("dictation")}
          >
            <span className="discovery-copy">
              <span className="discovery-label">
                <Headphones size={16} />
                单词听写
              </span>
              <strong>
                听得懂，
                <br />
                也写得出。
              </strong>
              <span className="discovery-description">让声音和拼写相遇</span>
              <span className="discovery-link">
                开始听写 <ChevronRight size={16} />
              </span>
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- Local, encoded content artwork. */}
            <img
              src="/images/reading-conversation.webp"
              alt=""
              width={1536}
              height={1024}
              loading="lazy"
              decoding="async"
            />
          </button>
          <button className="discovery-card stories-card" onClick={onReading}>
            <span className="discovery-copy">
              <span className="discovery-label">
                <BookOpen size={16} />
                语境阅读
              </span>
              <strong>
                在故事里，
                <br />
                遇见单词。
              </strong>
              <span className="discovery-description">从词义走向真实语境</span>
              <span className="discovery-link">
                探索短文 <ChevronRight size={16} />
              </span>
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- Local, encoded content artwork. */}
            <img
              src="/images/reading-nature.webp"
              alt=""
              width={1536}
              height={1024}
              loading="lazy"
              decoding="async"
            />
          </button>
        </div>
      </section>
      <div className="today-footnotes">
        <button onClick={() => onStart("mistakes")}>
          <span className="footnote-icon">
            <RotateCcw size={19} />
          </span>
          <span>
            <strong>再巩固一下</strong>
            <small>
              {weak ? `${weak} 个词，值得再见一面` : "当前教材暂无待巩固词"}
            </small>
          </span>
          <ChevronRight size={17} />
        </button>
        <button onClick={onActivity}>
          <span className="footnote-icon">
            <span className="small-ring" />
          </span>
          <span>
            <strong>你的学习足迹</strong>
            <small>
              {stats.streak
                ? `连续 ${stats.streak} 天 · 今天已学 ${stats.todayWords} 词`
                : "从今天，开始积累"}
            </small>
          </span>
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
