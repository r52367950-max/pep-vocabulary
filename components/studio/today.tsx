"use client";

import { ChevronRight, Mic, Play } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { StudyMode } from "@/lib/study";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { timeOfDay } from "@/lib/art";
import { CoursePicker } from "./shared";
import { StudioSymbol } from "./symbol";
import { Artwork, useDarkAppearance } from "./art";

export default function Today({ data, bookId, unit, onCourse, due, newCount, weak, total, learned, queue, onStart, onPractice, onWords, resume, resumeLabel, onWrite, onVoice }: {
  data: Vocabulary; bookId: string; unit: string; onCourse: (book: string, unit: string) => void;
  due: number; newCount: number; weak: number; total: number; learned: number;
  queue: LexiconIndexEntry[]; onStart: (mode: StudyMode) => void; onPractice: () => void; onWords: () => void;
  resume: (() => void) | null; resumeLabel: string | null;
  onWrite: (options: { targets?: string[]; openId?: string | null }) => void;
  onVoice: (tab?: "speaking" | "dictation") => void;
}) {
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
      <section className="practice-section home-practice" aria-labelledby="practice-title">
        <div className="section-heading"><h2 id="practice-title">自主练习</h2></div>
        <div className="practice-grid">
          <button className="practice-option" onClick={onPractice}>
            <StudioSymbol name="cards" size={26} />
            <span><strong>词汇练习</strong><small>{weak ? `词卡、配对、自测 · ${weak} 词待巩固` : "词卡、配对、自测"}</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
          <button className="practice-option" onClick={() => onVoice("speaking")}>
            <span className="practice-entry-symbol"><Mic size={26} strokeWidth={1.6} aria-hidden="true" /></span>
            <span><strong>口语对话</strong><small>用学过的词聊一聊</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
          <button className="practice-option" onClick={() => onVoice("dictation")}>
            <StudioSymbol name="listen" size={26} />
            <span><strong>单词听写</strong><small>听单词，也听句子</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
          <button className="practice-option" onClick={() => onWrite({ targets: [] })}>
            <StudioSymbol name="write" size={26} />
            <span><strong>写作练习</strong><small>用学过的词写一段</small></span>
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}
