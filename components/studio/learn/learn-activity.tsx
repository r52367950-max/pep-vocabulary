"use client";

import { lazy, Suspense, useEffect, useEffectEvent } from "react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import type { LearnMode } from "@/lib/learn";
import { LearnPending } from "./parts";

const Flashcards = lazy(() => import("./flashcards"));
const Match = lazy(() => import("./match"));
const Quiz = lazy(() => import("./quiz"));

export type LearnActivityProps = {
  data: Vocabulary;
  mode: LearnMode;
  bookId: string;
  unit: string;
  onCourse: (book: string, unit: string) => void;
  onExit: () => void;
  onPractice: (entries: LexiconIndexEntry[], mode: "new" | "mistakes") => void;
};

/**
 * A full-screen surface for the three memorisation modes. None of them records a
 * review; words that need work go to the regular practice session via onPractice.
 */
export default function LearnActivity({ mode, ...props }: LearnActivityProps) {
  const exit = useEffectEvent(() => props.onExit());
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      if (document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      // First Escape leaves a text field or menu; the next one leaves the activity.
      if (target?.closest?.("input, textarea, select, [contenteditable]")) {
        target.blur();
        return;
      }
      event.preventDefault();
      exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="learn-screen" data-mode={mode}>
      <Suspense fallback={<LearnPending />}>
        {mode === "cards" ? (
          <Flashcards {...props} />
        ) : mode === "match" ? (
          <Match {...props} />
        ) : (
          <Quiz {...props} />
        )}
      </Suspense>
    </div>
  );
}
