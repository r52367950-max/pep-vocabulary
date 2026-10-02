import { classifyMistake, type HeadwordLookup, type MistakeKind } from "./mistakes";
import { chronologicalReviews } from "./progress";
import type { ReviewEvent, StoredCard } from "./storage";
import { clip, PROFILE_LIMITS, type LearnerProfile } from "./assistant/profile";

const KINDS: MistakeKind[] = ["near-miss", "confusion", "spelling", "recall", "listening"];

export function buildLearnerProfile({ reviews, cards, lookup, now = new Date(), writing = null }: {
  reviews: readonly ReviewEvent[];
  cards: ReadonlyMap<string, StoredCard>;
  lookup: HeadwordLookup;
  now?: Date;
  writing?: LearnerProfile["writing"];
}): LearnerProfile {
  reviews = chronologicalReviews(reviews);
  const errorCounts = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<MistakeKind, number>;
  const perWord = new Map<string, { errors: number; lastKind: MistakeKind | null }>();
  const recentMistakes: LearnerProfile["recentMistakes"] = [];
  const pairs = new Map<string, LearnerProfile["confusions"][number]>();
  const weekAgo = now.getTime() - 7 * 86_400_000, monthAgo = now.getTime() - 30 * 86_400_000;
  let week = 0, weekCorrect = 0;
  const days = new Set<string>();
  // Newest first, so "recent" really is recent and the lists stop filling early.
  for (let i = reviews.length - 1; i >= 0; i--) {
    const event = reviews[i];
    const at = Date.parse(event.timestampUtc);
    if (at >= weekAgo) { week++; if (event.correct) weekCorrect++; }
    if (at >= monthAgo) days.add(event.localDate);
    const mistake = classifyMistake(event, lookup);
    if (!mistake) continue;
    errorCounts[mistake.kind]++;
    const word = perWord.get(event.cardId) || { errors: 0, lastKind: mistake.kind };
    word.errors++;
    perWord.set(event.cardId, word);
    if (recentMistakes.length < PROFILE_LIMITS.recentMistakes) recentMistakes.push({
      id: event.cardId, question: event.questionType, kind: mistake.kind,
      given: event.answerGiven ? clip(event.answerGiven, PROFILE_LIMITS.answerLength) : null,
      expected: event.expectedAnswer ? clip(event.expectedAnswer, PROFILE_LIMITS.answerLength) : null,
    });
    if (mistake.confusedWith) {
      const key = [event.cardId, mistake.confusedWith].sort().join("|");
      const pair = pairs.get(key) || { id: event.cardId, withId: mistake.confusedWith, count: 0 };
      pair.count++;
      pairs.set(key, pair);
    }
  }
  const weakWords = [...perWord.entries()]
    .map(([id, word]) => ({ id, errors: word.errors, lapses: Number(cards.get(id)?.fsrs.lapses || 0), lastKind: word.lastKind }))
    .filter((word) => cards.get(word.id)?.status !== "mastered" || word.errors > 2)
    .sort((a, b) => b.errors + b.lapses - (a.errors + a.lapses) || a.id.localeCompare(b.id))
    .slice(0, PROFILE_LIMITS.weakWords);
  const notes = [...cards.values()]
    .filter((card) => card.note?.trim())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, PROFILE_LIMITS.notes)
    .map((card) => ({ id: card.id, text: clip(card.note!.trim(), PROFILE_LIMITS.noteLength) }));
  return {
    date: now.toLocaleDateString("sv-SE"),
    totals: {
      reviews: reviews.length,
      words: new Set(reviews.map((event) => event.cardId)).size,
      accuracy7d: week ? Math.round((weekCorrect / week) * 100) : null,
      activeDays30: days.size,
    },
    errorCounts,
    weakWords,
    recentMistakes,
    notes,
    confusions: [...pairs.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, PROFILE_LIMITS.confusions),
    writing,
  };
}
