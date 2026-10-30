"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";

export type LearningMemory = { revision: number; enabled: boolean; notes: { id: string; text: string }[]; recentTopics: string[] };

export function useLearningMemory() {
  const [memory, setMemory] = useState<LearningMemory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    try {
      const response = await fetch("/api/voice/memory", { credentials: "same-origin", signal: abort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || result?.error || "学习记忆暂时无法读取。");
      if (mounted.current && !abort.signal.aborted) { setMemory(result); setError(""); }
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "学习记忆暂时无法读取。"); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; controller.current?.abort(); }; }, [load]);
  const save = useCallback(async (next: LearningMemory) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    try {
      const response = await fetch("/api/voice/memory", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next), signal: abort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? "其他页面更新了学习记忆。请重新读取，再保存你的修改。" : result?.error?.message || result?.error || "记忆没有保存，请重试。");
      if (!mounted.current || abort.signal.aborted) return false;
      setMemory(result); return true;
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "记忆没有保存，请重试。"); return false; }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const remember = useCallback(async (text: string) => {
    if (!memory) { setError("请先读取学习记忆，再保存。"); return false; }
    if (memory.notes.some((note) => note.text === text.trim())) return true;
    if (memory.notes.length >= 20) { setError("已保存 20 条，请整理后再添加。"); return false; }
    return save({ ...memory, notes: [...memory.notes, { id: crypto.randomUUID(), text: text.trim().slice(0, 400) }] });
  }, [memory, save]);
  const rememberTopic = useCallback(async (title: string) => {
    if (pending.current) return false;
    try {
      const response = await fetch("/api/voice/memory", { credentials: "same-origin" });
      const current = await response.json() as LearningMemory;
      if (!response.ok || !mounted.current || pending.current || !current.enabled) return false;
      return save({ ...current, recentTopics: [title, ...current.recentTopics.filter((item) => item !== title)].slice(0, 12) });
    } catch { return false; }
  }, [save]);
  return { memory, error, busy, load, save, remember, rememberTopic };
}

type MemoryControls = ReturnType<typeof useLearningMemory>;
export function LearningMemoryPanel({ controls, disabled = false }: { controls: MemoryControls; disabled?: boolean }) {
  const { memory, error, busy, load, save, remember } = controls;
  const [newNote, setNewNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<{ id: string; text: string } | null>(null);
  const blocked = disabled || busy;
  return <details className="voice-memory voice-disclosure">
    <summary><span>学习记忆</span><span>{memory ? `${memory.enabled ? "正在使用" : "已暂停"} · ${memory.notes.length} 条` : "查看与管理"}</span></summary>
    <div className="voice-memory-content">
      <p className="voice-muted">保存你确认的学习偏好和待练表达，下次口语、推荐与复盘都可参考。跟随本站账号保存，不读取 ChatGPT 的记忆。</p>
      {error && <div className="voice-notice" role="alert">{error} <button className="text-button" disabled={blocked} onClick={() => void load()}>重新读取</button></div>}
      {!memory ? <button className="secondary" disabled={blocked} onClick={() => void load()}>读取学习记忆</button> : <>
        <label className="voice-memory-switch"><span>使用长期学习记忆<small>关闭后保留内容，但不提供给新的 AI 请求。</small></span><input type="checkbox" checked={memory.enabled} disabled={blocked} onChange={(event) => void save({ ...memory, enabled: event.target.checked })} /></label>
        {memory.notes.length ? <ul className="voice-memory-list">{memory.notes.map((note) => {
          const value = drafts[note.id] ?? note.text;
          return <li key={note.id}><textarea aria-label="编辑学习记忆" maxLength={400} rows={2} value={value} disabled={blocked} onChange={(event) => setDrafts((current) => ({ ...current, [note.id]: event.target.value }))} /><div><button className="text-button" disabled={blocked || !value.trim() || value.trim() === note.text} onClick={async () => { if (await save({ ...memory, notes: memory.notes.map((row) => row.id === note.id ? { ...row, text: value.trim() } : row) })) setDrafts((current) => { const copy = { ...current }; delete copy[note.id]; return copy; }); }}><Check size={15} />保存修改</button><button className="text-button" disabled={blocked} onClick={async () => { if (await save({ ...memory, notes: memory.notes.filter((row) => row.id !== note.id) })) setDeleted(note); }} aria-label={`删除记忆：${note.text}`}><Trash2 size={15} />删除</button></div></li>;
        })}</ul> : <p className="voice-empty-note">还没有记忆。可以写下喜欢的话题，或从练习后的对话中选择保存。</p>}
        {deleted && <p className="voice-memory-undo" role="status">已删除这条记忆。<button className="text-button" disabled={blocked || memory.notes.length >= 20} onClick={async () => { if (await save({ ...memory, notes: [...memory.notes, deleted] })) setDeleted(null); }}>撤销</button></p>}
        <form className="voice-memory-add" onSubmit={async (event) => { event.preventDefault(); if (newNote.trim() && await remember(newNote)) setNewNote(""); }}><label htmlFor="voice-memory-note">添加一条记忆</label><textarea id="voice-memory-note" rows={2} value={newNote} maxLength={400} disabled={blocked} placeholder="例如：我喜欢文学和城市话题；请留时间让我想词。" onChange={(event) => setNewNote(event.target.value)} /><button className="secondary" disabled={blocked || !memory || memory.notes.length >= 20 || !newNote.trim()}><Plus size={16} />{busy ? "正在保存…" : "保存记忆"}</button></form>
        {memory.recentTopics.length > 0 && <div className="voice-recent-topics"><p className="voice-muted">最近话题：{memory.recentTopics.join("、")}</p><button className="text-button" disabled={blocked} onClick={() => void save({ ...memory, recentTopics: [] })}>清除话题记录</button></div>}
      </>}
    </div>
  </details>;
}
