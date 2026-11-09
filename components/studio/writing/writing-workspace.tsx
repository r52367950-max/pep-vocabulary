"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, BookOpen, Check, ChevronRight, Pencil, Plus, RefreshCw, Search, Shuffle, Sparkles, Trash2, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { recordLearningActivity } from "@/lib/learning-journal-client";
import { runAssistant, AssistantError } from "@/lib/ai-client";
import { learningContextStore, refreshLearningContext, contextStillCurrent } from "@/lib/learning-context-client";
import { captureWritingContext, writingContextCurrent, writeWritingInContext, WritingContextChangedError, type WritingContext } from "@/lib/writing-context";
import { deleteWriting, listWritings, saveWriting, createLocalId, type WritingGenre, type WritingRecord } from "@/lib/storage";
import { countWords, findTargetUses, latestVersion, localWritingChecks, newWriting, suggestTargets, WRITING_GENRES, writingTitle } from "@/lib/writing";
import { mergeTargetIds } from "@/lib/writing-targets";
import { StudioSymbol } from "../symbol";
import { ActionMenu } from "../action-menu";
import { StudioDialog } from "../studio-dialog";
import { useElapsed, useLearnerProfile } from "../ai/use-assistant";
import EssayReview from "./essay-review";
import HandwritingUpload, { HandwritingAssessment } from "./handwriting-upload";
import TargetWordPicker from "./target-word-picker";
import type { WritingHandwritingAssessment } from "@/lib/writing-recognition";
import { WRITING_TOPICS, recommendWritingTopic, randomWritingTopic, topicPrompt, validWritingTopic, type WritingTopic } from "@/lib/writing-topics";

type View = { kind: "list" } | { kind: "setup" } | { kind: "edit"; id: string };
const WRITING_LOAD_ERROR = "写作记录暂时无法读取，请检查浏览器存储权限后重试。请重新读取后确认最新状态。";

export default function WritingWorkspace({ data, initialTargets, openId, onExit, onPractice, onWord }: {
  data: Vocabulary;
  initialTargets?: string[];
  openId?: string | null;
  onExit: () => void;
  onPractice: (entries: LexiconIndexEntry[]) => void;
  onWord: (entry: LexiconIndexEntry) => void;
}) {
  const policy = useSyncExternalStore(learningContextStore.subscribe, learningContextStore.get, learningContextStore.getServerSnapshot);
  const [boundary, setBoundary] = useState(() => ({ scope: policy.memory?.accountScope ?? null as string | null, temporary: policy.temporary, serial: 0 }));
  const scope = policy.memory?.accountScope;
  if (boundary.temporary !== policy.temporary || (scope && scope !== boundary.scope)) {
    const changed = boundary.temporary !== policy.temporary || Boolean(scope && boundary.scope && scope !== boundary.scope);
    // Adjust render state before committing children. An initial account lookup keeps its seed;
    // a pending lookup keeps the last known scope, so a later account switch still resets it.
    setBoundary({ scope: scope || boundary.scope, temporary: policy.temporary, serial: boundary.serial + (changed ? 1 : 0) });
  }
  // A mode/account boundary starts a fresh workspace: temporary drafts never become delayed saves.
  return <WritingWorkspaceSession key={boundary.serial} data={data} initialTargets={policy.temporary ? [] : boundary.serial ? undefined : initialTargets} openId={policy.temporary || boundary.serial ? null : openId} onExit={onExit} onPractice={onPractice} onWord={onWord} temporary={policy.temporary} />;
}

function WritingWorkspaceSession({ data, initialTargets, openId, onExit, onPractice, onWord, temporary }: {
  data: Vocabulary; initialTargets?: string[]; openId?: string | null; onExit: () => void;
  onPractice: (entries: LexiconIndexEntry[]) => void; onWord: (entry: LexiconIndexEntry) => void; temporary: boolean;
}) {
  const [records, setRecords] = useState<WritingRecord[] | null>(null);
  const [loadError, setLoadError] = useState("");
  // An open editor belongs to the dataset it read; preserve its text when another page restores data.
  const [generation] = useState(() => data.generation);
  const [view, setView] = useState<View>(openId ? { kind: "edit", id: openId } : initialTargets ? { kind: "setup" } : { kind: "list" });
  const readVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const rows = temporary ? [] : await listWritings();
      if (version === readVersion.current) {
        setLoadError("");
        setRecords(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
    } catch (cause) {
      if (version === readVersion.current) setLoadError(WRITING_LOAD_ERROR);
      throw cause;
    }
  }, [temporary]);
  useEffect(() => {
    let active = true;
    const version = ++readVersion.current;
    (temporary ? Promise.resolve([]) : listWritings()).then((rows) => {
      if (active && version === readVersion.current) {
        setRecords(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setLoadError("");
      }
    }).catch(() => {
      if (active && version === readVersion.current) setLoadError(WRITING_LOAD_ERROR);
    });
    return () => { active = false; };
  }, [temporary]);

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
        {view.kind === "list" && <button className="secondary writing-new" disabled={records === null} onClick={() => setView({ kind: "setup" })}><Plus size={16} aria-hidden="true" />新写一篇</button>}
      </header>
      {temporary && <p className="ai-note writing-stage" style={{ paddingBottom: 8 }} role="status">临时写作：本次草稿与批改不保存，切换模式后不会补存。需要保留原文时请先复制。</p>}
      {loadError && <div className="learn-pending" role="alert"><p>{loadError}</p><button className="secondary" onClick={() => void reload().catch(() => undefined)}>重新读取</button></div>}
      {records === null ? !loadError && <div className="learn-pending" role="status">正在读取写作记录…</div>
        : view.kind === "list" ? <WritingList records={records} data={data} onOpen={(id) => setView({ kind: "edit", id })} onDelete={async (record) => { try { await deleteWriting(record, generation); await reload(); } catch (cause) { data.notify(cause instanceof Error ? cause.message : "移除失败，请重试。"); await reload().catch(() => undefined); } }} />
          : view.kind === "setup" ? <WritingSetup key={data.generation} data={data} initialTargets={initialTargets} temporary={temporary} recentTitles={(records || []).map(item => item.title || item.prompt.slice(0, 120))} onCreate={async (created) => { const context = captureWritingContext(); await writeWritingInContext(context, () => saveWriting(created, null, generation)); if (!writingContextCurrent(context)) return; upsert(created); setView({ kind: "edit", id: created.id }); }} />
            : record ? <WritingEditor key={record.id} record={record} data={data} generation={generation} onSave={upsert} onPractice={onPractice} onWord={onWord} temporary={temporary} />
              : <div className="learn-pending">这篇写作已不存在。</div>}
    </div>
  );
}

function WritingList({ records, data, onOpen, onDelete }: { records: WritingRecord[]; data: Vocabulary; onOpen: (id: string) => void; onDelete: (record: WritingRecord) => void }) {
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
                  onClick={() => { if (window.confirm("删除这篇写作及其全部版本和批改？此操作不能撤销。")) onDelete(record); }}>
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

function WritingSetup({ data, initialTargets, onCreate, temporary, recentTitles }: { data: Vocabulary; initialTargets?: string[]; recentTitles: string[]; onCreate: (record: WritingRecord) => Promise<void>; temporary: boolean }) {
  const initialTargetIds = () => temporary ? [] : mergeTargetIds([], initialTargets?.length ? initialTargets : suggestTargets(data.history.active, data.cards, data.byId, 6).map(entry => entry.id), data.byId);
  const topicContext = (ids: string[]) => {
    const entries = temporary ? [] : ids.flatMap(id => data.byId.get(id) ? [data.byId.get(id)!] : []);
    return { wordIds: entries.flatMap(entry => [entry.id, entry.headword]), bookIds: [...new Set(entries.flatMap(entry => entry.sources.map(source => source.bookId)))], units: [...new Set(entries.flatMap(entry => entry.sources.map(source => source.unit)))], recentTitles: temporary ? [] : recentTitles };
  };
  const [genre, setGenre] = useState<WritingGenre>("free");
  const [topic, setTopic] = useState<WritingTopic>(() => recommendWritingTopic("free", topicContext(initialTargetIds())));
  const [prompt, setPrompt] = useState(() => topicPrompt(topic));
  const [generating, setGenerating] = useState(false);
  const [dialog, setDialog] = useState<"library" | "edit" | "targets" | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");
  const topicRequest = useRef<AbortController | null>(null);
  const topicSequence = useRef(0);
  useEffect(() => () => { topicSequence.current++; topicRequest.current?.abort(); }, []);
  const cancelGeneration = () => { topicSequence.current++; topicRequest.current?.abort(); topicRequest.current = null; setGenerating(false); };
  const chooseTopic = (next: WritingTopic) => { cancelGeneration(); setTopic(next); setPrompt(topicPrompt(next)); setCreateError(""); };
  const [round, setRound] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createPending = useRef(false);
  const [targets, setTargets] = useState<string[]>(initialTargetIds);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  const pickGenre = (next: WritingGenre) => { setGenre(next); chooseTopic(recommendWritingTopic(next, topicContext(targets))); };
  const generate = async () => {
    if (topicRequest.current) return;
    const controller = new AbortController(), sequence = ++topicSequence.current; topicRequest.current = controller; setGenerating(true); setCreateError("");
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const memory = await refreshLearningContext(controller.signal);
      if (!contextStillCurrent(memory, temporary)) return;
      const response = await fetch("/api/writing/generate-topic", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ operationId: crypto.randomUUID(), kind: genre, temporary, accountScope: memory.accountScope, contextRevision: memory.revision, contextVersion: memory.contextVersion }) });
      const answer = await response.json();
      if (!response.ok) throw new Error(typeof answer?.error === "string" ? answer.error : answer?.error?.message || "出题失败，请稍后重试。");
      await refreshLearningContext(controller.signal);
      if (controller.signal.aborted || sequence !== topicSequence.current || !contextStillCurrent(memory, temporary)) return;
      if (!validWritingTopic(answer.topic) || answer.topic.kind !== genre) throw new Error("题目不完整，请重新出题。");
      setTopic(answer.topic); setPrompt(topicPrompt(answer.topic));
    } catch (cause) { if (sequence === topicSequence.current) setCreateError(controller.signal.aborted ? "出题已取消或超时。" : cause instanceof Error ? cause.message : "出题失败。"); }
    finally { clearTimeout(timeout); if (sequence === topicSequence.current) { topicRequest.current = null; setGenerating(false); } }
  };
  return (
    <main className="writing-stage writing-setup">
      <h1 ref={heading} tabIndex={-1}>写什么</h1>
      <div className="segmented-control writing-genres" role="group" aria-label="文体">
        {(Object.keys(WRITING_GENRES) as WritingGenre[]).map((key) => (
          <button key={key} aria-pressed={genre === key} onClick={() => pickGenre(key)}>{WRITING_GENRES[key].label}</button>
        ))}
      </div>
      <section className="writing-topic-card" aria-label="本次写作题目">
        <div className="writing-topic-heading">
          <div className="writing-topic-meta"><span>{topic.cefr}</span><span>{topic.wordMin}–{topic.wordMax} 词</span></div>
          <ActionMenu label="题目选项" items={[
            { label: "从题库选择…", icon: <BookOpen size={17} />, onSelect: () => setDialog("library") },
            { label: "调整题目…", icon: <Pencil size={17} />, onSelect: () => { setDraftPrompt(prompt); setDialog("edit"); } },
            { label: "按进度推荐", icon: <RefreshCw size={17} />, separator: true, onSelect: () => chooseTopic(recommendWritingTopic(genre, { ...topicContext(targets), recentTitles: [...recentTitles, topic.title], recentTopicIds: [topic.id] })) },
            { label: "随机换题", icon: <Shuffle size={17} />, onSelect: () => chooseTopic(randomWritingTopic(genre, topic.id)) },
            { label: "AI 出题", icon: <Sparkles size={17} />, disabled: !data.settings.aiEnabled || generating, onSelect: () => void generate() },
          ]} />
        </div>
        <h2>{prompt === topicPrompt(topic) ? topic.title : "自定义题目"}</h2>
        <p className="writing-topic-text">{prompt}</p>
        {generating && <div className="writing-topic-actions" role="status"><span>正在出题…</span><button className="text-button" onClick={cancelGeneration}>取消</button></div>}
      </section>
      <section className="writing-targets-setup" aria-labelledby="targets-title">
        <div className="writing-targets-head">
          <h2 id="targets-title">目标词</h2>
          <div className="writing-target-actions">
            <button className="text-button" onClick={() => setDialog("targets")}><Plus size={16} aria-hidden="true" />添加词</button>
            <ActionMenu label="词语选项" items={[
              { label: "换一组推荐词", icon: <RefreshCw size={17} />, disabled: temporary, onSelect: () => {
                const next = suggestTargets(data.history.active, data.cards, data.byId, 6 * (round + 2)).slice((round + 1) * 6);
                if (next.length) { setRound(round + 1); setTargets(next.map((entry) => entry.id)); }
                else data.notify("没有更多最近学过的词了。");
              } },
              { label: "清空目标词", icon: <Trash2 size={17} />, disabled: !targets.length, onSelect: () => setTargets([]) },
            ]} />
          </div>
        </div>
        {targets.length ? (
          <p className="writing-line">
            {targets.map((id) => (
              <button key={id} className="english" aria-label={`移除 ${data.byId.get(id)?.headword}`} onClick={() => setTargets(targets.filter((item) => item !== id))}>
                {data.byId.get(id)?.headword}<X size={13} aria-hidden="true" />
              </button>
            ))}
          </p>
        ) : <p className="ai-note">从词库添加想练习的词。</p>}
      </section>
      {dialog === "library" && <WritingTopicPicker genre={genre} currentId={topic.id} onClose={() => setDialog(null)} onChoose={next => { chooseTopic(next); setDialog(null); }} />}
      {dialog === "edit" && <StudioDialog title="调整题目" className="writing-topic-edit" onClose={() => setDialog(null)} footer={<><button className="secondary" onClick={() => setDialog(null)}>取消</button><button className="primary" disabled={!draftPrompt.trim() || draftPrompt.length > 4000} onClick={() => { cancelGeneration(); setPrompt(draftPrompt.trim()); setCreateError(""); setDialog(null); }}>使用题目</button></>}>
        <label className="ai-field"><span>{genre === "continuation" ? "原文与两段段首句" : "题目要求"}</span><textarea autoFocus rows={genre === "continuation" ? 14 : 9} maxLength={4000} value={draftPrompt} onChange={event => setDraftPrompt(event.target.value)} /></label>
        <p className="ai-note writing-topic-edit-count">{draftPrompt.length} / 4000</p>
      </StudioDialog>}
      {dialog === "targets" && <TargetWordPicker data={data} selectedIds={targets} onAdd={ids => { setTargets(current => mergeTargetIds(current, ids, data.byId)); setDialog(null); }} onClose={() => setDialog(null)} />}
      {createError && <p className="ai-status is-error" role="alert">{createError}</p>}
      <button className="primary writing-begin" disabled={!prompt.trim() || prompt.length > 4000 || creating || generating} onClick={async () => {
        if (createPending.current) return;
        createPending.current = true; setCreating(true); setCreateError("");
        try { const created = newWriting(genre, targets, prompt.trim()); if (prompt === topicPrompt(topic)) created.title = topic.title; created.wordRange = [topic.wordMin, topic.wordMax]; await onCreate(created); }
        catch (cause) { setCreateError(cause instanceof Error ? cause.message : "未能开始写作，请重试。"); }
        finally { createPending.current = false; setCreating(false); }
      }}>{creating ? "正在准备…" : "开始写作"}</button>
    </main>
  );
}

function WritingTopicPicker({ genre, currentId, onChoose, onClose }: {
  genre: WritingGenre; currentId: string; onChoose: (topic: WritingTopic) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const topics = WRITING_TOPICS.filter(item => item.kind === genre && (!search || [item.title, item.prompt, item.cefr, ...item.themes, ...item.skills].join(" ").toLocaleLowerCase().includes(search)));
  return <StudioDialog title="从题库选择" className="writing-topic-picker" onClose={onClose} footer={<button className="secondary" onClick={onClose}>取消</button>}>
    <div className="writing-topic-search">
      <Search size={18} aria-hidden="true" />
      <input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索写作题目" placeholder="搜索题目、主题或难度" />
    </div>
    <p className="ai-note" role="status">{WRITING_GENRES[genre].label} · {topics.length} 题</p>
    {topics.length ? <ul className="writing-topic-results">{topics.map(item => <li key={item.id}>
      <button className="writing-topic-choice" aria-pressed={item.id === currentId} onClick={() => onChoose(item)}>
        <span><strong lang="en">{item.title}</strong><small>{item.cefr} · {item.wordMin}–{item.wordMax} 词</small><span lang="en">{item.prompt}</span></span>
        {item.id === currentId && <Check size={20} aria-hidden="true" />}
      </button>
    </li>)}</ul> : <div className="writing-topic-empty"><p>没有找到相关题目</p><button className="text-button" onClick={() => setQuery("")}>清除搜索</button></div>}
  </StudioDialog>;
}

function WritingEditor({ record, data, generation, onSave, onPractice, onWord, temporary }: {
  record: WritingRecord; data: Vocabulary; generation: string; onSave: (record: WritingRecord) => void;
  onPractice: (entries: LexiconIndexEntry[]) => void; onWord: (entry: LexiconIndexEntry) => void; temporary: boolean;
}) {
  const current = latestVersion(record);
  const [text, setText] = useState(current.text);
  const [mode, setMode] = useState<"write" | "review">(current.review ? "review" : "write");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "failed">("saved");
  const [uploadBusy, setUploadBusy] = useState(false);
  const latest = useRef(record);
  const committed = useRef(record);
  const saveFailed = useRef(false);
  const writes = useRef(Promise.resolve());
  const reviewController = useRef<AbortController | null>(null);
  const reviewContext = useRef<WritingContext | null>(null);
  useEffect(() => {
    const unsubscribe = learningContextStore.subscribe(() => {
      if (reviewContext.current && !writingContextCurrent(reviewContext.current)) {
        reviewController.current?.abort(); reviewController.current = null; reviewContext.current = null;
        setReviewing(null); setError(new WritingContextChangedError().message);
      }
    });
    return () => { reviewController.current?.abort(); unsubscribe(); };
  }, []);
  const profile = useLearnerProfile(data);
  const seconds = useElapsed(reviewing);
  const targets = useMemo(() => record.targetIds.flatMap((id) => (data.byId.get(id) ? [data.byId.get(id)!] : [])), [record.targetIds, data.byId]);
  const uses = useMemo(() => findTargetUses(text, targets), [text, targets]);
  const checks = useMemo(() => localWritingChecks(text, uses, record.wordRange), [text, uses, record.wordRange]);
  const words = countWords(text);

  const persist = useCallback((next: WritingRecord, context = captureWritingContext(), signal?: AbortSignal) => {
    if (signal?.aborted || !writingContextCurrent(context)) return Promise.reject(new WritingContextChangedError());
    latest.current = next;
    if (temporary) { onSave(next); setSaveStatus("saved"); return Promise.resolve(); }
    setSaveStatus(saveFailed.current ? "failed" : "saving");
    // Queue writes immediately, including the last keystroke before leaving the editor.
    const pending = writes.current.then(async () => {
      if (saveFailed.current) throw new Error("草稿尚未保存。请复制当前文字后重新打开，避免覆盖其他页面的修改。");
      await writeWritingInContext(context, () => saveWriting(next, committed.current, generation), signal);
      committed.current = next;
      if (!writingContextCurrent(context) || signal?.aborted) return;
      onSave(next);
      if (latest.current === next) setSaveStatus("saved");
    });
    writes.current = pending.catch((cause) => {
      if (cause instanceof WritingContextChangedError) return;
      saveFailed.current = true;
      setSaveStatus("failed");
      const message = cause instanceof Error ? cause.message : "草稿未能保存到本机，请复制文字后重试。";
      setError(message);
      data.notify(message);
    });
    return pending;
  }, [onSave, data, temporary, generation]);

  const edit = (value: string) => {
    if (reviewController.current) return;
    const base = latest.current;
    const versions = [...base.versions];
    const last = versions[versions.length - 1];
    if (last.review && versions.length >= 30) {
      data.notify("这篇作文已有 30 个版本，请新建一篇继续修改。");
      return;
    }
    setText(value);
    if (last.review) versions.push({ id: createLocalId(), text: value, savedAt: new Date().toISOString(), review: null });
    else versions[versions.length - 1] = { id: last.id, text: value, savedAt: new Date().toISOString(), review: null };
    void persist({ ...base, versions, updatedAt: new Date().toISOString() }).catch(() => undefined);
  };

  const review = async () => {
    if (reviewController.current) return;
    const controller = new AbortController();
    reviewController.current = controller;
    setError("");
    setReviewing(Date.now());
    try {
      const memory = await refreshLearningContext(controller.signal);
      if (controller.signal.aborted) return;
      const context = captureWritingContext(); reviewContext.current = context;
      const base = latest.current;
      const versions = [...base.versions];
      const last = versions[versions.length - 1];
      versions[versions.length - 1] = { ...last, text, savedAt: new Date().toISOString() };
      await persist({ ...base, versions, updatedAt: new Date().toISOString() }, context, controller.signal);
      if (controller.signal.aborted) return;
      const input = { genre: base.genre, prompt: base.prompt, essay: text, wordIds: base.targetIds };
      const answer = await runAssistant("review-essay", input, { profile: temporary ? null : await profile(), signal: controller.signal, activity: false });
      if (controller.signal.aborted || !contextStillCurrent(memory, temporary) || !writingContextCurrent(context)) return;
      const at = versions.length - 1;
      versions[at] = { ...versions[at], review: { reviewedAt: answer.cachedAt || new Date().toISOString(), model: answer.model, result: answer.result } };
      await persist({ ...base, versions, updatedAt: new Date().toISOString() }, context, controller.signal);
      if (controller.signal.aborted || !writingContextCurrent(context)) return;
      if (!temporary) void recordLearningActivity({ eventId: `writing-${base.id}-${versions[at].id}`, kind: "writing", title: `${WRITING_GENRES[base.genre].label}写作练习`, summary: "完成写作与反馈，练习目标词的运用。", refIds: base.targetIds.slice(0, 20), counts: { reviewed: 1, words: countWords(text) } }, { accountScope: memory.accountScope });
      setMode("review");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof AssistantError || cause instanceof Error ? cause.message : "批改失败，可以稍后重试。");
    } finally {
      if (reviewController.current === controller) { reviewController.current = null; reviewContext.current = null; setReviewing(null); }
    }
  };

  const reviewedVersions = record.versions.filter((version) => version.review);
  const shown = reviewedVersions[reviewedVersions.length - 1];

  if (mode === "review" && shown?.review) {
    const previous = reviewedVersions.length > 1 ? reviewedVersions[reviewedVersions.length - 2].review!.result : null;
    return (
      <main className="writing-stage writing-review-stage">
        <EssayReview essay={shown.text} result={shown.review.result} previous={previous} targets={targets} words={data.byId}
          reviewedAt={shown.review.reviewedAt} handwriting={shown.handwriting} onWord={onWord}
          onPractice={(ids) => onPractice(ids.flatMap((id) => (data.byId.get(id) ? [data.byId.get(id)!] : [])))} />
        <div className="writing-actions">
          <button className="primary" onClick={() => { setText(latestVersion(latest.current).text); setMode("write"); }}>在这一版上修改</button>
          <span className="ai-note">第 {record.versions.indexOf(shown) + 1} 版 · 共 {record.versions.length} 版</span>
        </div>
      </main>
    );
  }

  return (
    <main className={`writing-stage writing-editor${uploadBusy ? " is-uploading" : ""}`}>
      <div className="writing-paper">
        <p className="writing-prompt-text">{record.prompt}</p>
        {data.settings.aiEnabled && <HandwritingUpload key={data.generation} temporary={temporary} disabled={reviewing !== null || data.generation !== generation} hasText={Boolean(text.trim())} onBusy={setUploadBusy} onConfirm={async (confirmedText: string, handwriting: WritingHandwritingAssessment, context: WritingContext) => {
          if (reviewController.current || data.generation !== generation || !writingContextCurrent(context)) throw new WritingContextChangedError();
          const base = latest.current, versions = [...base.versions], last = versions[versions.length - 1];
          const version = { id: last.review || last.text.trim() ? createLocalId() : last.id, text: confirmedText, savedAt: new Date().toISOString(), review: null, handwriting };
          if (last.review || last.text.trim()) { if (versions.length >= 30) throw new Error("已达到 30 个版本，请新建一篇导入。"); versions.push(version); } else versions[versions.length - 1] = version;
          await persist({ ...base, versions, updatedAt: new Date().toISOString() }, context);
          if (writingContextCurrent(context)) setText(confirmedText);
        }} />}
        {current.handwriting && !uploadBusy && <HandwritingAssessment assessment={current.handwriting} />}
        <label className="sr-only" htmlFor="essay">作文正文</label>
        <textarea id="essay" className="writing-textarea" lang="en" spellCheck={false} autoCapitalize="sentences"
          value={text} readOnly={reviewing !== null || uploadBusy} onChange={(event) => edit(event.target.value)} placeholder="Start writing here…" maxLength={8000} />
        <p className="writing-count" aria-live="polite">
          <span className="learn-tabular">{words}</span> 词 · 目标 {record.wordRange[0]}–{record.wordRange[1]}
          <span>{temporary ? "临时草稿 · 不保存记录" : saveStatus === "saved" ? "已保存在本机" : saveStatus === "failed" ? "尚未保存，请复制保留文字" : "正在保存…"}</span>
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
              <div className="ai-status" role="status"><span className="ai-spinner" aria-hidden="true" />AI 正在批改{seconds >= 3 ? `… ${seconds} 秒` : "…"}{seconds >= 20 ? "（完整批改约需一两分钟）" : ""}<button className="text-button" onClick={() => { reviewController.current?.abort(); reviewController.current = null; reviewContext.current = null; setReviewing(null); }}>取消批改</button></div>
            ) : (
              <>
                <button className="primary" disabled={countWords(text) < 5 || uploadBusy} onClick={review}><Sparkles size={16} aria-hidden="true" />AI 批改</button>
                {shown && <button className="text-button" disabled={uploadBusy} onClick={() => setMode("review")}>看上次批改</button>}
              </>
            )
          ) : <p className="ai-note">在“设置 → AI 接口”开启后，可以让 AI 批改作文。</p>}
          {error && <p className="ai-status is-error" role="alert">{error}</p>}
        </section>
      </aside>
    </main>
  );
}
