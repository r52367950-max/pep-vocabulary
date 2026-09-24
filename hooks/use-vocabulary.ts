"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadLexicon,
  type LexiconIndexEntry,
  type LexiconManifest,
} from "@/lib/lexicon";
import { newStoredCard } from "@/lib/scheduler";
import {
  commitReview,
  defaultSettings,
  getAll,
  loadSettings,
  saveSettings,
  updateCardMetadata,
  type AppSettings,
  type ReviewEvent,
  type StoredCard,
} from "@/lib/storage";

export function useVocabulary() {
  const [index, setIndex] = useState<LexiconIndexEntry[]>([]);
  const [manifest, setManifest] = useState<LexiconManifest | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [cards, setCards] = useState<Map<string, StoredCard>>(new Map());
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const writes = useRef(Promise.resolve());
  const channel = useRef<BroadcastChannel | null>(null);

  const reload = useCallback(async () => {
    const [storedCards, storedEvents, storedSettings] = await Promise.all([
      getAll<StoredCard>("cards"),
      getAll<ReviewEvent>("events"),
      loadSettings(),
    ]);
    setCards(new Map(storedCards.map((card) => [card.id, card])));
    setEvents(storedEvents);
    setSettings(storedSettings);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadLexicon(),
      getAll<StoredCard>("cards"),
      getAll<ReviewEvent>("events"),
      loadSettings(),
    ])
      .then(([lexicon, storedCards, storedEvents, storedSettings]) => {
        if (!active) return;
        setIndex(lexicon.index);
        setManifest(lexicon.manifest);
        setCards(new Map(storedCards.map((card) => [card.id, card])));
        setEvents(storedEvents);
        setSettings(storedSettings);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "无法读取学习数据");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const connection = () => setOnline(navigator.onLine);
    connection();
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production")
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    if (typeof BroadcastChannel !== "undefined") {
      const listener = new BroadcastChannel("vocab-changes");
      channel.current = listener;
      listener.onmessage = () => {
        void reload().catch(() => setToast("其他页面更新了数据，请重新加载。"));
      };
    }
    return () => {
      active = false;
      channel.current?.close();
      channel.current = null;
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, [reload]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    // Keep the browser chrome in step with the in-app theme, not only the system one.
    if (settings.theme === "system") return;
    const color = settings.theme === "dark" ? "#000000" : "#ffffff";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { meta.dataset.system ??= meta.content; meta.content = color; });
    return () => document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { if (meta.dataset.system) meta.content = meta.dataset.system; });
  }, [settings.theme]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    writes.current = writes.current
      .then(async () => {
        const next = await saveSettings({
          ...(await loadSettings()),
          ...patch,
        });
        setSettings(next);
        channel.current?.postMessage("settings");
      })
      .catch(() => setToast("设置未能保存，请重试。"));
    await writes.current;
  }, []);

  const saveReview = useCallback(async (event: ReviewEvent) => {
    await commitReview(event);
    setCards((previous) => {
      const next = new Map(previous);
      if (event.eventType === "undo") {
        if (event.before) next.set(event.cardId, event.before);
        else next.delete(event.cardId);
      } else next.set(event.cardId, event.after);
      return next;
    });
    setEvents((previous) => [...previous, event]);
    channel.current?.postMessage("review");
  }, []);

  const metadata = useCallback(
    async (id: string, patch: { note?: string; toggleFavorite?: boolean }) => {
      try {
        const card = await updateCardMetadata(newStoredCard(id), patch);
        setCards((previous) => new Map(previous).set(id, card));
        channel.current?.postMessage("metadata");
        return true;
      } catch {
        setToast("未能保存，请重试。");
        return false;
      }
    },
    [],
  );

  return {
    index,
    manifest,
    settings,
    cards,
    events,
    loading,
    error,
    online,
    toast,
    notify: setToast,
    updateSettings,
    saveReview,
    metadata,
    reload,
  };
}

export type Vocabulary = ReturnType<typeof useVocabulary>;
