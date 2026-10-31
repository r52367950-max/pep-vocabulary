"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useId } from "react";
import { Check, Plus, Trash2 } from "lucide-react";

import { learningContextStore, localProfileAllowed, setLocalProfileAllowed, refreshLearningContext, saveLearningMemory, setTemporaryMode, type LearningMemory, type LearningNote } from "@/lib/learning-context-client";
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
  return <LearningMemoryForm key={`${memory?.accountScope ?? "unloaded"}:${temporary}`} {...props} />;
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
      <p className="voice-muted">本站的文本 AI、口语和听写共用你确认的学习偏好与待练表达。聊天记录与记忆分开，不会自动上传全部聊天，也不读取 ChatGPT 的记忆。</p>
      <label className="voice-memory-switch"><span>临时练习<small>本标签页的 AI、口语、听写和写作不读历史个性化内容，也不保存新记录。已开始的语音会停止，需重新开始。</small></span><input type="checkbox" checked={temporary} disabled={disabled || busy} onChange={(event) => setTemporary(event.target.checked)} /></label>
      {error && <div className="voice-notice" role="alert">{error} <button className="text-button" disabled={blocked} onClick={() => void load()}>重新读取</button></div>}
      {temporary ? <p className="voice-muted">当前只使用这次任务的内容。退出临时练习后可继续管理账户记忆。</p> : !memory ? <button className="secondary" disabled={blocked} onClick={() => void load()}>读取学习记忆</button> : <>
        <label className="voice-memory-switch"><span>使用学习个性化<small>关闭后保留记忆，但新的 AI 请求不读取长期记忆或历史学习画像。</small></span><input type="checkbox" checked={memory.enabled} disabled={blocked} onChange={(event) => void save({ ...memory, enabled: event.target.checked })} /></label>
        <label className="voice-memory-switch"><span>使用此浏览器的学习记录<small>仅你确认后，当前账户的 AI 才可参考这台设备的词汇笔记、复习与写作摘要；不会上传完整记录。</small></span><input type="checkbox" checked={localProfileEnabled} disabled={blocked || !memory.enabled} onChange={(event) => setProfileAllowed(event.target.checked)} /></label>
        <label className="voice-memory-switch"><span>听写默认语速<small>作为你确认的偏好保存；不会改写题目。暂停个性化或临时练习时不使用。</small></span><select aria-label="听写默认语速" disabled={blocked} value={memory.notes.find((note) => note.id === "dictation-speed")?.text === "听写默认使用慢速朗读。" ? "slow" : memory.notes.find((note) => note.id === "dictation-speed")?.text === "听写默认使用正常语速朗读。" ? "normal" : "default"} onChange={(event) => {
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
