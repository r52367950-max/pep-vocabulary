"use client";

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Bookmark, Check, ChevronRight, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import {
  loadDetails,
  type LexiconDetail,
  type LexiconIndexEntry,
} from "@/lib/lexicon";
import { getEntryExample } from "@/lib/questions";
import { useModal } from "@/hooks/use-modal";
import { Pronounce } from "./shared";

const WordAi = lazy(() => import("./ai/word-ai"));

export default function WordDetail({
  entry,
  data,
  onClose,
  onPractice,
}: {
  entry: LexiconIndexEntry;
  data: Vocabulary;
  onClose: () => void;
  onPractice: (entry: LexiconIndexEntry) => void;
}) {
  const [detail, setDetail] = useState<LexiconDetail>();
  const [failure, setFailure] = useState("");
  const savedNote = data.cards.get(entry.id)?.note || "";
  const [note, setNote] = useState(savedNote);
  const { metadata } = data;
  // Closing keeps an unsaved note rather than discarding it.
  const close = useCallback(() => {
    if (note !== savedNote) void metadata(entry.id, { note });
    onClose();
  }, [note, savedNote, metadata, entry.id, onClose]);
  const { dialog, closing, requestClose, onCancel, onPointerDown, onClick } = useModal(close);
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
    <dialog
      className="word-dialog"
      ref={dialog}
      data-closing={closing}
      onCancel={onCancel}
      onPointerDown={onPointerDown}
      onClick={onClick}
      aria-labelledby="detail-title"
    >
      <div className="detail-content">
        <div className="detail-top">
          <span>词条详情</span>
          <button
            className="icon-button"
            onClick={requestClose}
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
            className={`icon-button ${data.cards.get(entry.id)?.favorite ? "is-favorite" : ""}`}
            aria-label={
              data.cards.get(entry.id)?.favorite ? "取消收藏" : "收藏单词"
            }
            onClick={() => data.metadata(entry.id, { toggleFavorite: true })}
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
            onClick={async () => {
              const ok = await data.metadata(entry.id, { note });
              setSaved(ok);
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
        </label>
        {data.settings.aiEnabled && (
          <Suspense fallback={null}>
            <WordAi entry={entry} data={data} />
          </Suspense>
        )}
        <button
          className="primary detail-practice"
          onClick={() => onPractice(entry)}
        >
          练习这个词 <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </dialog>
  );
}
