"use client";

import { Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Bookmark, Check, ChevronRight, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import {
  loadDetails,
  type LexiconDetail,
  type LexiconIndexEntry,
} from "@/lib/lexicon";
import { getEntryExample } from "@/lib/questions";
import { Pronounce } from "./shared";
import { WordAi } from "./surfaces";

export type WordDetailHandle = { save: () => Promise<boolean> };

export default function WordDetail({
  entry,
  data,
  onClose,
  onPractice,
  ref,
}: {
  entry: LexiconIndexEntry;
  data: Vocabulary;
  onClose: () => void;
  onPractice: (entry: LexiconIndexEntry) => void;
  ref?: Ref<WordDetailHandle>;
}) {
  const [detail, setDetail] = useState<LexiconDetail>();
  const [failure, setFailure] = useState("");
  const savedNote = data.cards.get(entry.id)?.note || "";
  const [note, setNote] = useState(savedNote);
  const [saveFailed, setSaveFailed] = useState(false);
  const generation = useRef(data.generation).current;
  const { metadata } = data;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const save = useCallback(async () => {
    if (savingRef.current) return savingRef.current;
    if (note === savedNote) return true;
    setSaving(true);
    const task = metadata(entry.id, { note }, generation);
    savingRef.current = task;
    try {
      const ok = await task;
      setSaveFailed(!ok);
      return ok;
    } finally { savingRef.current = null; setSaving(false); }
  }, [note, savedNote, metadata, entry.id, generation]);
  useImperativeHandle(ref, () => ({ save }), [save]);
  const [leaving, setLeaving] = useState(false);
  const pending = useRef(false);
  const leave = async (action: () => void) => {
    if (pending.current) return;
    pending.current = true; setLeaving(true);
    try { if (await save()) action(); }
    finally { pending.current = false; setLeaving(false); }
  };
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      if (node?.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
    };
  }, []);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    loadDetails([entry.id])
      .then((rows) => {
        if (active) setDetail(rows[0]);
      })
      .catch(() => {
        if (active)
          setFailure("词条详情暂不可用。已保存的词义和学习仍可使用。");
      });
    return () => {
      active = false;
    };
  }, [entry.id]);
  const example = getEntryExample(entry, detail);
  return (
    <aside
      className="word-inspector"
      ref={panel}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); void leave(onClose); } }}
      aria-labelledby="detail-title"
    >
      <div className="detail-content">
        <div className="detail-top">
          <span>词条详情</span>
          <button
            ref={closeButton}
            className="icon-button"
            onClick={() => void leave(onClose)}
            disabled={leaving || saving}
            aria-label="关闭词条"
          >
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        <div className="detail-word">
          <h2 id="detail-title" className="english" translate="no">
            {entry.headword}
          </h2>
          <Pronounce text={entry.headword} notify={data.notify} />
          <button
            className={`icon-button favorite-button ${data.cards.get(entry.id)?.favorite ? "is-favorite" : ""}`}
            aria-pressed={!!data.cards.get(entry.id)?.favorite}
            aria-label={
              data.cards.get(entry.id)?.favorite ? "取消收藏" : "收藏单词"
            }
            onClick={() => data.metadata(entry.id, { toggleFavorite: true }, generation)}
          >
            <Bookmark size={19} aria-hidden="true" />
          </button>
        </div>
        <p className="ipa">
          {entry.britishIpa ? `英 /${entry.britishIpa}/` : "音标待补充"}
          {entry.americanIpa && `　美 /${entry.americanIpa}/`}
        </p>
        <p className="detail-meaning">
          <small>{entry.partsOfSpeech.join(" / ")}</small>
          {entry.chineseCore}
        </p>
        {detail?.englishCore && (
          <p className="english-definition">{detail.englishCore}</p>
        )}
        {example && (
          <div className="example-block">
            <span>{example.source}</span>
            <p className="english">{example.en}</p>
            {example.zh && <small>{example.zh}</small>}
          </div>
        )}
        {failure && <p role="status">{failure}</p>}
        <div className="detail-sources">
          <h3>出现在哪些单元</h3>
          {entry.sources.map((source, i) => (
            <span key={`${source.bookId}-${source.unit}-${i}`}>
              {source.volume} · {source.unit}
              {source.printedPage && ` · p.${source.printedPage}`}
            </span>
          ))}
        </div>
        <label className="note-field">
          <span>我的笔记</span>
          <textarea
            disabled={leaving || saving}
            maxLength={2000}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
            placeholder="记下容易混淆的地方，或写一个自己的句子。"
          />
          <button
            className="text-button"
            disabled={leaving || saving}
            onClick={async () => {
              const ok = await save();
              setSaved(ok);
              setSaveFailed(!ok);
            }}
          >
            {saved ? (
              <>
                <Check size={15} aria-hidden="true" />
                已保存
              </>
            ) : (
              "保存笔记"
            )}
          </button>
          {saveFailed && <>
            <small role="status">笔记未保存，文字仍保留在这里。关闭前请先复制保留。</small>
            <button className="text-button" onClick={() => {
              if (window.confirm("笔记尚未保存。请先复制保留；仍要放弃未保存的修改并关闭？")) onClose();
            }}>放弃未保存修改并关闭</button>
          </>}
        </label>
        {data.settings.aiEnabled && (
          <Suspense fallback={null}>
            <WordAi entry={entry} data={data} />
          </Suspense>
        )}
        <button
          className="primary detail-practice"
          disabled={leaving || saving}
          onClick={() => void leave(() => onPractice(entry))}
        >
          练习这个词 <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
