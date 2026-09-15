"use client";
/* eslint-disable @next/next/no-img-element -- Versioned local WebP art with responsive srcset, not an image proxy. */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, ExternalLink, Download, Trash2, Languages, Minus, Plus, RotateCcw, Search, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { READING_CATEGORIES, READING_FORMS, LENGTHS, lengthBand, loadReadingCatalog, loadLibraryArticle, matchReadingWords, type LibraryArticle, type ReadingMeta, type ReadingCategory } from "@/lib/reading-library";
import { StudioSymbol } from "./symbol";
import { readingCoverBase } from "@/lib/reading-art";
import { listPersonalReadings, readPersonalArticle, removePersonalArticle, exportPersonalArticle } from "@/lib/personal-readings";
const ReadingImport = lazy(() => import("./reading-import"));

function Cover({ category, articleId, eager = false }: { category: ReadingCategory; articleId: string; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const base = readingCoverBase(category, articleId);
  return <span className={`reading-cover cover-${category}`} aria-hidden="true">
    <span className="cover-fallback"><StudioSymbol name={category === "science" ? "today" : "reading"} size={34} /></span>
    {!failed && <img src={`${base}-480.webp`} srcSet={`${base}-480.webp 480w, ${base}-960.webp 960w`} sizes="(max-width: 600px) calc(100vw - 40px), (max-width: 1120px) 40vw, 320px" alt="" width={480} height={320} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setFailed(true)} />}
  </span>;
}
function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="reading-empty" role="alert"><BookOpen size={30} /><h2>暂时无法打开</h2><p>{message}</p><button className="secondary" onClick={retry}><RotateCcw size={16} />重新加载</button></div>;
}
export default function Reading({ data, onDetail, onPractice }: {
  data: Vocabulary; onDetail: (word: LexiconIndexEntry) => void; onPractice: (words: LexiconIndexEntry[]) => void;
}) {
  const [personal, setPersonal] = useState<ReadingMeta[]>([]);
  const [personalError, setPersonalError] = useState("");
  const [shelf, setShelf] = useState<"library" | "personal">("library");
  const [importOpen, setImportOpen] = useState(false);
  const [catalog, setCatalog] = useState<ReadingMeta[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [article, setArticle] = useState<LibraryArticle | null>(null);
  const [articleError, setArticleError] = useState("");
  const [articleRetry, setArticleRetry] = useState(0);
  const [translation, setTranslation] = useState(false);
  const [lookupEnabled, setLookupEnabled] = useState(false);
  const [fontSize, setFontSize] = useState(21);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [length, setLength] = useState(0);
  const [page, setPage] = useState(1);
  const [ownText, setOwnText] = useState("");
  const [aligned, setAligned] = useState<LexiconIndexEntry[] | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listPosition = useRef(0);
  const lastArticle = useRef<string | null>(null);
  const returning = useRef(false);

  useEffect(() => { let active = true; listPersonalReadings().then(a => { if (active) setPersonal(a); }).catch(e => { if (active) setPersonalError(e.message); }); return () => { active = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 15000);
    let active = true;
    loadReadingCatalog(controller.signal).then(value => { if (active) setCatalog(value); }).catch(() => {
      if (active) setCatalogError("请检查网络连接，或稍后再试。已保存的学习记录不受影响。");
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [catalogRetry]);
  useEffect(() => {
    if (!articleId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), 15000);
    let active = true;
    (articleId.startsWith("personal-") ? readPersonalArticle(articleId) : loadLibraryArticle(articleId, controller.signal)).then(value => {
      if (active) { setArticle(value); requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true })); }
    }).catch(() => { if (active) setArticleError("这篇文章尚未载入。请检查网络后重试。"); }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [articleId, articleRetry]);
  useEffect(() => {
    if (articleId) window.scrollTo({ top: 0, behavior: "instant" });
    else if (returning.current) {
      returning.current = false;
      window.scrollTo({ top: listPosition.current, behavior: "instant" });
      document.querySelector<HTMLButtonElement>(`[data-reading-id="${lastArticle.current}"]`)?.focus({ preventScroll: true });
    }
  }, [articleId]);
  const targets = useMemo(() => article ? matchReadingWords(article.paragraphs, data.index, article.targets) : [], [article, data.index]);
  const lookup = useMemo(() => new Map(targets.map(e => [e.headword.toLowerCase(), e])), [targets]);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (shelf === "personal" ? personal : catalog ?? []).filter(a => (category === "all" || a.category === category) && (difficulty === "all" || a.difficulty === difficulty) && (!length || lengthBand(a.wordCount) === length) && (!q || [a.title, a.titleZh, a.author].join(" ").toLocaleLowerCase().includes(q)));
  }, [catalog, personal, shelf, category, difficulty, length, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const displayed = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const open = (id: string) => {
    listPosition.current = window.scrollY; lastArticle.current = id;
    setArticle(null); setArticleError(""); setArticleId(id); setTranslation(false); setAnswers({});
  };
  const back = () => { returning.current = true; setArticleId(null); };
  const resetFilters = () => { setQuery(""); setCategory("all"); setDifficulty("all"); setLength(0); setPage(1); };

  if (articleId) {
    const questions = article?.questions ?? [];
    const hasTranslation = article?.paragraphs.some(p => p.zh);
    const used = new Set<string>();
    return <div className="reader-view">
      <div className="reader-toolbar">
        <button className="reader-back" onClick={back}><ArrowLeft size={18} />阅读</button>
        <div className="reader-tools">
          {targets.length > 0 && <button className="reader-translation-toggle" aria-pressed={lookupEnabled} onClick={() => setLookupEnabled(!lookupEnabled)}><BookOpen size={17} /><span>查词</span></button>}
          {hasTranslation && <button aria-pressed={translation} className="reader-translation-toggle" onClick={() => setTranslation(!translation)}><Languages size={18} /><span>{translation ? "收起译文" : "译文"}</span></button>}
          <div className="reader-type-size" role="group" aria-label="正文字号">
            <button aria-label="缩小字号" disabled={fontSize <= 18} onClick={() => setFontSize(n => n - 1)}><Minus size={15} /></button><span aria-hidden="true">Aa</span><button aria-label="放大字号" disabled={fontSize >= 27} onClick={() => setFontSize(n => n + 1)}><Plus size={15} /></button>
          </div>
        </div>
      </div>
      {articleError ? <LoadError message={articleError} retry={() => { setArticleError(""); setArticleRetry(n => n + 1); }} /> : !article ? <div className="reading-loading" role="status"><span className="reading-skeleton line-wide" /><span className="reading-skeleton line-short" /><p>正在载入正文…</p></div> :
      <div className="reader-column">
        <header className="reader-title">
          <div className="reader-meta"><span>{READING_CATEGORIES[article.category]}</span><span>{article.difficulty} · 估计难度</span><span>{READING_FORMS[article.form]}</span></div>
          <h1 ref={titleRef} tabIndex={-1} lang="en">{article.title}</h1>
          {article.titleZh && article.titleZh !== article.title && <p className="reader-title-zh">{article.titleZh}</p>}
          <p className="reader-byline">{article.author}</p>
          <p className="reader-duration">{article.wordCount.toLocaleString()} 词<span aria-hidden="true" />约 {Math.max(1, Math.ceil(article.wordCount / 150))} 分钟</p>

        </header>
        {lookupEnabled && targets.length > 0 && <p className="reader-lookup-hint"><BookOpen size={15} />点按带下划线的单词，查看释义。</p>}
        <article className="reader-prose" lang="en" aria-label={article.title} style={{ fontSize }}>
          {article.paragraphs.map((paragraph, i) => <div className="reader-paragraph" key={i}>
            <p>{!lookupEnabled ? paragraph.en : (paragraph.en.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|[^A-Za-z]+/g) ?? []).map((token, j) => {
              const word = token.toLowerCase(); const entry = lookup.get(word);
              if (!entry || used.has(word)) return token;
              used.add(word);
              return <button className="reader-inline-word" key={j} onClick={() => onDetail(entry)} aria-label={`查看 ${token} 的释义`}>{token}</button>;
            })}</p>
            {translation && paragraph.zh && <p lang="zh-CN" className="reader-translation">{paragraph.zh}</p>}
          </div>)}
        </article>
        <aside className="reader-endnote" aria-label="作品简介"><p>{article.background}</p>{article.backgroundEn && <p lang="en">{article.backgroundEn}</p>}</aside>
        <details className="reader-source-details"><summary>来源与阅读提示<ChevronDown size={17} /></summary><div>
          <p><strong>{READING_FORMS[article.form]} · {article.author}</strong></p>
          <p>{article.difficultyNote} 难度为编辑估计，与篇幅分别标注。</p>
          <p>{article.rights.basis}</p>
          <div className="reader-source-links">{article.form !== "imported" && <><a href={article.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源<ExternalLink size={14} /></a><a href={article.rights.url} target="_blank" rel="noopener noreferrer">{article.rights.label}<ExternalLink size={14} /></a></>}</div>
        </div></details>
        <details className="reader-words">
          <summary><BookOpen size={19} /><span>文中的课内词</span><span className="reader-count">{targets.length}</span><ChevronDown className="reader-disclosure" size={17} /></summary>
          <div className="reader-words-body">{targets.length ? <><div className="reader-word-list">{targets.map(entry => <button key={entry.id} onClick={() => onDetail(entry)}><span lang="en">{entry.headword}</span><span>{entry.chineseCore}</span><ChevronRight size={16} /></button>)}</div><button className="reader-primary" onClick={() => onPractice(targets)}>练习这 {targets.length} 个词</button></> : <p className="reader-muted">当前词库暂未匹配到本文词汇。</p>}</div>
        </details>
        {questions.length > 0 && <section className="reader-comprehension" aria-labelledby="reader-questions-title"><div className="reader-section-heading"><h2 id="reader-questions-title">阅读理解</h2>{Object.keys(answers).length === questions.length && <button className="reader-text-button" onClick={() => setAnswers({})}>重新作答</button>}</div>
          {questions.map((question, i) => {
            const chosen = answers[question.id]; const answered = chosen !== undefined;
            return <fieldset className="reader-question" key={question.id}><legend><span className="reader-question-number">{i + 1}</span><span lang="en">{question.prompt}</span></legend><div className="reader-choices">{question.options.map((option, j) => <button key={option} lang="en" className={answered && j === question.answerIndex ? "is-correct" : chosen === j ? "is-incorrect" : ""} disabled={answered} aria-pressed={chosen === j} onClick={() => setAnswers(previous => ({ ...previous, [question.id]: j }))}><span className="reader-choice-letter">{String.fromCharCode(65 + j)}</span><span>{option}</span>{answered && j === question.answerIndex && <Check size={17} aria-label="正确答案" />}{chosen === j && j !== question.answerIndex && <X size={17} aria-label="回答错误" />}</button>)}</div>{answered && <p className="reader-explanation" role="status"><strong>{chosen === question.answerIndex ? "答对了。" : "再读一读。"}</strong>{question.explanation}</p>}</fieldset>;
          })}
        </section>}
        {article.form === "imported" && <div className="reader-personal-actions"><button onClick={() => exportPersonalArticle(article)}><Download size={16} />导出文章</button><button onClick={async () => { if (!confirm("从本机移除这篇文章？已保存的单词学习记录会保留。")) return; try { await removePersonalArticle(article.id); setPersonal(await listPersonalReadings()); back(); } catch { data.notify("移除未完成，请重试。"); } }}><Trash2 size={16} />移除文章</button></div>}
        <div className="reader-finish"><button className="reader-text-button" onClick={back}><ArrowLeft size={17} />返回阅读</button>{targets.length > 0 && <button className="reader-primary" onClick={() => onPractice(targets)}>练习文中单词<ArrowRight size={16} /></button>}</div>
      </div>}
    </div>;
  }
  return <div className="reading-shelf">
    <header className="page-heading reading-shelf-heading"><div><h1>阅读</h1><p>经典散文、故事与科学阅读</p></div><div className="reading-header-actions"><button className="reading-import-button" onClick={() => setImportOpen(true)}><Plus size={18} />导入文章</button></div></header>
    <div className="reading-shelves" role="group" aria-label="阅读来源"><button aria-pressed={shelf === "library"} onClick={() => { setShelf("library"); setPage(1); }}>文章精选<span>{catalog?.length ?? ""}</span></button><button aria-pressed={shelf === "personal"} onClick={() => { setShelf("personal"); setPage(1); }}>我的文章<span>{personal.length}</span></button></div>
    <div className="reading-browser-controls">
      <label className="reading-search"><Search size={18} /><input type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} placeholder="搜索作品或作者" aria-label="搜索作品或作者" maxLength={200} />{query && <button aria-label="清空阅读搜索" onClick={() => { setQuery(""); setPage(1); }}><X size={17} /></button>}</label>
      <div className="reading-filters">
        <select aria-label="阅读类别" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="all">全部类别</option>{Object.entries(READING_CATEGORIES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
        <select aria-label="语言难度" value={difficulty} onChange={e => { setDifficulty(e.target.value); setPage(1); }}><option value="all">全部难度</option>{["A2", "B1", "B2", "C1"].map(value => <option value={value} key={value}>{value} · 估计</option>)}</select>
        <select aria-label="文章篇幅" value={length} onChange={e => { setLength(Number(e.target.value)); setPage(1); }}>{LENGTHS.map((label, i) => <option value={i} key={i}>{label}</option>)}</select>
      </div>
    </div>
    {shelf === "personal" && personalError ? <p role="alert" className="import-error">{personalError}</p> : shelf === "library" && catalogError ? <LoadError message={catalogError} retry={() => { setCatalogError(""); setCatalogRetry(n => n + 1); }} /> : shelf === "library" && !catalog ? <div className="reading-loading" role="status"><div className="reading-skeleton" /><p>正在载入阅读目录…</p></div> : <>
      <div className="reading-result-count" role="status">{category !== "all" || difficulty !== "all" || length || query ? `找到 ${filtered.length} 篇` : "所有文章"}<span>难度与篇幅分别标注</span></div>
      {displayed.length ? <div className="reading-grid">{displayed.map((item, i) => <button className="reading-card" key={item.id} data-reading-id={item.id} onClick={() => open(item.id)}>
        <Cover category={item.category} articleId={item.id} eager={i < 3} />
        <span className="reading-card-copy"><span className="reading-card-category">{READING_CATEGORIES[item.category]}</span><strong lang="en">{item.title}</strong><span className="reading-card-author">{item.author}</span><span className="reading-card-meta"><span>{item.difficulty}</span><span>{item.wordCount.toLocaleString()} 词</span><span>{READING_FORMS[item.form]}</span></span></span>
      </button>)}</div> : <div className="reading-empty"><Search size={30} /><h2>{shelf === "personal" && !personal.length ? "保存你想读的文章" : "没有找到文章"}</h2><p>{shelf === "personal" && !personal.length ? "导入文件、扫描英文，或直接粘贴正文。" : "试试其他作品、作者或筛选条件。"}</p><button className="secondary" onClick={shelf === "personal" && !personal.length ? () => setImportOpen(true) : resetFilters}>{shelf === "personal" && !personal.length ? "导入文章" : "清除筛选"}</button></div>}
      {pages > 1 && <div className="reading-pagination"><button disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); window.scrollTo(0, 0); }}><ArrowLeft size={17} />上一页</button><span>{currentPage} / {pages}</span><button disabled={currentPage === pages} onClick={() => { setPage(currentPage + 1); window.scrollTo(0, 0); }}>下一页<ArrowRight size={17} /></button></div>}
    </>}
    {importOpen && <Suspense fallback={null}><ReadingImport onClose={() => setImportOpen(false)} onSaved={async id => { setPersonal(await listPersonalReadings()); setImportOpen(false); resetFilters(); requestAnimationFrame(() => { setShelf("personal"); open(id); }); }} /></Suspense>}
    <details className="reader-own"><summary><Plus size={19} /><span>快速查找课内词</span><ChevronDown className="reader-disclosure" size={17} /></summary><div className="reader-own-body"><p>粘贴英文，查找其中的课内词汇。</p><textarea maxLength={30000} rows={5} aria-label="粘贴自己的英文文章" value={ownText} onChange={e => { setOwnText(e.target.value); setAligned(null); }} placeholder="在这里粘贴英文文章…" /><button className="reader-primary" disabled={!ownText.trim()} onClick={() => setAligned(matchReadingWords([{ en: ownText }], data.index))}><Search size={17} />查找课内词</button>{aligned && <div className="reader-own-result" aria-live="polite">{aligned.length ? <><p>找到 {aligned.length} 个词</p><div className="reader-own-matches">{aligned.map(e => <button key={e.id} lang="en" onClick={() => onDetail(e)}>{e.headword}</button>)}</div><button className="reader-text-button" onClick={() => onPractice(aligned)}>练习这些词<ChevronRight size={17} /></button></> : <p>没有匹配到课内词汇。试试换一段文章。</p>}</div>}</div></details>
  </div>;
}
