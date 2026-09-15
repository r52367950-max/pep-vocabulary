"use client";

import { useMemo } from "react";
import { Check, Clock3, Leaf, Target } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { studyStats } from "@/lib/progress";
import { forecastDueLoad } from "@/lib/scheduler";
import { Empty } from "./shared";

export default function Activity({ data }: { data: Vocabulary }) {
  const stats = useMemo(() => studyStats(data.events), [data.events]);
  const index = useMemo(
    () => new Map(data.index.map((word) => [word.id, word])),
    [data.index],
  );
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - 6 + i);
    const key = date.toLocaleDateString("sv-SE");
    const events = stats.reviews.filter((e) => e.localDate === key);
    return {
      key,
      label: date.toLocaleDateString("zh-CN", { weekday: "short" }),
      count: new Set(events.map((e) => e.cardId)).size,
    };
  });
  const maximum = Math.max(10, ...week.map((day) => day.count));
  const forecast = forecastDueLoad(data.cards.values(), 7);
  return (
    <div className="activity-view">
      <div className="page-heading">
        <div>
          <p>回顾练习与复习安排</p>
          <h1>学习记录</h1>
        </div>
      </div>
      <div className="activity-metrics">
        {[
          {
            Icon: BookIcon,
            value: new Set(stats.reviews.map((e) => e.cardId)).size,
            label: "累计学习词数",
          },
          { Icon: Leaf, value: `${stats.streak} 天`, label: "连续学习" },
          {
            Icon: Clock3,
            value: `${stats.todayMinutes} 分钟`,
            label: "今日作答用时",
          },
          {
            Icon: Check,
            value: stats.accuracy === null ? "—" : `${stats.accuracy}%`,
            label: "今日作答正确率",
          },
        ].map(({ Icon, value, label }) => (
          <div key={label}>
            <Icon size={20} />
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="activity-panels">
        <section className="activity-chart">
          <div className="section-heading">
            <h2>最近七天</h2>
            <span>每天学习的不同单词</span>
          </div>
          <div
            className="bar-chart"
            role="img"
            aria-label={week
              .map((day) => `${day.label} ${day.count}词`)
              .join("，")}
          >
            {week.map((day) => (
              <div key={day.key}>
                <span>{day.count}</span>
                <i>
                  <b style={{ height: `${(day.count / maximum) * 100}%` }} />
                </i>
                <small>{day.label}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="forecast-panel">
          <h2>接下来的复习</h2>
          <p>根据当前记忆状态估算，学习后会更新。</p>
          {forecast.map((day, i) => (
            <div key={day.date}>
              <span>
                {i === 0
                  ? "今天（含积压）"
                  : new Date(`${day.date}T12:00:00`).toLocaleDateString(
                      "zh-CN",
                      { month: "short", day: "numeric" },
                    )}
              </span>
              <span>{day.count} 词</span>
            </div>
          ))}
        </section>
      </div>
      <section className="review-log">
        <div className="section-heading">
          <h2>最近的练习</h2>
          <span>含作答与订正</span>
        </div>
        {stats.reviews.length ? (
          [...stats.reviews]
            .reverse()
            .slice(0, 30)
            .map((event) => (
              <div key={event.eventId} className="log-row">
                <span
                  className={
                    event.correct ? "log-mark correct" : "log-mark incorrect"
                  }
                >
                  {event.correct ? "✓" : "↻"}
                </span>
                <div>
                  <strong>
                    {index.get(event.cardId)?.headword || "词条已更新"}
                  </strong>
                  <p>
                    {event.answerGiven
                      ? `你的答案：${event.answerGiven}`
                      : event.correct
                        ? "主动回忆：记得"
                        : "主动回忆：忘记"}
                    {!event.correct &&
                      event.expectedAnswer &&
                      ` · 正确答案：${event.expectedAnswer}`}
                  </p>
                </div>
                <time>
                  {new Date(event.timestampUtc).toLocaleDateString("zh-CN", {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </div>
            ))
        ) : (
          <Empty title="从第一轮学习开始">
            完成练习后，这里会记录你的作答、用时与复习安排。
          </Empty>
        )}
      </section>
    </div>
  );
}
const BookIcon = Target;
