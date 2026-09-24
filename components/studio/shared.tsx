"use client";

import { useMemo } from "react";
import { Volume2 } from "lucide-react";
import { speakSystem, type LexiconIndexEntry } from "@/lib/lexicon";
import { StudioSymbol } from "./symbol";
import { BOOKS, getBookUnits } from "@/lib/study";

/** The mark: a forgetting curve lifted at each review, a blue baseline and a blue dot. Colours follow the app theme in CSS. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect className="brand-mark-ground" width="100" height="100" rx="22.37" />
      <g transform="translate(14 14) scale(.72)">
        <path className="brand-mark-curve" d="M14 26C19 44 24 52 33 55V33C39 46 45 50 55 52V38C62 46 70 48 82 48" fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 78H86" stroke="#0071E3" strokeWidth="2" strokeLinecap="round" />
        <circle cx="82" cy="48" r="7" fill="#0071E3" />
      </g>
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <BrandMark />
      <span className="brand-name">词迹</span>
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
