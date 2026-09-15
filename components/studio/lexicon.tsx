"use client";

import { useDeferredValue, useMemo, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Headphones,
  Search,
  X,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { matchesLexiconQuery, type LexiconIndexEntry } from "@/lib/lexicon";
import { selectEntries, type StudyMode } from "@/lib/study";
import { delimitedCell } from "@/lib/export";
import { CoursePicker, Empty, sourceLabel } from "./shared";

export default function Lexicon({
  data,
  bookId,
  unit,
  onCourse,
  initialQuery,
  onDetail,
  onStart,
}: {
  data: Vocabulary;
  bookId: string;
  unit: string;
  onCourse: (book: string, unit: string) => void;
  initialQuery: string;
  onDetail: (entry: LexiconIndexEntry) => void;
  onStart: (mode: StudyMode, entries: LexiconIndexEntry[]) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const search = useDeferredValue(query);
  const [scope, setScope] = useState<"book" | "all">(
    initialQuery ? "all" : "book",
  );
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const rows = useMemo(
    () =>
      selectEntries(
        data.index,
        scope === "book" ? { bookId, unit } : {},
      ).filter((entry) => {
        const card = data.cards.get(entry.id);
        return (
          matchesLexiconQuery(entry, search) &&
          (status === "all" ||
            (status === "favorite"
              ? card?.favorite
              : status === "unseen"
                ? !card?.lastReviewed && card?.status !== "paused"
                : card?.status === status))
        );
      }),
    [data.index, data.cards, scope, bookId, unit, search, status],
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 40) - 1),
  );
  const visible = rows.slice(currentPage * 40, currentPage * 40 + 40);
  const picks = rows.filter((entry) => selected.has(entry.id));
  const practice = picks.length ? picks : rows.slice(0, 20);
  const exportRows = () => {
    const content =
      "\uFEFF" +
      [
        ["word", "meaning", "ipa", "source"],
        ...rows.map((row) => [
          row.headword,
          row.chineseCore,
          row.britishIpa,
          sourceLabel(row),
        ]),
      ]
        .map((row) => row.map((cell) => delimitedCell(cell, "csv")).join(","))
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "词迹-当前词表.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="lexicon-view">
      <div className="page-heading">
        <div>
          <p>教材词汇与个人收藏</p>
          <h1>词库</h1>
        </div>
        <div className="lexicon-actions">
          <button
            className="text-button"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? "完成选择" : "选择"}
          </button>
          <button
            className="icon-button"
            onClick={exportRows}
            aria-label="导出当前词表"
            title="导出当前词表"
          >
            <Download size={17} />
          </button>
        </div>
      </div>
      <div className="lexicon-toolbar">
        <div className="search-field">
          <Search size={19} />
          <input
            id="lexicon-search"
            aria-label="搜索单词或中文释义"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="搜索单词、中文释义或短语"
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="segmented" aria-label="搜索范围">
          <button
            aria-pressed={scope === "book"}
            onClick={() => {
              setScope("book");
              setPage(0);
            }}
          >
            当前教材
          </button>
          <button
            aria-pressed={scope === "all"}
            onClick={() => {
              setScope("all");
              setPage(0);
            }}
          >
            全部词库
          </button>
        </div>
      </div>
      <div className="lexicon-filters">
        {scope === "book" && (
          <CoursePicker
            entries={data.index}
            bookId={bookId}
            unit={unit}
            onChange={(book, nextUnit) => {
              setPage(0);
              setSelected(new Set());
              onCourse(book, nextUnit);
            }}
          />
        )}
        <label className="status-filter">
          学习状态
          <select
            aria-label="筛选学习状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">全部状态</option>
            <option value="unseen">未学</option>
            <option value="learning">学习中</option>
            <option value="weak">待巩固</option>
            <option value="mastered">已熟悉</option>
            <option value="favorite">已收藏</option>
          </select>
        </label>
      </div>
      <div className="word-list-meta">
        <span>
          共 {rows.length.toLocaleString("zh-CN")} 词{" "}
          {picks.length > 0 && `· 已选 ${picks.length} 词`}
        </span>
        <div>
          {picks.length > 0 && (
            <button
              className="text-button"
              onClick={() => setSelected(new Set())}
            >
              取消选择
            </button>
          )}
          <button
            className="text-button"
            disabled={!practice.length}
            onClick={() => onStart("dictation", practice)}
          >
            <Headphones size={16} />
            {picks.length ? "听写所选" : `听写这 ${practice.length} 词`}
          </button>
          <button
            className="primary small"
            disabled={!practice.length}
            onClick={() => onStart("daily", practice)}
          >
            开始练习 <ChevronRight size={15} />
          </button>
        </div>
      </div>
      {rows.length ? (
        <>
          <div
            className={`word-list${selecting ? " is-selecting" : ""}`}
            aria-label="词库搜索结果"
          >
            {visible.map((entry) => {
              const card = data.cards.get(entry.id);
              return (
                <div className="word-row" key={entry.id}>
                  {selecting && (
                    <label className="word-select">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${entry.headword}`}
                        checked={selected.has(entry.id)}
                        onChange={() =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (next.has(entry.id)) next.delete(entry.id);
                            else if (next.size < 80) next.add(entry.id);
                            else data.notify("每轮最多选择 80 个词。");
                            return next;
                          })
                        }
                      />
                      <span>
                        <Check size={12} />
                      </span>
                    </label>
                  )}
                  <button className="word-open" onClick={() => onDetail(entry)}>
                    <span className="word-en">
                      <strong>{entry.headword}</strong>
                      <small>
                        {entry.britishIpa ? `/${entry.britishIpa}/` : ""}
                      </small>
                    </span>
                    <span className="word-zh">{entry.chineseCore}</span>
                    <span
                      className={`word-status status-${card?.status || "unseen"}`}
                    >
                      {
                        (
                          {
                            unseen: "未学",
                            learning: "学习中",
                            weak: "待巩固",
                            mastered: "已熟悉",
                            paused: "已暂停",
                          } as const
                        )[card?.status || "unseen"]
                      }
                    </span>
                  </button>
                  <button
                    className={`icon-button ${card?.favorite ? "is-favorite" : ""}`}
                    aria-label={`${card?.favorite ? "取消收藏" : "收藏"} ${entry.headword}`}
                    onClick={() =>
                      data.metadata(entry.id, { toggleFavorite: true })
                    }
                  >
                    <Bookmark size={17} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="pagination">
            <span>
              第 {currentPage + 1} / {Math.ceil(rows.length / 40)} 页
            </span>
            <button
              className="secondary"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={16} />
              上一页
            </button>
            <button
              className="secondary"
              disabled={(currentPage + 1) * 40 >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
              <ChevronRight size={16} />
            </button>
          </div>
        </>
      ) : (
        <Empty title="没有找到匹配的单词">
          试试更短的词，或将搜索范围改为全部词库。
        </Empty>
      )}
    </div>
  );
}
