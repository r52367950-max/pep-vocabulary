"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadLexicon,
  type LexiconIndexEntry,
  type LexiconManifest,
} from "@/lib/lexicon";
import { requestPersistentStorage, takeBackupReminder } from "@/lib/persistence";
import { ReviewHistory } from "@/lib/progress";
import { newStoredCard } from "@/lib/scheduler";
import {
  commitReview,
  defaultSettings,
  getAll,
  loadSettings,
  patchSettings,
  loadLearningState,
  updateCardMetadata,
  type AppSettings,
  type ReviewEvent,
  type StoredCard,
} from "@/lib/storage";
import { notify } from "./toast-store";

export function useVocabulary() {
  const [index, setIndex] = useState<LexiconIndexEntry[]>([]);
  const [manifest, setManifest] = useState<LexiconManifest | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [cards, setCards] = useState<Map<string, StoredCard>>(new Map());
  const [history, setHistory] = useState(() => new ReviewHistory());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const writes = useRef(Promise.resolve());
  const channel = useRef<BroadcastChannel | null>(null);
  const persistAsked = useRef(false);

  const reload = useCallback(async () => {
    const { cards: storedCards, events: storedEvents, settings: storedSettings } = await loadLearningState();
    setCards(new Map(storedCards.map((card) => [card.id, card])));
    setHistory(ReviewHistory.from(storedEvents));
    setSettings(storedSettings);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadLexicon(),
      loadLearningState(),
    ])
      .then(([lexicon, { cards: storedCards, events: storedEvents, settings: storedSettings }]) => {
        if (!active) return;
        setIndex(lexicon.index);
        setManifest(lexicon.manifest);
        setCards(new Map(storedCards.map((card) => [card.id, card])));
        setHistory(ReviewHistory.from(storedEvents));
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
      // Serialize refreshes so an older snapshot cannot arrive after a newer one.
      let refresh = Promise.resolve();
      listener.onmessage = ({ data: change }) => {
        refresh = refresh.then(async () => {
          if (!active) return;
          if (change === "settings") {
            const next = await loadSettings();
            if (active) setSettings(next);
          } else if (change === "metadata") {
            const next = await getAll<StoredCard>("cards");
            if (active) setCards(new Map(next.map((card) => [card.id, card])));
          } else await reload();
        }).catch(() => notify("其他页面更新了数据，请重新加载。"));
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

  // Never on first paint for a new user: ask once there is history, or after the first answer.
  const hasHistory = !loading && history.size > 0;
  useEffect(() => {
    if (!hasHistory || persistAsked.current) return;
    persistAsked.current = true;
    void requestPersistentStorage().then((persisted) => {
      if (!persisted && takeBackupReminder())
        notify("浏览器可能在空间不足时清理本机数据，建议在“数据与备份”中导出 JSON 备份。");
    });
  }, [hasHistory]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    // Keep the browser chrome in step with the in-app theme, not only the system one.
    if (settings.theme === "system") return;
    const color = settings.theme === "dark" ? "#000000" : "#ffffff";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { meta.dataset.system ??= meta.content; meta.content = color; });
    return () => document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => { if (meta.dataset.system) meta.content = meta.dataset.system; });
  }, [settings.theme]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    writes.current = writes.current
      .then(async () => {
        const next = await patchSettings(patch);
        setSettings(next);
        channel.current?.postMessage("settings");
      })
      .catch(() => notify("设置未能保存，请重试。"));
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
    // Appends in place and hands back a new handle, so answering never copies the event list.
    setHistory((previous) => previous.append(event));
    channel.current?.postMessage("review");
    if (!persistAsked.current) {
      persistAsked.current = true;
      void requestPersistentStorage();
    }
  }, []);

  const metadata = useCallback(
    async (id: string, patch: { note?: string; toggleFavorite?: boolean }) => {
      try {
        const card = await updateCardMetadata(newStoredCard(id), patch);
        setCards((previous) => new Map(previous).set(id, card));
        channel.current?.postMessage("metadata");
        return true;
      } catch {
        notify("未能保存，请重试。");
        return false;
      }
    },
    [],
  );

  // Built once per lexicon load and shared, so views do not rescan the 4,681 entries.
  const byId = useMemo(
    () => new Map(index.map((entry) => [entry.id, entry])),
    [index],
  );

  // A stable object: consumers that depend on `data` re-run only when the data itself changes.
  // Toast messages live in ./toast-store so they do not re-render the app.
  return useMemo(
    () => ({
      index,
      byId,
      manifest,
      settings,
      cards,
      history,
      loading,
      error,
      online,
      notify,
      updateSettings,
      saveReview,
      metadata,
      reload,
    }),
    [
      index,
      byId,
      manifest,
      settings,
      cards,
      history,
      loading,
      error,
      online,
      updateSettings,
      saveReview,
      metadata,
      reload,
    ],
  );
}

export type Vocabulary = ReturnType<typeof useVocabulary>;
