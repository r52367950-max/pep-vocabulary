"use client";

import { useDeferredValue, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { learningContextStore } from "@/lib/learning-context-client";
import { BOOKS } from "@/lib/study";
import { MAX_WRITING_TARGETS, searchTargetWords, targetWordAdditions, toggleTargetWord, type TargetWordScope } from "@/lib/writing-targets";
import { StudioDialog } from "../studio-dialog";

const PAGE_SIZE = 60;

export default function TargetWordPicker({ data, selectedIds, onAdd, onClose }: {
  data: Vocabulary;
  selectedIds: string[];
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const policy = useSyncExternalStore(learningContextStore.subscribe, learningContextStore.get, learningContextStore.getServerSnapshot);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [scope, setScope] = useState<TargetWordScope>("all");
  const [bookId, setBookId] = useState("all");
  const [draft, setDraft] = useState<Set<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const input = useRef<HTMLInputElement>(null);
  const validIds = useMemo(() => new Set(data.index.map(entry => entry.id)), [data.index]);
  const existing = useMemo(() => new Set(selectedIds.filter(id => validIds.has(id))), [selectedIds, validIds]);
  const additions = useMemo(() => targetWordAdditions(existing, draft, validIds), [existing, draft, validIds]);
  const allSelected = useMemo(() => new Set([...existing, ...additions]), [existing, additions]);
  const full = allSelected.size >= MAX_WRITING_TARGETS;
  const learnedIds = useMemo(() => new Set(policy.temporary ? [] : [...data.cards.values()].filter(card => card.lastReviewed).map(card => card.id)), [data.cards, policy.temporary]);
  const books = useMemo(() => {
    const available = new Set(data.index.flatMap(entry => entry.sources.map(source => source.bookId)));
    return BOOKS.filter(book => available.has(book.id));
  }, [data.index]);
  const rows = useMemo(() => searchTargetWords(data.index, {
    query: search, scope: policy.temporary && scope === "learned" ? "all" : scope, bookId, learnedIds, selectedIds: allSelected,
  }), [data.index, search, scope, policy.temporary, bookId, learnedIds, allSelected]);
  const clearFilters = () => { setQuery(""); setScope("all"); setBookId("all"); setVisibleCount(PAGE_SIZE); input.current?.focus(); };

  return (
    <StudioDialog title="添加目标词" onClose={onClose} className="target-word-dialog" footer={
      <div className="target-word-footer">
        <span className="target-word-selection-count" aria-live="polite">已选 {allSelected.size}/{MAX_WRITING_TARGETS} 个 · 新选 {additions.length} 个</span>
        {additions.length > 0 && <button type="button" className="text-button" onClick={() => setDraft(new Set())}>清空新选</button>}
        <div className="target-word-footer-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button type="button" className="primary" disabled={!additions.length} onClick={() => { onAdd(additions); onClose(); }}>添加 {additions.length} 个词</button>
        </div>
      </div>
    }>
      <div className="target-word-controls">
        <div className="search-field target-word-search">
          <Search size={19} aria-hidden="true" />
          <input ref={input} type="search" autoFocus autoComplete="off" spellCheck={false} aria-label="搜索单词或中文释义" placeholder="搜索单词或中文释义" value={query}
            onChange={event => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE); }} />
          {query && <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => { setQuery(""); setVisibleCount(PAGE_SIZE); input.current?.focus(); }}><X size={17} aria-hidden="true" /></button>}
        </div>
        <div className="target-word-filter-row">
          <div className="segmented-control target-word-scopes" role="group" aria-label="词语范围">
            {(["all", ...(policy.temporary ? [] : ["learned"]), "selected"] as TargetWordScope[]).map(value => (
              <button key={value} type="button" aria-pressed={scope === value} onClick={() => { setScope(value); setVisibleCount(PAGE_SIZE); }}>
                {value === "all" ? "全部" : value === "learned" ? "已学" : `已选 ${allSelected.size}`}
              </button>
            ))}
          </div>
          <label className="target-word-book"><span className="sr-only">筛选教材</span><select aria-label="筛选教材" value={bookId} onChange={event => { setBookId(event.target.value); setVisibleCount(PAGE_SIZE); }}>
            <option value="all">全部教材</option>
            {books.map(book => <option key={book.id} value={book.id}>{book.label}</option>)}
          </select></label>
        </div>
        <p className="target-word-result-count" id="target-word-capacity" aria-live="polite">{full ? `已选满 ${MAX_WRITING_TARGETS} 个词；移除或取消勾选后可继续选择。` : `${rows.length} 个词`}</p>
      </div>
      <div className="target-word-results" aria-busy={query !== search}>
        {rows.length ? <ul className="target-word-list" aria-label="词库搜索结果">
          {rows.slice(0, visibleCount).map(entry => {
            const added = existing.has(entry.id), checked = allSelected.has(entry.id);
            return <li key={entry.id}>
              <label className={`target-word-row${checked ? " is-selected" : ""}${added ? " is-added" : ""}`}>
                <input type="checkbox" checked={checked} disabled={added || (full && !checked)} aria-describedby={full ? "target-word-capacity" : undefined} aria-label={added ? `${entry.headword}，已添加` : `选择 ${entry.headword}`} onChange={() => setDraft(current => toggleTargetWord(current, entry.id, existing))} />
                <span className="target-word-text"><strong lang="en">{entry.headword}</strong><small>{[entry.partsOfSpeech.join(" / "), entry.chineseCore].filter(Boolean).join(" · ")}</small></span>
                {added && <span className="target-word-added">已添加</span>}
              </label>
            </li>;
          })}
        </ul> : <div className="target-word-empty"><p>{scope === "selected" && !allSelected.size ? "还没有选择词语" : scope === "learned" && !learnedIds.size ? "还没有学过的词" : "没有找到匹配的词"}</p><button type="button" className="text-button" onClick={clearFilters}>浏览全部词库</button></div>}
        {rows.length > visibleCount && <button type="button" className="secondary target-word-more" onClick={() => setVisibleCount(count => count + PAGE_SIZE)}>加载更多（还剩 {rows.length - visibleCount} 个）</button>}
      </div>
    </StudioDialog>
  );
}
