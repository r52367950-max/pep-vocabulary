"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Languages,
  Leaf,
  Microscope,
  Mountain,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { READINGS, findReadingTargets } from "@/lib/reading";
import { Empty } from "./shared";

const icons = [BookOpen, Microscope, Mountain, Leaf, Sparkles, BookOpen];
export default function Reading({
  data,
  onDetail,
  onPractice,
}: {
  data: Vocabulary;
  onDetail: (word: LexiconIndexEntry) => void;
  onPractice: (words: LexiconIndexEntry[]) => void;
}) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const [translation, setTranslation] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [ownText, setOwnText] = useState("");
  const [aligned, setAligned] = useState<LexiconIndexEntry[] | null>(null);
  const article = READINGS.find((item) => item.id === articleId);
  const targets = useMemo(
    () => (article ? findReadingTargets(article, data.index) : []),
    [article, data.index],
  );
  const open = (id: string) => {
    setArticleId(id);
    setTranslation(false);
    setAnswers({});
    window.scrollTo(0, 0);
  };
  if (article)
    return (
      <div className="reading-article">
        <button className="text-button" onClick={() => setArticleId(null)}>
          <ArrowLeft size={17} />
          返回阅读
        </button>
        <div className="article-header">
          <span className="pill">
            {article.topic} · {article.level}
          </span>
          <h1 className="serif">{article.title}</h1>
          <h2>{article.titleZh}</h2>
          <div>
            <span>
              <Clock3 size={15} />
              {article.minutes} 分钟
            </span>
            <button
              className="text-button"
              aria-pressed={translation}
              onClick={() => setTranslation(!translation)}
            >
              <Languages size={17} />
              {translation ? "收起译文" : "显示译文"}
            </button>
          </div>
        </div>
        <div className="article-layout">
          <div>
            <article className="reading-body" lang="en">
              {article.paragraphs.map((paragraph, i) => (
                <div key={i}>
                  <p>{paragraph.en}</p>
                  {translation && (
                    <p lang="zh-CN" className="translation">
                      {paragraph.zh}
                    </p>
                  )}
                </div>
              ))}
              <small>{article.source}</small>
            </article>
            <section className="comprehension">
              <h2>读懂了吗？</h2>
              {article.questions.map((question, i) => (
                <div className="comprehension-item" key={question.id}>
                  <h3>
                    <span>{i + 1}</span>
                    {question.prompt}
                  </h3>
                  <div>
                    {question.options.map((option, oi) => (
                      <button
                        key={option}
                        className={
                          answers[question.id] === oi
                            ? oi === question.answerIndex
                              ? "choice-correct"
                              : "choice-incorrect"
                            : ""
                        }
                        disabled={answers[question.id] !== undefined}
                        onClick={() =>
                          setAnswers((previous) => ({
                            ...previous,
                            [question.id]: oi,
                          }))
                        }
                      >
                        {option}
                        {answers[question.id] === oi &&
                          (oi === question.answerIndex ? (
                            <Check size={16} />
                          ) : (
                            <X size={16} />
                          ))}
                      </button>
                    ))}
                  </div>
                  {answers[question.id] !== undefined && (
                    <p role="status">{question.explanation}</p>
                  )}
                </div>
              ))}
            </section>
          </div>
          <aside className="reading-vocabulary">
            <h2>文中的课内词</h2>
            <p>读完后，再试着独立回忆。</p>
            {targets.map((entry) => (
              <button key={entry.id} onClick={() => onDetail(entry)}>
                <strong>{entry.headword}</strong>
                <span>{entry.chineseCore}</span>
              </button>
            ))}
            {targets.length > 0 && (
              <button className="primary" onClick={() => onPractice(targets)}>
                练习这 {targets.length} 个词
                <ChevronRight size={16} />
              </button>
            )}
          </aside>
        </div>
      </div>
    );
  return (
    <div className="reading-view">
      <div className="page-heading">
        <div>
          <p>让词汇回到句子里</p>
          <h1>读一点英语</h1>
        </div>
        <span className="quiet-badge">
          <BookOpen size={16} />
          高中英语原创短读
        </span>
      </div>
      <div className="reading-intro">
        <div>
          <h2>从你感兴趣的事开始。</h2>
          <p>
            几分钟的阅读，遇见学过的词。
            <br />
            配有译文、课内词汇与理解小题。
          </p>
        </div>
        <span className="reading-art">
          <BookOpen size={88} strokeWidth={0.8} />
          <Leaf size={35} strokeWidth={1} />
        </span>
      </div>
      <div className="reading-grid">
        {READINGS.map((item, i) => {
          const Icon = icons[i % icons.length];
          return (
            <button
              className={`reading-card reading-color-${i % 3}`}
              onClick={() => open(item.id)}
              key={item.id}
            >
              <div className="reading-card-art">
                <Icon size={52} strokeWidth={1} />
                <span>{item.topic}</span>
              </div>
              <div className="reading-card-copy">
                <h2 className="serif">{item.title}</h2>
                <h3>{item.titleZh}</h3>
                <p>
                  {item.level}
                  <span>
                    {item.minutes} 分钟 <ArrowUpRight size={16} />
                  </span>
                </p>
              </div>
            </button>
          );
        })}
      </div>
      <details className="own-reading">
        <summary>也可以读自己的文章</summary>
        <p>粘贴一段英语，找出其中已收录的单词和短语。文本仅在本机处理。</p>
        <textarea
          maxLength={30000}
          aria-label="粘贴自己的英文文章"
          value={ownText}
          onChange={(e) => setOwnText(e.target.value)}
          placeholder="在这里粘贴英文文章…"
        />
        <button
          className="secondary"
          disabled={!ownText.trim()}
          onClick={() => {
            const normalized = ` ${ownText
              .toLowerCase()
              .replace(/[^a-z' -]/g, " ")
              .replace(/\s+/g, " ")} `;
            setAligned(
              data.index
                .filter((entry) =>
                  normalized.includes(` ${entry.lookup.toLowerCase()} `),
                )
                .slice(0, 80),
            );
          }}
        >
          <Search size={16} />
          查找课内词
        </button>
        {aligned?.length ? (
          <div className="aligned-words">
            {aligned.map((entry) => (
              <button key={entry.id} onClick={() => onDetail(entry)}>
                {entry.headword}
              </button>
            ))}
            <button
              className="primary small"
              onClick={() => onPractice(aligned)}
            >
              练习这些词
            </button>
          </div>
        ) : (
          aligned && (
            <Empty title="没有找到已收录的词">
              可以换一段包含课内词汇的文章。
            </Empty>
          )
        )}
      </details>
    </div>
  );
}
