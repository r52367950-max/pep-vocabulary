import type { ReviewEvent } from "./storage";

export function activeReviews(events: readonly ReviewEvent[]) {
  const undone = new Set(
    events.filter((e) => e.eventType === "undo").map((e) => e.targetEventId),
  );
  return events.filter((e) => e.eventType !== "undo" && !undone.has(e.eventId));
}

export function studyStats(events: readonly ReviewEvent[], now = new Date()) {
  const reviews = activeReviews(events);
  const today = now.toLocaleDateString("sv-SE");
  const todayEvents = reviews.filter((e) => e.localDate === today);
  const days = new Set(reviews.map((e) => e.localDate));
  const cursor = new Date(now);
  if (!days.has(today)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.toLocaleDateString("sv-SE"))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    reviews,
    todayEvents,
    streak,
    todayWords: new Set(todayEvents.map((e) => e.cardId)).size,
    todayNew: new Set(
      todayEvents.filter((e) => !e.before?.lastReviewed).map((e) => e.cardId),
    ).size,
    todayMinutes: Math.round(
      todayEvents.reduce((sum, e) => sum + Math.min(e.responseMs, 300_000), 0) /
        60_000,
    ),
    accuracy: todayEvents.length
      ? Math.round(
          (todayEvents.filter((e) => e.correct).length / todayEvents.length) *
            100,
        )
      : null,
  };
}
