"use client";

import { useMemo } from "react";
import { Volume2 } from "lucide-react";
import { speakSystem, type LexiconIndexEntry } from "@/lib/lexicon";
import { StudioSymbol } from "./symbol";
import { BOOKS, getBookUnits } from "@/lib/study";

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-seal" aria-hidden="true">迹</span>
      词迹
    </span>
  );
}

export function CoursePicker({
  entries,
  bookId,
  unit,
  onChange,
}: {
  entries: LexiconIndexEntry[];
  bookId: string;
  unit: string;
  onChange: (book: string, unit: string) => void;
}) {
  const units = useMemo(() => getBookUnits(entries, bookId), [entries, bookId]);
  return (
    <div className="course-picker">
      <label>
        <span>教材</span>
        <select
          aria-label="选择教材"
          value={bookId}
          onChange={(e) => onChange(e.target.value, "all")}
        >
          {BOOKS.map((book) => (
            <option key={book.id} value={book.id}>
              {book.level === "curriculum"
                ? book.shortLabel
                : `${book.level === "middle" ? "初中" : "高中"} · ${book.shortLabel}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>单元</span>
        <select
          aria-label="选择单元"
          value={unit}
          onChange={(e) => onChange(bookId, e.target.value)}
        >
          <option value="all">全部单元</option>
          {units.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function Pronounce({
  text,
  notify,
  label = "播放发音",
}: {
  text: string;
  notify: (message: string) => void;
  label?: string;
}) {
  return (
    <button
      className="icon-button pronounce"
      title={label}
      aria-label={label}
      onClick={() => {
        if (!("speechSynthesis" in window)) {
          notify("此浏览器不支持语音，请换用 Safari 或 Chrome。");
          return;
        }
        speakSystem(text);
      }}
    >
      <Volume2 size={19} aria-hidden="true" />
    </button>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <StudioSymbol name="lexicon" size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function sourceLabel(entry: LexiconIndexEntry) {
  const source = entry.sources[0];
  return source
    ? `${source.volume} · ${source.unit}${source.printedPage ? ` · p.${source.printedPage}` : ""}`
    : "课程词汇";
}
