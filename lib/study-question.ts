import type { LexiconDetail, LexiconIndexEntry } from "./lexicon";
import { buildQuestion, type Question, type QuestionType } from "./questions";
import type { StudySessionState } from "./session";
import type { StoredCard } from "./storage";

export type StudyQuestionSnapshot = { stepId: string; question: Question };

/** A displayed exercise stays fixed while its card can receive other reviews. */
export function prepareStudyQuestion(
  previous: StudyQuestionSnapshot | null,
  {
    stepId,
    session,
    entry,
    detail,
    card,
    pool,
    ready,
  }: {
    stepId: string;
    session: Pick<StudySessionState, "mode" | "results">;
    entry: LexiconIndexEntry | undefined;
    detail: LexiconDetail | undefined;
    card: StoredCard | undefined;
    pool: LexiconIndexEntry[];
    ready: boolean;
  },
): StudyQuestionSnapshot | null {
  if (previous?.stepId === stepId) return previous;
  if (!entry || !ready) return null;
  const type: QuestionType =
    session.mode === "dictation"
      ? "dictation"
      : session.mode === "context"
        ? "context-choice"
        : session.mode === "mistakes" ||
            session.results.some((result) => result.wordId === entry.id)
          ? "spelling"
          : !card?.lastReviewed
            ? "meaning-recall"
            : (
                ["meaning-recall", "spelling", "context-choice"] as QuestionType[]
              )[Number(card.fsrs.reps || 0) % 3];
  return { stepId, question: buildQuestion(entry, detail, type, pool) };
}
