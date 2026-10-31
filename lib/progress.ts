import type { ReviewEvent } from "./storage";

/** Absolute time, with a fixed ID tie-breaker so reload and arrival order agree. */
function compareReviews(a: ReviewEvent, b: ReviewEvent) {
  const aTime = Date.parse(a.timestampUtc), bTime = Date.parse(b.timestampUtc);
  // Invalid legacy timestamps sort before dated records, without changing their payloads.
  const at = Number.isFinite(aTime) ? aTime : -Infinity;
  const bt = Number.isFinite(bTime) ? bTime : -Infinity;
  return at !== bt ? (at < bt ? -1 : 1) : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Oldest first. Already ordered inputs are reused; unordered arrays are copied. */
export function chronologicalReviews(reviews: readonly ReviewEvent[]): readonly ReviewEvent[] {
  for (let i = 1; i < reviews.length; i++)
    if (compareReviews(reviews[i - 1], reviews[i]) > 0)
      return [...reviews].sort(compareReviews);
  return reviews;
}

export function activeReviews(events: readonly ReviewEvent[]) {
  const undone = new Set(
    events.filter((e) => e.eventType === "undo").map((e) => e.targetEventId),
  );
  return chronologicalReviews(events.filter((e) => e.eventType !== "undo" && !undone.has(e.eventId)));
}

const localDay = (date: Date) => date.toLocaleDateString("sv-SE");

function streakOf(days: { has(day: string): boolean }, now: Date, today: string) {
  const cursor = new Date(now);
  if (!days.has(today)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(localDay(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function summarize(
  reviews: readonly ReviewEvent[],
  todayEvents: readonly ReviewEvent[],
  days: { has(day: string): boolean },
  now: Date,
  today: string,
) {
  const streak = streakOf(days, now, today);
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

export type StudyStats = ReturnType<typeof summarize>;

export function studyStats(events: readonly ReviewEvent[], now = new Date()) {
  const reviews = activeReviews(events);
  const today = localDay(now);
  const days = new Set(reviews.map((e) => e.localDate));
  return summarize(
    reviews,
    reviews.filter((e) => e.localDate === today),
    days,
    now,
    today,
  );
}

/** One local day's active reviews with the running totals the Today stats need. */
type DayBucket = {
  events: ReviewEvent[];
  cards: Map<string, number>;
  fresh: Map<string, number>;
  ms: number;
  correct: number;
};

const bump = (map: Map<string, number>, key: string, by: 1 | -1) => {
  const count = (map.get(key) || 0) + by;
  if (count > 0) map.set(key, count);
  else map.delete(key);
};
const isFresh = (event: ReviewEvent) => !event.before?.lastReviewed;
const spent = (event: ReviewEvent) => Math.min(event.responseMs, 300_000);

type HistoryStore = {
  version: number;
  events: ReviewEvent[];
  ids: Set<string>;
  undone: Set<string>;
  undos: ReviewEvent[];
  active: ReviewEvent[];
  days: Map<string, DayBucket>;
  cards: Map<string, number>;
  cache: { version: number; today: string; value: StudyStats } | null;
};

const newStore = (): HistoryStore => ({
  version: 0,
  events: [],
  ids: new Set(),
  undone: new Set(),
  undos: [],
  active: [],
  days: new Map(),
  cards: new Map(),
  cache: null,
});

function removeLast<T>(list: T[], item: T) {
  const at = list.lastIndexOf(item);
  if (at >= 0) list.splice(at, 1);
}

function insertChronologically(list: ReviewEvent[], event: ReviewEvent) {
  if (!list.length || compareReviews(list[list.length - 1], event) <= 0) {
    list.push(event);
    return;
  }
  // Only late arrivals or clock rollback need to move existing entries.
  let low = 0, high = list.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareReviews(list[middle], event) <= 0) low = middle + 1;
    else high = middle;
  }
  list.splice(low, 0, event);
}

function activate(store: HistoryStore, event: ReviewEvent) {
  insertChronologically(store.active, event);
  let day = store.days.get(event.localDate);
  if (!day) {
    day = { events: [], cards: new Map(), fresh: new Map(), ms: 0, correct: 0 };
    store.days.set(event.localDate, day);
  }
  insertChronologically(day.events, event);
  bump(day.cards, event.cardId, 1);
  if (isFresh(event)) bump(day.fresh, event.cardId, 1);
  day.ms += spent(event);
  if (event.correct) day.correct++;
  bump(store.cards, event.cardId, 1);
}

function deactivate(store: HistoryStore, event: ReviewEvent) {
  removeLast(store.active, event);
  const day = store.days.get(event.localDate);
  if (day) {
    removeLast(day.events, event);
    bump(day.cards, event.cardId, -1);
    if (isFresh(event)) bump(day.fresh, event.cardId, -1);
    day.ms -= spent(event);
    if (event.correct) day.correct--;
    if (!day.events.length) store.days.delete(event.localDate);
  }
  bump(store.cards, event.cardId, -1);
}

/**
 * Review history that grows in place: chronological review appends are O(1) amortised; late arrivals
 * use binary insertion. Active reviews, per-day buckets and stats stay in step without rescanning.
 * A handle is a cheap immutable-looking token over a shared store; each change returns a new one so
 * React deps re-run. A stale handle reads the latest data, which only defers a render, never corrupts it.
 */
export class ReviewHistory {
  readonly version: number;
  private readonly store: HistoryStore;

  constructor(store: HistoryStore = newStore()) {
    this.store = store;
    this.version = store.version;
  }

  /** Preserves persisted audit order and builds chronological active-review indexes. */
  static from(events: readonly ReviewEvent[]) {
    const store = newStore();
    for (const event of events) {
      if (store.ids.has(event.eventId)) continue;
      store.ids.add(event.eventId);
      store.events.push(event);
      if (event.eventType === "undo") {
        store.undos.push(event);
        store.undone.add(event.targetEventId ?? "");
      }
    }
    const active = chronologicalReviews(store.events.filter(
      (event) => event.eventType !== "undo" && !store.undone.has(event.eventId),
    ));
    for (const event of active) activate(store, event);
    store.version = 1;
    return new ReviewHistory(store);
  }

  /** Adds one committed event and returns the handle for the new state. Repeated ids are ignored. */
  append(event: ReviewEvent) {
    const store = this.store;
    if (store.ids.has(event.eventId)) return new ReviewHistory(store);
    store.ids.add(event.eventId);
    store.events.push(event);
    if (event.eventType === "undo") {
      store.undos.push(event);
      const target = event.targetEventId ?? "";
      if (!store.undone.has(target)) {
        store.undone.add(target);
        const hit = this.lastActive(target);
        if (hit) deactivate(store, hit);
      }
    } else if (!store.undone.has(event.eventId)) activate(store, event);
    store.version++;
    return new ReviewHistory(store);
  }

  private lastActive(eventId: string) {
    const active = this.store.active;
    for (let i = active.length - 1; i >= 0; i--)
      if (active[i].eventId === eventId) return active[i];
    return undefined;
  }

  get size() {
    return this.store.events.length;
  }
  /** Every event in load/append order, undo events included. Read-only. */
  get events(): readonly ReviewEvent[] {
    return this.store.events;
  }
  get undos(): readonly ReviewEvent[] {
    return this.store.undos;
  }
  /** Active reviews, oldest first by absolute time then event ID. Read-only. */
  get active(): readonly ReviewEvent[] {
    return this.store.active;
  }
  /** Distinct cards with at least one active review. */
  get learnedWords() {
    return this.store.cards.size;
  }
  /** Distinct cards reviewed on a local date. */
  dayWords(day: string) {
    return this.store.days.get(day)?.cards.size ?? 0;
  }
  /** Newest first. */
  recent(count: number) {
    const active = this.store.active;
    return active.slice(Math.max(0, active.length - count)).reverse();
  }

  /** Cached per version and local date, so every view of one change shares one computation. */
  stats(now = new Date()): StudyStats {
    const store = this.store;
    const today = localDay(now);
    const hit = store.cache;
    if (hit && hit.version === store.version && hit.today === today)
      return hit.value;
    const bucket = store.days.get(today);
    const count = bucket?.events.length ?? 0;
    const value: StudyStats = {
      reviews: store.active,
      todayEvents: bucket ? [...bucket.events] : [],
      streak: streakOf(store.days, now, today),
      todayWords: bucket?.cards.size ?? 0,
      todayNew: bucket?.fresh.size ?? 0,
      todayMinutes: Math.round((bucket?.ms ?? 0) / 60_000),
      accuracy: bucket ? Math.round((bucket.correct / count) * 100) : null,
    };
    store.cache = { version: store.version, today, value };
    return value;
  }
}

export type ReviewSource = readonly ReviewEvent[] | ReviewHistory;
export const activeOf = (source: ReviewSource) =>
  source instanceof ReviewHistory ? source.active : activeReviews(source);
export const undosOf = (source: ReviewSource) =>
  source instanceof ReviewHistory
    ? source.undos
    : source.filter((e) => e.eventType === "undo");
