"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Volume2, X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import { speakSystem } from "@/lib/lexicon";
import { timeOfDay, type ArtKind } from "@/lib/art";
import { Artwork, useDarkAppearance } from "../art";
import { CoursePicker } from "../shared";
import { StudioSymbol, type SymbolName } from "../symbol";

export type LearnModeProps = {
  data: Vocabulary;
  bookId: string;
  unit: string;
  onCourse: (book: string, unit: string) => void;
  onExit: () => void;
  onPractice: (entries: LexiconIndexEntry[], mode: "new" | "mistakes") => void;
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** Read at the moment of an interaction, so a settings change applies immediately. */
export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION).matches
  );
}

export function speak(text: string, notify: Vocabulary["notify"]) {
  if (!speakSystem(text)) notify("此浏览器不支持语音，请换用 Safari 或 Chrome。");
}

/** Move focus (and the page) to the new screen's heading whenever `key` changes. */
export function useScreenFocus<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    ref.current?.focus({ preventScroll: true });
  }, [key]);
  return ref;
}

export function LearnHeader({
  title,
  done,
  total,
  count,
  onExit,
  children,
}: {
  title?: string;
  done?: number;
  total?: number;
  count?: ReactNode;
  onExit: () => void;
  children?: ReactNode;
}) {
  const showTrack = total !== undefined && total > 0;
  return (
    <header className="learn-header">
      <button
        type="button"
        className="icon-button learn-exit"
        onClick={onExit}
        aria-label="退出，返回今日"
        title="退出（Esc）"
      >
        <X size={22} aria-hidden="true" />
      </button>
      {title ? <span className="learn-header-title">{title}</span> : null}
      {showTrack ? (
        <div
          className="learn-track"
          role="progressbar"
          aria-label="本组进度"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.min(done ?? 0, total)}
        >
          <span
            style={{
              transform: `scaleX(${Math.min(1, (done ?? 0) / total)})`,
            }}
          />
        </div>
      ) : (
        <span className="learn-header-spacer" />
      )}
      {count ? <strong className="learn-count">{count}</strong> : null}
      {children}
    </header>
  );
}

/** The opening screen every mode shares: what it is, which words, and one start button. */
export function LearnIntro({
  symbol,
  title,
  lead,
  data,
  bookId,
  unit,
  onCourse,
  onExit,
  meta,
  children,
  note,
  action,
}: {
  symbol: SymbolName;
  title: string;
  lead: string;
  meta: ReactNode;
  children?: ReactNode;
  note?: ReactNode;
  action: ReactNode;
} & Pick<LearnModeProps, "data" | "bookId" | "unit" | "onCourse" | "onExit">) {
  const heading = useScreenFocus<HTMLHeadingElement>("intro");
  return (
    <>
      <LearnHeader onExit={onExit} />
      <main className="learn-stage learn-intro">
        <span className="learn-intro-symbol">
          <StudioSymbol name={symbol} size={34} />
        </span>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="learn-lead">{lead}</p>
        <section className="learn-course" aria-label="练习范围">
          <CoursePicker
            entries={data.index}
            bookId={bookId}
            unit={unit}
            onChange={onCourse}
          />
          <p className="learn-course-meta">{meta}</p>
        </section>
        {children}
        <div className="learn-intro-action">{action}</div>
        {note ? <p className="learn-note">{note}</p> : null}
      </main>
    </>
  );
}

/** A generated illustration for a finished set. Purely decorative; the frame keeps its size. */
export function CompletionArt({
  kind,
  seed,
  theme,
}: {
  kind: ArtKind;
  seed: string;
  theme: Vocabulary["settings"]["theme"];
}) {
  const dark = useDarkAppearance(theme);
  const [time] = useState(() => timeOfDay(new Date()));
  return (
    <div className="learn-art-frame" aria-hidden="true">
      <Artwork
        kind={kind}
        seed={seed}
        time={dark ? "night" : time}
        className="learn-art"
        eager
      />
    </div>
  );
}

export type HearItem = {
  id: string;
  headword: string;
  meaning: string;
  mark?: "right" | "wrong";
  note?: string;
};

/** Words to look at again. Each row speaks its word, because hearing it is the cheapest review. */
export function HearList({
  title,
  items,
  notify,
}: {
  title: string;
  items: HearItem[];
  notify: Vocabulary["notify"];
}) {
  if (!items.length) return null;
  return (
    <section className="learn-list" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="learn-list-row"
              onClick={() => speak(item.headword, notify)}
            >
              {item.mark ? (
                <span className={`learn-mark is-${item.mark}`}>
                  {item.mark === "right" ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <X size={16} aria-hidden="true" />
                  )}
                  <span className="learn-sr">
                    {item.mark === "right" ? "答对" : "答错"}
                  </span>
                </span>
              ) : null}
              <span className="learn-list-word" lang="en">
                {item.headword}
              </span>
              <span className="learn-list-meaning">
                {item.meaning}
                {item.note ? <small>{item.note}</small> : null}
              </span>
              <Volume2 size={17} aria-hidden="true" className="learn-list-sound" />
              <span className="learn-sr">，播放发音</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LiveRegion({ message }: { message: string }) {
  return (
    <p className="learn-sr" role="status" aria-live="polite">
      {message}
    </p>
  );
}

export function LearnPending() {
  return (
    <p className="learn-pending" role="status">
      正在准备…
    </p>
  );
}
