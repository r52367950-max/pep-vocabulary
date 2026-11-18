"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useId } from "react";
import { Check, Plus, Trash2 } from "lucide-react";

import { learningContextStore, localProfileAllowed, setLocalProfileAllowed, refreshLearningContext, saveLearningMemory, setTemporaryMode, type LearningMemory, type LearningNote } from "@/lib/learning-context-client";
import { learningJournalStore, refreshLearningJournal, updateLearningJournal, deleteLearningJournal } from "@/lib/learning-journal-client";
export type { LearningMemory } from "@/lib/learning-context-client";

export function useLearningMemory() {
  const context = useSyncExternalStore(learningContextStore.subscribe, learningContextStore.get, learningContextStore.getServerSnapshot);
  const memory = context.memory;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    try { await refreshLearningContext(abort.signal); if (mounted.current && !abort.signal.aborted) setError(""); }
    catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "学习记忆暂时无法读取。"); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (context.memory || context.error || pending.current) return;
    const abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    // Fetch is an external subscription; state changes only after it settles.
    void refreshLearningContext(abort.signal).then(
      () => { if (mounted.current && !abort.signal.aborted) setError(""); },
      (cause) => { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "学习记忆暂时无法读取。"); },
    );
    return () => abort.abort();
  }, [context.epoch, context.memory, context.error]);
  const save = useCallback(async (next: LearningMemory) => {
    if (pending.current || learningContextStore.get().temporary) return false;
    pending.current = true; setBusy(true); setError("");
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    try { await saveLearningMemory(next, abort.signal); return mounted.current && !abort.signal.aborted; }
    catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "记忆没有保存，请重试。"); return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const remember = useCallback(async (text: string, source: LearningNote["source"] = "confirmed_suggestion") => {
    if (!memory || context.temporary) { setError("请退出临时练习并读取学习记忆，再保存。"); return false; }
    if (memory.notes.some((note) => note.text === text.trim())) return true;
    if (memory.notes.length >= 20) { setError("已保存 20 条，请整理后再添加。"); return false; }
    return save({ ...memory, notes: [...memory.notes, { id: crypto.randomUUID(), text: text.trim().slice(0, 400), source, kind: "learning_note" }] });
  }, [memory, context.temporary, save]);
  const rememberTopic = useCallback(async (title: string) => {
    if (pending.current || learningContextStore.get().temporary) return false;
    try {
      const current = await refreshLearningContext();
      if (!mounted.current || pending.current || !current.enabled || learningContextStore.get().temporary) return false;
      return save({ ...current, recentTopics: [title, ...current.recentTopics.filter((item) => item !== title)].slice(0, 12) });
    } catch { return false; }
  }, [save]);
  const setProfileAllowed = useCallback(async (allowed: boolean) => { try { await setLocalProfileAllowed(allowed); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "未能保存这个选择。"); } }, []);
  return { memory, error: error || context.error, busy, load, save, remember, rememberTopic, temporary: context.temporary, setTemporary: setTemporaryMode, epoch: context.epoch, localProfileEnabled: localProfileAllowed(memory), setProfileAllowed };
}

type MemoryControls = ReturnType<typeof useLearningMemory>;
export function LearningMemoryPanel(props: { controls: MemoryControls; disabled?: boolean }) {
  // Account/mode changes unmount the draft state before any new account can see
  // or submit it. A revision update for the same account retains unfinished edits.
  const { memory, temporary } = props.controls;
  const [scope, setScope] = useState(memory?.accountScope ?? "unloaded");
  if (memory && memory.accountScope !== scope) setScope(memory.accountScope);
  return <LearningMemoryForm key={`${scope}:${temporary}`} {...props} />;
}

function LearningMemoryForm({ controls, disabled = false }: { controls: MemoryControls; disabled?: boolean }) {
  const { memory, error, busy, load, save, remember, temporary, setTemporary, localProfileEnabled, setProfileAllowed } = controls;
  const [newNote, setNewNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<LearningNote | null>(null);
  const blocked = disabled || busy || temporary;
  const noteId = useId();
  return <details className="voice-memory voice-disclosure">
    <summary><span>学习记忆</span><span>{temporary ? "临时练习" : memory ? `${memory.enabled ? "正在使用" : "已暂停"} · ${memory.notes.length} 条` : "查看与管理"}</span></summary>
    <div className="voice-memory-content">
      <p className="voice-muted">在这里管理学习偏好、手动笔记和每日日志。</p>
      <label className="voice-memory-switch"><span>临时练习<small>AI、口语、听写与写作仅使用本次内容，结束后清除。切换时会结束语音；词卡进度照常保存。</small></span><input type="checkbox" checked={temporary} disabled={disabled || busy} onChange={(event) => setTemporary(event.target.checked)} /></label>
      {error && <div className="voice-notice" role="alert">{error} <button className="text-button" disabled={blocked} onClick={() => void load()}>重新读取</button></div>}
      {!temporary && <LearningJournalPanel disabled={blocked || !memory} />}
      {temporary ? <p className="voice-muted">退出临时练习后，可继续管理学习记忆。</p> : !memory ? <button className="secondary" disabled={blocked} onClick={() => void load()}>读取学习记忆</button> : <>
        <label className="voice-memory-switch"><span>使用学习个性化<small>使用已保存的记忆和学习记录提供建议。</small></span><input type="checkbox" checked={memory.enabled} disabled={blocked} onChange={(event) => void save({ ...memory, enabled: event.target.checked })} /></label>
        <details className="voice-disclosure"><summary>旧设备记录</summary><label className="voice-memory-switch"><span>使用此浏览器的旧学习记录<small>允许当前账户参考这台设备的词汇笔记、复习与写作摘要。</small></span><input type="checkbox" checked={localProfileEnabled} disabled={blocked || !memory.enabled} onChange={(event) => setProfileAllowed(event.target.checked)} /></label></details>
        <label className="voice-memory-switch"><span>听写默认语速<small>用于已开启学习个性化的普通练习。</small></span><select aria-label="听写默认语速" disabled={blocked} value={memory.notes.find((note) => note.id === "dictation-speed")?.text === "听写默认使用慢速朗读。" ? "slow" : memory.notes.find((note) => note.id === "dictation-speed")?.text === "听写默认使用正常语速朗读。" ? "normal" : "default"} onChange={(event) => {
          const value = event.target.value;
          const other = memory.notes.filter((note) => note.id !== "dictation-speed");
          if (value !== "default" && other.length >= 20) return;
          void save({ ...memory, notes: value === "default" ? other : [...other, { id: "dictation-speed", kind: "preference", source: "manual", text: value === "slow" ? "听写默认使用慢速朗读。" : "听写默认使用正常语速朗读。" }] });
        }}><option value="default">默认</option><option value="normal" disabled={memory.notes.length >= 20 && !memory.notes.some((note) => note.id === "dictation-speed")}>正常</option><option value="slow" disabled={memory.notes.length >= 20 && !memory.notes.some((note) => note.id === "dictation-speed")}>慢速</option></select></label>
        {memory.notes.length >= 20 && !memory.notes.some((note) => note.id === "dictation-speed") && <p className="voice-muted">记忆已满，删除一条后即可保存语速偏好。</p>}
        {memory.notes.length ? <ul className="voice-memory-list">{memory.notes.map((note) => {
          const value = drafts[note.id] ?? note.text;
          return <li key={note.id}><small>{note.source === "manual" ? "你添加的记忆" : note.source === "confirmed_suggestion" ? "你确认的建议" : "已有学习记忆"}{note.updatedAt ? ` · 更新于 ${new Date(note.updatedAt).toLocaleDateString("zh-CN")}` : ""}</small><textarea aria-label="编辑学习记忆" maxLength={400} rows={2} value={value} disabled={blocked} onChange={(event) => setDrafts((current) => ({ ...current, [note.id]: event.target.value }))} /><div><button className="text-button" disabled={blocked || !value.trim() || value.trim() === note.text} onClick={async () => { if (await save({ ...memory, notes: memory.notes.map((row) => row.id === note.id ? { ...row, text: value.trim(), source: "manual" as const } : row) })) setDrafts((current) => { const copy = { ...current }; delete copy[note.id]; return copy; }); }}><Check size={15} />保存修改</button><button className="text-button" disabled={blocked} onClick={async () => { if (await save({ ...memory, notes: memory.notes.filter((row) => row.id !== note.id) })) setDeleted(note); }} aria-label={`删除记忆：${note.text}`}><Trash2 size={15} />删除</button></div></li>;
        })}</ul> : <p className="voice-empty-note">还没有记忆。可以写下喜欢的话题，或从练习后的对话中选择保存。</p>}
        {deleted && <p className="voice-memory-undo" role="status">已删除这条记忆。<button className="text-button" disabled={blocked || memory.notes.length >= 20} onClick={async () => { if (await save({ ...memory, notes: [...memory.notes, deleted] })) setDeleted(null); }}>撤销</button></p>}
        <form className="voice-memory-add" onSubmit={async (event) => { event.preventDefault(); if (newNote.trim() && await remember(newNote, "manual")) setNewNote(""); }}><label htmlFor={noteId}>添加一条记忆</label><textarea id={noteId} rows={2} value={newNote} maxLength={400} disabled={blocked} placeholder="例如：我喜欢文学和城市话题；请留时间让我想词。" onChange={(event) => setNewNote(event.target.value)} /><button className="secondary" disabled={blocked || !memory || memory.notes.length >= 20 || !newNote.trim()}><Plus size={16} />{busy ? "正在保存…" : "保存记忆"}</button></form>
        {memory.recentTopics.length > 0 && <div className="voice-recent-topics"><p className="voice-muted">最近话题：{memory.recentTopics.join("、")}</p><button className="text-button" disabled={blocked} onClick={() => void save({ ...memory, recentTopics: [] })}>清除话题记录</button></div>}
      </>}
    </div>
  </details>;
}


function LearningJournalPanel({ disabled }: { disabled: boolean }) {
  const [daysOpen, setDaysOpen] = useState(false);
  const context = useSyncExternalStore(learningContextStore.subscribe, learningContextStore.get, learningContextStore.getServerSnapshot);
  const { journal, error: syncError, pending } = useSyncExternalStore(learningJournalStore.subscribe, learningJournalStore.get, learningJournalStore.getServerSnapshot);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; void refreshLearningJournal().catch((cause) => { if (mounted.current) setError(cause.message); }); return () => { mounted.current = false; }; }, [context.epoch]);
  async function action(run: () => Promise<unknown>) {
    if (disabled || busy) return;
    setBusy(true); setError("");
    try { await run(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "未能更新日志，请重试。"); }
    finally { if (mounted.current) setBusy(false); }
  }
  const blocked = disabled || busy;
  return <section aria-label="自动学习日志">
    <label className="voice-memory-switch"><span>自动整理学习记录<small>按账户保存练习类型、次数、时长与作答统计，供后续个性化练习使用。口语、复盘、阅读和听写不自动保存原文；个人文章阅读不上传。关闭后停止新增。</small></span><input type="checkbox" checked={journal?.enabled ?? false} disabled={blocked || !journal} onChange={(event) => void action(() => updateLearningJournal({ enabled: event.target.checked }))} /></label>
    {(error || syncError) && <p className="voice-notice" role="alert">{error || syncError} <button className="text-button" disabled={blocked} onClick={() => void action(refreshLearningJournal)}>重试</button></p>}
    {pending > 0 && <p className="voice-muted" role="status">{pending} 条记录待同步，请保持页面打开。</p>}
    {journal && <button className="text-button" disabled={blocked} onClick={() => { if (window.confirm("清空账户中的全部学习日志和你编辑的摘要？此操作无法撤销，本机练习记录保留。")) void action(async () => { await deleteLearningJournal({ all: true }); setDrafts({}); }); }}>清空全部学习日志</button>}
    {!journal && !error && <p className="voice-muted">正在读取学习日志…</p>}
    {journal && <details className="voice-disclosure" open={daysOpen} onToggle={(event) => setDaysOpen(event.currentTarget.open)}><summary>每日日志 · {journal.days.length} 天</summary>
      {!journal.days.length && <p className="voice-empty-note">完成练习后，这里会自动整理当天学习内容。</p>}
      {daysOpen && <ul className="voice-memory-list">{journal.days.map((day) => <li key={day.date}>
        <strong>{day.date}</strong><small>{day.summarySource === "edited" ? "你编辑的摘要" : "根据学习活动自动整理"}</small>
        <textarea aria-label={`${day.date} 学习摘要`} rows={3} maxLength={1200} value={drafts[day.date] ?? day.summary} disabled={blocked} onChange={(event) => setDrafts((current) => ({ ...current, [day.date]: event.target.value }))} />
        <div><button className="text-button" disabled={blocked || drafts[day.date] === undefined || drafts[day.date] === day.summary} onClick={() => void action(async () => { await updateLearningJournal({ date: day.date, summary: drafts[day.date] }); setDrafts((current) => { const next = { ...current }; delete next[day.date]; return next; }); })}>保存摘要</button><button className="text-button" disabled={blocked} onClick={() => void action(() => deleteLearningJournal({ date: day.date }))}>删除当天日志</button></div>
        <details><summary>查看学习活动</summary><ul>{day.events.map((event) => <li key={event.eventId}><span>{event.title}</span>{event.summary && <p>{event.summary}</p>}<button className="text-button" aria-label={`删除活动：${event.title}`} disabled={blocked} onClick={() => void action(() => deleteLearningJournal({ eventId: event.eventId }))}>删除</button></li>)}</ul></details>
      </li>)}</ul>}
    </details>}
  </section>;
}
