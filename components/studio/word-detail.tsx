"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Check, ChevronRight, Sparkles, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import {
  loadDetails,
  type LexiconDetail,
  type LexiconIndexEntry,
} from "@/lib/lexicon";
import { getEntryExample } from "@/lib/questions";
import { useModal } from "@/hooks/use-modal";
import { Pronounce } from "./shared";

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
  const [explanation, setExplanation] = useState("");
  const [thinking, setThinking] = useState(false);
  const abort = useRef<AbortController | null>(null);
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
      abort.current?.abort();
    };
  }, [entry.id]);
  const example = getEntryExample(entry, detail);
  const explain = async () => {
    if (thinking) return;
    setThinking(true);
    setExplanation("");
    const controller = new AbortController();
    abort.current = controller;
    const timer = setTimeout(() => controller.abort(), 65_000);
    try {
      const response = await fetch("/api/assistant/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vocab-action": "assistant",
        },
        signal: controller.signal,
        body: JSON.stringify({
          wordId: entry.id,
          focus: "general",
          masteryTags: [],
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          payload.error?.message || "讲解暂时不可用，请检查设置中的接口。",
        );
      const result = payload.result || payload.data || payload;
      // Model text stays plain text. It is never interpreted as HTML.
      setExplanation(
        [
          result.summary,
          ...[result.meaning, result.grammar, result.collocations].flatMap(
            (items) => (Array.isArray(items) ? items : []),
          ),
          ...(Array.isArray(result.examples)
            ? result.examples.map(
                (item: { sentence?: string; translation?: string }) =>
                  `${item.sentence || ""}\n${item.translation || ""}`,
              )
            : []),
        ]
          .filter((item) => typeof item === "string")
          .join("\n\n") || "本次未返回可展示的讲解，请稍后再试。",
      );
    } catch (error) {
      setExplanation(
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "讲解请求已超时。你可以继续本地学习。",
      );
    } finally {
      clearTimeout(timer);
      setThinking(false);
    }
  };
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
          <div className="ai-explanation">
            <button className="secondary" disabled={thinking} onClick={explain}>
              <Sparkles size={17} aria-hidden="true" />
              {thinking ? "正在生成讲解…" : "生成用法讲解"}
            </button>
            {explanation && <p role="status">{explanation}</p>}
            <small>模型生成，仅供学习参考。</small>
          </div>
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
