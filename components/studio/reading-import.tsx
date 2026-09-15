"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, FileUp, X } from "lucide-react";
import { useModal } from "@/hooks/use-modal";
import { createLocalId } from "@/lib/storage";
import { countReadingWords, READING_CATEGORIES, type Difficulty, type ReadingCategory } from "@/lib/reading-library";
import { extractReadingFile, parseClassification, validateImportedText } from "@/lib/reading-import";
import { savePersonalArticle } from "@/lib/personal-readings";

export default function ReadingImport({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { dialog: dialogRef, closing, requestClose, onCancel, onPointerDown, onClick } = useModal(onClose);
  const [title, setTitle] = useState(""); const [author, setAuthor] = useState("");
  const [body, setBody] = useState(""); const [category, setCategory] = useState<ReadingCategory>("essay"); const [difficulty, setDifficulty] = useState<Difficulty>("B1");
  const [useAI, setUseAI] = useState(false); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(""); const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null); const camera = useRef<HTMLInputElement>(null); const job = useRef<AbortController | null>(null);
  useEffect(() => () => job.current?.abort(), []);
  const importFile = async (file: File) => {
    if (job.current) return;
    const controller = new AbortController(); job.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => { controller.abort(); setError("处理超时。请裁剪图片、减少页数，或粘贴正文后重试。"); }, 180_000);
    try {
      const text = await extractReadingFile(file, controller.signal, message => { if (job.current === controller && !controller.signal.aborted) setProgress(message); });
      if (controller.signal.aborted) return;
      if (text.length > 60_000) throw new Error("文字超过单篇上限，请先选取需要的文章。");
      setBody(text); if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, "").slice(0, 200));
      if (!text.trim()) setError("没有识别到正文。请换用清晰的英文图片，或粘贴文字。");
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "文件读取失败。"); }
    finally { clearTimeout(timer); if (job.current === controller) { job.current = null; setBusy(false); setProgress(""); } }
  };
  const save = async () => {
    if (job.current) return;
    const controller = new AbortController(); job.current = controller; setBusy(true); setError("");
    const timer = setTimeout(() => { controller.abort(); setError("分类或保存超时，请关闭 AI 分类后重试。"); }, 65_000);
    try {
      const text = validateImportedText(body);
      if (!title.trim()) throw new Error("请填写文章标题。");
      let selected = { category, difficulty };
      if (useAI) {
        setProgress("正在分类并估计语言难度…");
        const response = await fetch("/api/reading/classify", { method: "POST", headers: { "content-type": "application/json", "x-vocab-action": "reading-classify" }, signal: controller.signal, body: JSON.stringify({ title: title.trim(), text: text.slice(0, 8000) }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "AI 分类未完成。你可以关闭 AI 分类后手动导入。");
        selected = parseClassification(JSON.stringify(result)); setCategory(selected.category); setDifficulty(selected.difficulty);
      }
      if (controller.signal.aborted) return;
      setProgress("正在保存文章…");
      const id = await savePersonalArticle({ id: `personal-${createLocalId()}`, title: title.trim(), author: author.trim() || "作者未注明", sourceUrl: "", rights: { label: "个人导入", basis: "由你导入并保存在本机，版权归原作者。个人文章可在阅读器中单独导出。", url: "" }, ...selected, wordCount: countReadingWords(text), difficultyNote: useAI ? "由你配置的 AI 根据正文样本估计，未经过编辑审定。" : "导入时手动选择，可用于按难度筛选。", form: "imported", background: "由你保存到词迹的阅读材料。", addedIn: "2.1.0", paragraphs: text.split(/\n\s*\n/).map(en => ({ en })) }, controller.signal);
      onSaved(id);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "导入失败，请重试。"); }
    finally { clearTimeout(timer); if (job.current === controller) { job.current = null; setBusy(false); setProgress(""); } }
  };
  const cancel = () => { job.current?.abort(); setProgress("正在取消…"); setError("已取消。已填写的文字仍然保留。"); };
  return <dialog ref={dialogRef} className="import-dialog" aria-labelledby="import-title" data-closing={closing} onCancel={onCancel} onPointerDown={onPointerDown} onClick={onClick}>
    <div className="import-frame"><header className="settings-dialog-header"><h2 id="import-title">导入文章</h2><button className="icon-button" aria-label="关闭文章导入" onClick={requestClose}><X size={20} /></button></header>
      <div className="import-content"><div className="import-methods"><button disabled={busy} onClick={() => input.current?.click()}><FileUp size={22} /><strong>选择文件</strong><span>PDF、Word 或文本</span></button><button disabled={busy} onClick={() => camera.current?.click()}><Camera size={22} /><strong>扫描英文</strong><span>拍照或选择图片</span></button></div>
        <input ref={input} type="file" hidden accept=".txt,.md,.markdown,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.webp,.bmp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFile(file); }} />
        <input ref={camera} type="file" hidden accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFile(file); }} />
        <p className="import-help">也可以直接粘贴正文。单个文件不超过 12 MB，PDF 最多 30 页。扫描适合清晰的印刷体英文，请核对识别结果。</p>
        <div className="import-title-fields"><label>标题<input maxLength={200} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} placeholder="文章标题" /></label><label>作者<input maxLength={160} value={author} disabled={busy} onChange={e => setAuthor(e.target.value)} placeholder="可选" /></label></div>
        <label className="import-body-label"><span>正文<span>{countReadingWords(body).toLocaleString()} 词</span></span><textarea aria-label="导入文章正文" rows={8} value={body} maxLength={60000} disabled={busy} onChange={e => setBody(e.target.value)} placeholder="在这里粘贴英文，或先选择文件…" /></label>
        <div className="import-options"><label>分类<select disabled={busy} value={category} onChange={e => setCategory(e.target.value as ReadingCategory)}>{Object.entries(READING_CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>语言难度<select disabled={busy} value={difficulty} onChange={e => setDifficulty(e.target.value as Difficulty)}>{["A2", "B1", "B2", "C1"].map(d => <option key={d}>{d}</option>)}</select></label></div>
        <label className="import-ai"><input type="checkbox" checked={useAI} disabled={busy} onChange={e => setUseAI(e.target.checked)} /><span><strong>使用 AI 自动分类</strong><small>将标题和正文前 8,000 个字符发送给已配置的模型。关闭后使用你选择的分类与难度。</small></span></label>
        {error && <p className="import-error" role="alert">{error}</p>}{busy && <p className="import-progress" role="status">{progress || "正在处理…"}</p>}
      </div><footer className="import-footer"><span>文章保存在本机</span>{busy ? <button className="secondary" onClick={cancel}>取消处理</button> : <button className="primary" onClick={() => void save()} disabled={!title.trim() || countReadingWords(body) < 40}>保存并阅读</button>}</footer>
    </div>
  </dialog>;
}
