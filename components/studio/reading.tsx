"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, Languages, Plus, Search, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { READINGS, findReadingTargets, readingWordCount } from "@/lib/reading";

const summaries: Record<string, string> = {
  "a-place-to-begin": "从一次小小的分享开始，找到表达自己的信心。",
  "a-small-question": "两株豆苗，一个问题。观察之后，还有什么值得追问？",
};

function ReadingArtwork({ kind, eager = false }: { kind: "conversation" | "nature"; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`reading-shelf-art reading-shelf-art-${kind}`} aria-hidden="true">
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element -- Local, pre-encoded editorial asset; no image proxy is needed.
        <img src={`/images/reading-${kind}.webp`} alt="" width={1536} height={1024}
          loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export default function Reading({ data, onDetail, onPractice }: {
  data: Vocabulary;
  onDetail: (word: LexiconIndexEntry) => void;
  onPractice: (words: LexiconIndexEntry[]) => void;
}) {
  const [articleId, setArticleId] = useState<string | null>(null);
  const [translation, setTranslation] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [ownText, setOwnText] = useState("");
  const [aligned, setAligned] = useState<LexiconIndexEntry[] | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listPosition = useRef(0);
  const lastArticle = useRef<string | null>(null);
  const returning = useRef(false);
  const article = READINGS.find((item) => item.id === articleId);
  const targets = useMemo(() => article ? findReadingTargets(article, data.index) : [], [article, data.index]);

  useEffect(() => {
    if (articleId) {
      window.scrollTo({ top: 0, behavior: "instant" });
      titleRef.current?.focus({ preventScroll: true });
    } else if (returning.current) {
      returning.current = false;
      window.scrollTo({ top: listPosition.current, behavior: "instant" });
      document.querySelector<HTMLButtonElement>(`[data-reading-id="${lastArticle.current}"]`)?.focus({ preventScroll: true });
    }
  }, [articleId]);

  const open = (id: string) => {
    listPosition.current = window.scrollY;
    lastArticle.current = id;
    setArticleId(id);
    setTranslation(false);
    setAnswers({});
  };
  const back = () => { returning.current = true; setArticleId(null); };
  const findOwnWords = () => {
    const normalized = ` ${ownText.toLowerCase().replace(/[^a-z' -]/g, " ").replace(/\s+/g, " ")} `;
    setAligned(data.index.filter((entry) => normalized.includes(` ${entry.lookup.toLowerCase()} `)).slice(0, 80));
  };

  if (article) {
    const answered = Object.keys(answers).length;
    return (
      <div className="reader-view">
        <div className="reader-toolbar">
          <button className="reader-back" onClick={back}><ArrowLeft size={19} />阅读</button>
          <button className="reader-translation-toggle" aria-pressed={translation} onClick={() => setTranslation(!translation)}>
            <Languages size={19} />{translation ? "收起译文" : "显示译文"}
          </button>
        </div>
        <div className="reader-column">
          <header className="reader-title">
            <div className="reader-meta"><span>{article.topic}</span><span>{article.level}</span></div>
            <h1 ref={titleRef} tabIndex={-1} lang="en">{article.title}</h1>
            <p className="reader-title-zh">{article.titleZh}</p>
            <p className="reader-duration">{readingWordCount(article)} 词<span aria-hidden="true" />约 {article.minutes} 分钟</p>
          </header>
          <article className="reader-prose" lang="en" aria-label={article.title}>
            {article.paragraphs.map((paragraph, i) => (
              <div className="reader-paragraph" key={i}>
                <p>{paragraph.en}</p>
                {translation && <p lang="zh-CN" className="reader-translation">{paragraph.zh}</p>}
              </div>
            ))}
          </article>
          <p className="reader-source">{article.source}</p>
          <details className="reader-words">
            <summary><BookOpen size={20} /><span>文中的课内词</span><span className="reader-count">{targets.length}</span><ChevronDown className="reader-disclosure" size={18} /></summary>
            <div className="reader-words-body">
              {targets.length ? <>
                <div className="reader-word-list">
                  {targets.map((entry) => <button key={entry.id} onClick={() => onDetail(entry)}>
                    <span lang="en">{entry.headword}</span><span>{entry.chineseCore}</span><ChevronRight size={16} />
                  </button>)}
                </div>
                <button className="reader-primary" onClick={() => onPractice(targets)}>练习这 {targets.length} 个词</button>
              </> : <p className="reader-muted">这篇短文暂未匹配到当前词库中的词条。</p>}
            </div>
          </details>
          <section className="reader-comprehension" aria-labelledby="reader-questions-title">
            <div className="reader-section-heading">
              <div><h2 id="reader-questions-title">读懂了吗？</h2><p>用两个问题，回想刚才的内容。</p></div>
              {answered === article.questions.length && <button className="reader-text-button" onClick={() => setAnswers({})}>重新作答</button>}
            </div>
            {article.questions.map((question, i) => {
              const chosen = answers[question.id];
              const isAnswered = chosen !== undefined;
              return <fieldset className="reader-question" key={question.id}>
                <legend><span className="reader-question-number">{i + 1}</span><span lang="en">{question.prompt}</span></legend>
                <div className="reader-choices">
                  {question.options.map((option, oi) => {
                    const correctChoice = isAnswered && oi === question.answerIndex;
                    const incorrectChoice = chosen === oi && !correctChoice;
                    return <button key={option} lang="en"
                      className={correctChoice ? "is-correct" : incorrectChoice ? "is-incorrect" : ""}
                      disabled={isAnswered} aria-pressed={chosen === oi}
                      onClick={() => setAnswers((previous) => ({ ...previous, [question.id]: oi }))}>
                      <span className="reader-choice-letter">{String.fromCharCode(65 + oi)}</span><span>{option}</span>
                      {correctChoice && <Check size={18} aria-label="正确答案" />}
                      {incorrectChoice && <X size={18} aria-label="回答错误" />}
                    </button>;
                  })}
                </div>
                {isAnswered && <p className="reader-explanation" role="status"><strong>{chosen === question.answerIndex ? "答对了。" : "再留意一下。"}</strong>{question.explanation}</p>}
              </fieldset>;
            })}
          </section>
          <div className="reader-finish">
            <button className="reader-text-button" onClick={back}><ArrowLeft size={17} />返回阅读</button>
            {targets.length > 0 && <button className="reader-primary" onClick={() => onPractice(targets)}>练习文中单词</button>}
          </div>
        </div>
      </div>
    );
  }

  const featured = READINGS[0];
  const nature = READINGS[1];
  return (
    <div className="reading-shelf">
      <header className="reading-shelf-heading"><h1>阅读</h1><p>6 篇原创短文</p></header>
      <section className="reading-shelf-feature" aria-labelledby="reading-feature-title">
        <ReadingArtwork kind="conversation" eager />
        <div className="reading-shelf-feature-copy">
          <p className="reading-shelf-feature-label">今日精选</p>
          <h2 id="reading-feature-title" lang="en">{featured.title}</h2>
          <p className="reading-shelf-feature-zh">{featured.titleZh}</p>
          <p className="reading-shelf-feature-summary">{summaries[featured.id]}</p>
          <div className="reading-shelf-feature-bottom">
            <button className="reading-shelf-start" data-reading-id={featured.id} onClick={() => open(featured.id)}>开始阅读<ChevronRight size={17} /></button>
            <span>{featured.minutes} 分钟</span>
          </div>
        </div>
      </section>
      <section className="reading-shelf-browse" aria-labelledby="reading-browse-title">
        <div className="reading-shelf-section-heading"><h2 id="reading-browse-title">换个角度，看世界</h2><span>{READINGS.length} 篇短文</span></div>
        <button className="reading-shelf-spotlight" data-reading-id={nature.id} onClick={() => open(nature.id)}>
          <ReadingArtwork kind="nature" />
          <span className="reading-shelf-spotlight-copy">
            <span className="reading-shelf-topic">{nature.topic}</span>
            <strong lang="en">{nature.title}</strong>
            <span className="reading-shelf-story-zh">{nature.titleZh}</span>
            <span className="reading-shelf-story-summary">{summaries[nature.id]}</span>
            <span className="reading-shelf-story-meta">{readingWordCount(nature)} 词<span />{nature.minutes} 分钟</span>
          </span>
          <ChevronRight className="reading-shelf-row-chevron" size={21} />
        </button>
        <div className="reading-shelf-list">
          {READINGS.slice(2).map((item) => <button className="reading-shelf-row" key={item.id} data-reading-id={item.id} onClick={() => open(item.id)}>
            <span className="reading-shelf-topic">{item.topic}</span>
            <span className="reading-shelf-row-copy"><strong lang="en">{item.title}</strong><span>{item.titleZh}</span></span>
            <span className="reading-shelf-row-time">{item.minutes} 分钟</span>
            <ChevronRight className="reading-shelf-row-chevron" size={19} />
          </button>)}
        </div>
      </section>
      <details className="reader-own">
        <summary><Plus size={20} /><span>阅读自己的文章</span><ChevronDown className="reader-disclosure" size={18} /></summary>
        <div className="reader-own-body">
          <p>粘贴一段英文，找出其中的课内词汇。</p>
          <textarea maxLength={30000} rows={6} aria-label="粘贴自己的英文文章" value={ownText}
            onChange={(event) => { setOwnText(event.target.value); setAligned(null); }} placeholder="在这里粘贴英文文章…" />
          <button className="reader-primary" disabled={!ownText.trim()} onClick={findOwnWords}><Search size={17} />查找课内词</button>
          {aligned && <div className="reader-own-result" aria-live="polite">
            {aligned.length ? <>
              <p>找到 {aligned.length} 个词</p>
              <div className="reader-own-matches">{aligned.map((entry) => <button key={entry.id} lang="en" onClick={() => onDetail(entry)}>{entry.headword}</button>)}</div>
              <button className="reader-text-button" onClick={() => onPractice(aligned)}>练习这些词<ChevronRight size={17} /></button>
            </> : <p>没有找到已收录的词。可以换一段包含课内词汇的文章。</p>}
          </div>}
        </div>
      </details>
    </div>
  );
}
