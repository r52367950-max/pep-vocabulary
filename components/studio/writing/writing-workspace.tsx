"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { runAssistant, AssistantError } from "@/lib/ai-client";
import { deleteWriting, listWritings, saveWriting, createLocalId, type WritingGenre, type WritingRecord } from "@/lib/storage";
import { countWords, findTargetUses, latestVersion, localWritingChecks, newWriting, suggestTargets, WRITING_GENRES, writingTitle } from "@/lib/writing";
import { StudioSymbol } from "../symbol";
import { useElapsed, useLearnerProfile } from "../ai/use-assistant";
import EssayReview from "./essay-review";

// Editorial sample prompts; the continuation openings are written for 词迹, not taken from any exam.
const SAMPLE_PROMPTS: Record<WritingGenre, string[]> = {
  free: ["写一次让你改变想法的经历，以及你从中学到了什么。", "高中生应该怎样平衡学习和兴趣爱好？谈谈你的看法。", "介绍一个对你很重要的地方，并说明原因。"],
  practical: ["假定你是李华，给外国朋友 Tom 写一封邮件，邀请他参加学校本周五的英语角活动。", "为校英语报写一则通知，介绍下周末的社区环保志愿活动（时间、地点、内容、报名方式）。", "假定你是李华，给外教 Ms. Green 写一封感谢信，感谢她一学期的帮助。"],
  continuation: [
    "续写两段。开头：The bus had already pulled away when Emma reached the stop, her science project in her arms. The competition would begin in forty minutes.",
    "续写两段。开头：Nobody in our class wanted to sit next to the new boy, Leo. He hardly spoke, and at lunch he always read alone under the old tree.",
  ],
};

type View = { kind: "list" } | { kind: "setup" } | { kind: "edit"; id: string };

export default function WritingWorkspace({ data, initialTargets, openId, onExit, onPractice, onWord }: {
  data: Vocabulary;
  initialTargets?: string[];
  openId?: string | null;
  onExit: () => void;
  onPractice: (entries: LexiconIndexEntry[]) => void;
  onWord: (entry: LexiconIndexEntry) => void;
}) {
  const [records, setRecords] = useState<WritingRecord[] | null>(null);
  const [view, setView] = useState<View>(openId ? { kind: "edit", id: openId } : initialTargets ? { kind: "setup" } : { kind: "list" });
  const reload = useCallback(() => listWritings().catch(() => []).then((rows) => {
    setRecords(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }), []);
  useEffect(() => {
    let active = true;
    listWritings().catch(() => []).then((rows) => { if (active) setRecords(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); });
    return () => { active = false; };
  }, []);

  const back = () => { if (view.kind === "edit" || view.kind === "setup") setView({ kind: "list" }); else onExit(); };
  const exit = useEffectEvent(back);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select")) { target.blur(); return; }
      event.preventDefault();
      exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const upsert = useCallback((record: WritingRecord) => {
    setRecords((current) => [record, ...(current || []).filter((item) => item.id !== record.id)]);
  }, []);
  const record = view.kind === "edit" ? records?.find((item) => item.id === view.id) : undefined;

  return (
    <div className="learn-screen writing-screen">
      <header className="writing-header">
        <button type="button" className="icon-button" onClick={back} aria-label={view.kind === "list" ? "退出，返回今日" : "返回写作记录"}>
          {view.kind === "list" ? <X size={22} aria-hidden="true" /> : <ArrowLeft size={22} aria-hidden="true" />}
        </button>
        <span className="learn-header-title">{view.kind === "list" ? "写作" : view.kind === "setup" ? "新的写作" : record ? writingTitle(record) : "写作"}</span>
        <span className="learn-header-spacer" />
        {view.kind === "list" && <button className="secondary writing-new" onClick={() => setView({ kind: "setup" })}><Plus size={16} aria-hidden="true" />新写一篇</button>}
      </header>
      {records === null ? <div className="learn-pending" role="status">正在读取写作记录…</div>
        : view.kind === "list" ? <WritingList records={records} data={data} onOpen={(id) => setView({ kind: "edit", id })} onDelete={async (id) => { await deleteWriting(id); await reload(); }} />
          : view.kind === "setup" ? <WritingSetup data={data} initialTargets={initialTargets} onCreate={async (created) => { await saveWriting(created); upsert(created); setView({ kind: "edit", id: created.id }); }} />
            : record ? <WritingEditor key={record.id} record={record} data={data} onSave={upsert} onPractice={onPractice} onWord={onWord} />
              : <div className="learn-pending">这篇写作已不存在。</div>}
    </div>
  );
}

function WritingList({ records, data, onOpen, onDelete }: { records: WritingRecord[]; data: Vocabulary; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <main className="writing-stage writing-list">
      <h1 ref={heading} tabIndex={-1}>写作记录</h1>
      {records.length ? (
        <ul>
          {records.map((record) => {
            const version = latestVersion(record);
            const reviewed = [...record.versions].reverse().find((item) => item.review)?.review?.result;
            return (
              <li key={record.id}>
                <button className="writing-row" onClick={() => onOpen(record.id)}>
                  <span>
                    <strong>{writingTitle(record)}</strong>
                    <small>
                      {WRITING_GENRES[record.genre].label} · {countWords(version?.text || "")} 词 · {record.versions.length} 版 ·{" "}
                      {new Date(record.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
                    </small>
                    <small className="english">{record.targetIds.map((id) => data.byId.get(id)?.headword).filter(Boolean).join(" · ")}</small>
                  </span>
                  {reviewed && <span className="writing-score">{String(reviewed.estimatedScore)}<small>/{String(reviewed.outOf)}</small></span>}
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
                <button className="icon-button writing-delete" aria-label={`删除《${writingTitle(record)}》`}
                  onClick={() => { if (window.confirm("删除这篇写作及其全部版本和批改？此操作不能撤销。")) onDelete(record.id); }}>
                  <Trash2 size={17} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty">
          <StudioSymbol name="write" size={30} />
          <h2>还没有写作</h2>
          <p>用最近学过的词写一段，写完可以让 AI 批改。</p>
        </div>
      )}
    </main>
  );
}

function WritingSetup({ data, initialTargets, onCreate }: { data: Vocabulary; initialTargets?: string[]; onCreate: (record: WritingRecord) => void }) {
  const [genre, setGenre] = useState<WritingGenre>("free");
  const [prompt, setPrompt] = useState(SAMPLE_PROMPTS.free[0]);
  const [round, setRound] = useState(0);
  const [targets, setTargets] = useState<string[]>(() => initialTargets?.length ? initialTargets : suggestTargets(data.history.active, data.cards, data.byId, 6).map((entry) => entry.id));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const pickGenre = (next: WritingGenre) => {
    setGenre(next);
    if (SAMPLE_PROMPTS[genre].includes(prompt) || !prompt.trim()) setPrompt(SAMPLE_PROMPTS[next][0]);
  };
  return (
    <main className="writing-stage writing-setup">
      <h1 ref={heading} tabIndex={-1}>写什么</h1>
      <div className="segmented-control writing-genres" role="group" aria-label="文体">
        {(Object.keys(WRITING_GENRES) as WritingGenre[]).map((key) => (
          <button key={key} aria-pressed={genre === key} onClick={() => pickGenre(key)}>{WRITING_GENRES[key].label}</button>
        ))}
      </div>
      <p className="ai-note">{WRITING_GENRES[genre].detail}，目标 {WRITING_GENRES[genre].range[0]}–{WRITING_GENRES[genre].range[1]} 词。</p>
      <label className="ai-field">
        <span>{genre === "continuation" ? "原文与两段段首句" : "题目要求"}</span>
        <textarea rows={genre === "continuation" ? 8 : 3} maxLength={4000} value={prompt} onChange={(event) => setPrompt(event.target.value)}
          placeholder={genre === "continuation" ? "粘贴读后续写的原文和两段开头句，AI 会据此评价衔接与情节。" : undefined} />
      </label>
      <div className="writing-samples">
        <span>换个题目：</span>
        {SAMPLE_PROMPTS[genre].map((sample, i) => sample !== prompt && <button key={i} className="text-button" onClick={() => setPrompt(sample)}>示例 {i + 1}</button>)}
      </div>
      <section className="writing-targets-setup" aria-labelledby="targets-title">
        <div className="writing-targets-head">
          <h2 id="targets-title">目标词</h2>
          <button className="text-button" onClick={() => {
            const next = suggestTargets(data.history.active, data.cards, data.byId, 6 * (round + 2)).slice((round + 1) * 6);
            if (next.length) { setRound(round + 1); setTargets(next.map((entry) => entry.id)); }
            else data.notify("没有更多最近学过的词了。");
          }}><RefreshCw size={14} aria-hidden="true" />换一组</button>
        </div>
        {targets.length ? (
          <p className="writing-line">
            {targets.map((id) => (
              <button key={id} className="english" aria-label={`移除 ${data.byId.get(id)?.headword}`} onClick={() => setTargets(targets.filter((item) => item !== id))}>
                {data.byId.get(id)?.headword}<X size={13} aria-hidden="true" />
              </button>
            ))}
          </p>
        ) : <p className="ai-note">没有目标词也可以写；先学几个词，这里会推荐最近学过和答错的词。</p>}
      </section>
      <button className="primary writing-begin" disabled={!prompt.trim()} onClick={() => onCreate(newWriting(genre, targets, prompt.trim()))}>开始写作</button>
    </main>
  );
}

function WritingEditor({ record, data, onSave, onPractice, onWord }: {
  record: WritingRecord; data: Vocabulary; onSave: (record: WritingRecord) => void;
  onPractice: (entries: LexiconIndexEntry[]) => void; onWord: (entry: LexiconIndexEntry) => void;
}) {
  const current = latestVersion(record);
  const [text, setText] = useState(current.text);
  const [mode, setMode] = useState<"write" | "review">(current.review ? "review" : "write");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(true);
  const latest = useRef(record);
  useEffect(() => { latest.current = record; }, [record]);
  const profile = useLearnerProfile(data);
  const seconds = useElapsed(reviewing);
  const targets = useMemo(() => record.targetIds.flatMap((id) => (data.byId.get(id) ? [data.byId.get(id)!] : [])), [record.targetIds, data.byId]);
  const uses = useMemo(() => findTargetUses(text, targets), [text, targets]);
  const checks = useMemo(() => localWritingChecks(text, uses, record.wordRange), [text, uses, record.wordRange]);
  const words = countWords(text);

  const persist = useCallback(async (next: WritingRecord) => {
    try { await saveWriting(next); onSave(next); latest.current = next; setSaved(true); }
    catch { data.notify("草稿未能保存到本机，请复制文字后重试。"); }
  }, [onSave, data]);

  // Drafts save themselves shortly after typing stops, and on leaving.
  useEffect(() => {
    if (text === latestVersion(latest.current).text) return;
    setSaved(false);
    const timer = setTimeout(() => {
      const base = latest.current;
      const versions = [...base.versions];
      const last = versions[versions.length - 1];
      // A reviewed version stays as it was; new edits start the next version.
      if (last.review) versions.push({ id: createLocalId(), text, savedAt: new Date().toISOString(), review: null });
      else versions[versions.length - 1] = { ...last, text, savedAt: new Date().toISOString() };
      void persist({ ...base, versions, updatedAt: new Date().toISOString() });
    }, 700);
    return () => clearTimeout(timer);
  }, [text, persist]);

  const review = async () => {
    setError("");
    setReviewing(Date.now());
    try {
      const base = latest.current;
      const versions = [...base.versions];
      const last = versions[versions.length - 1];
      if (last.review) versions.push({ id: createLocalId(), text, savedAt: new Date().toISOString(), review: null });
      else versions[versions.length - 1] = { ...last, text, savedAt: new Date().toISOString() };
      const input = { genre: base.genre, prompt: base.prompt, essay: text, wordIds: base.targetIds };
      const answer = await runAssistant("review-essay", input, { profile: await profile() });
      const at = versions.length - 1;
      versions[at] = { ...versions[at], review: { reviewedAt: answer.cachedAt || new Date().toISOString(), model: answer.model, result: answer.result } };
      await persist({ ...base, versions, updatedAt: new Date().toISOString() });
      setMode("review");
    } catch (cause) {
      setError(cause instanceof AssistantError || cause instanceof Error ? cause.message : "批改失败，可以稍后重试。");
    } finally {
      setReviewing(null);
    }
  };

  const reviewedVersions = record.versions.filter((version) => version.review);
  const shown = reviewedVersions[reviewedVersions.length - 1];

  if (mode === "review" && shown?.review) {
    const previous = reviewedVersions.length > 1 ? reviewedVersions[reviewedVersions.length - 2].review!.result : null;
    return (
      <main className="writing-stage writing-review-stage">
        <EssayReview essay={shown.text} result={shown.review.result} previous={previous} targets={targets} words={data.byId}
          reviewedAt={shown.review.reviewedAt} onWord={onWord}
          onPractice={(ids) => onPractice(ids.flatMap((id) => (data.byId.get(id) ? [data.byId.get(id)!] : [])))} />
        <div className="writing-actions">
          <button className="primary" onClick={() => { setText(latestVersion(latest.current).text); setMode("write"); }}>在这一版上修改</button>
          <span className="ai-note">第 {record.versions.indexOf(shown) + 1} 版 · 共 {record.versions.length} 版</span>
        </div>
      </main>
    );
  }

  return (
    <main className="writing-stage writing-editor">
      <div className="writing-paper">
        <p className="writing-prompt-text">{record.prompt}</p>
        <label className="sr-only" htmlFor="essay">作文正文</label>
        <textarea id="essay" className="writing-textarea" lang="en" spellCheck={false} autoCapitalize="sentences"
          value={text} onChange={(event) => setText(event.target.value)} placeholder="Start writing here…" maxLength={8000} />
        <p className="writing-count" aria-live="polite">
          <span className="learn-tabular">{words}</span> 词 · 目标 {record.wordRange[0]}–{record.wordRange[1]}
          <span>{saved ? "已保存在本机" : "正在保存…"}</span>
        </p>
      </div>
      <aside className="writing-rail" aria-label="写作提示">
        <section>
          <h2>目标词</h2>
          {targets.length ? (
            <ul className="writing-checklist">
              {uses.map((use) => (
                <li key={use.id} data-used={use.count > 0}>
                  <span className="writing-tick" aria-hidden="true">{use.count > 0 && <Check size={13} />}</span>
                  <button className="english" onClick={() => onWord(data.byId.get(use.id)!)}>{use.headword}</button>
                  <span className="sr-only">{use.count ? `已用 ${use.count} 次` : "还没用"}</span>
                  {use.count > 1 && <small aria-hidden="true">×{use.count}</small>}
                </li>
              ))}
            </ul>
          ) : <p className="ai-note">这篇没有指定目标词。</p>}
        </section>
        <section>
          <h2>本机检查</h2>
          <ul className="writing-checks">
            {checks.map((check) => <li key={check.id} data-level={check.level}>{check.message}</li>)}
          </ul>
        </section>
        <section className="writing-ai">
          {data.settings.aiEnabled ? (
            reviewing !== null ? (
              <div className="ai-status" role="status"><span className="ai-spinner" aria-hidden="true" />AI 正在批改{seconds >= 3 ? `… ${seconds} 秒` : "…"}{seconds >= 20 ? "（完整批改约需一两分钟）" : ""}</div>
            ) : (
              <>
                <button className="primary" disabled={countWords(text) < 5} onClick={review}><Sparkles size={16} aria-hidden="true" />AI 批改</button>
                {shown && <button className="text-button" onClick={() => setMode("review")}>看上次批改</button>}
              </>
            )
          ) : <p className="ai-note">在“设置 → AI 接口”开启后，可以让 AI 批改作文。</p>}
          {error && <p className="ai-status is-error" role="alert">{error}</p>}
        </section>
      </aside>
    </main>
  );
}
