"use client";

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, ArrowRight, Undo2 } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import {
  loadDetails,
  type LexiconDetail,
  type LexiconIndexEntry,
} from "@/lib/lexicon";
import { getEntryExample } from "@/lib/questions";
import {
  FLASH_DECK_SIZE,
  buildFlashDeck,
  decideFlash,
  flashDone,
  isUnseen,
  learnPool,
  project,
  rubberband,
  shortMeaning,
  springAt,
  startFlash,
  summarizeFlash,
  swipeDecision,
  undoFlash,
  type FlashState,
} from "@/lib/learn";
import { Pronounce, sourceLabel } from "../shared";
import {
  CompletionArt,
  HearList,
  LearnHeader,
  LearnIntro,
  LiveRegion,
  prefersReducedMotion,
  speak,
  useScreenFocus,
  type LearnModeProps,
} from "./parts";

type LastAction = "known" | "again" | "undo" | null;

export default function Flashcards({
  data,
  bookId,
  unit,
  onCourse,
  onExit,
  onPractice,
}: LearnModeProps) {
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, LexiconDetail>>(
    () => new Map(),
  );
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [day, setDay] = useState("");
  const seen = useRef(new Set<string>());
  const byId = useMemo(
    () => new Map(data.index.map((entry) => [entry.id, entry])),
    [data.index],
  );
  const pool = useMemo(
    () => learnPool(data.index, data.cards, { bookId, unit }),
    [data.index, data.cards, bookId, unit],
  );
  const fresh = pool.filter((entry) => isUnseen(data.cards.get(entry.id))).length;
  const deckKey = flash
    ? flash.queue
        .filter((item) => !item.repeat)
        .map((item) => item.id)
        .join("|")
    : "";

  useEffect(() => {
    if (!deckKey) return;
    let active = true;
    loadDetails(deckKey.split("|"))
      .then((rows) => {
        if (!active) return;
        setDetails(
          (previous) =>
            new Map([...previous, ...rows.map((row) => [row.id, row] as const)]),
        );
        setDetailsFailed(false);
      })
      .catch(() => {
        if (active) setDetailsFailed(true);
      });
    return () => {
      active = false;
    };
  }, [deckKey]);

  const start = () => {
    const deck = buildFlashDeck(data.index, data.cards, {
      bookId,
      unit,
      now: new Date(),
      exclude: seen.current,
    });
    if (!deck.length) {
      data.notify("这个范围暂时没有可以翻看的词，换一个单元试试。");
      return;
    }
    // Once every word has been through a sitting, start over from the top.
    if (deck.every((entry) => seen.current.has(entry.id))) seen.current.clear();
    deck.forEach((entry) => seen.current.add(entry.id));
    setFlash(startFlash(deck));
    setLastAction(null);
    setDay(new Date().toLocaleDateString("sv-SE"));
  };

  if (!flash)
    return (
      <LearnIntro
        symbol="cards"
        title="词卡速记"
        lead="第一次见的词，先快速过一遍。认识的往右滑，没把握的往左滑，它会在这组最后再出现一次。"
        data={data}
        bookId={bookId}
        unit={unit}
        onCourse={onCourse}
        onExit={onExit}
        meta={
          pool.length
            ? `可翻看 ${pool.length} 个词，其中 ${fresh} 个还没学过。每组 ${Math.min(FLASH_DECK_SIZE, pool.length)} 张。`
            : "这个范围没有可以翻看的词，换一个单元试试。"
        }
        note="词卡只用来熟悉单词，不会改变复习计划。"
        action={
          <button
            type="button"
            className="primary learn-start"
            disabled={!pool.length}
            onClick={start}
          >
            开始翻看
          </button>
        }
      />
    );

  if (flashDone(flash))
    return (
      <FlashDone
        data={data}
        state={flash}
        byId={byId}
        day={day}
        onUndo={() => {
          setFlash(undoFlash(flash));
          setLastAction("undo");
        }}
        onAgain={start}
        onExit={onExit}
        onPractice={onPractice}
      />
    );

  return (
    <FlashPlay
      data={data}
      state={flash}
      byId={byId}
      details={details}
      detailsFailed={detailsFailed}
      lastAction={lastAction}
      onDecide={(known) => {
        setFlash((state) => (state ? decideFlash(state, known) : state));
        setLastAction(known ? "known" : "again");
      }}
      onUndo={() => {
        setFlash((state) => (state ? undoFlash(state) : state));
        setLastAction("undo");
      }}
      onExit={onExit}
    />
  );
}

// ---------------------------------------------------------------------------

type Drag = {
  id: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  active: boolean;
  cancelled: boolean;
  samples: Array<{ x: number; y: number; t: number }>;
};
type Motion = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  frame: number;
  /** A decision whose card is still flying off; committed when it leaves the screen. */
  pending: boolean | null;
  /** prefers-reduced-motion, read once per interaction rather than every frame. */
  reduced: boolean;
  drag: Drag | null;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** Velocity over the last ~100ms of movement; a finger that paused before lifting has none. */
function releaseVelocity(samples: Drag["samples"], now: number) {
  const recent = samples.filter((sample) => now - sample.t <= 100);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last === first || now - last.t > 60)
    return { vx: 0, vy: 0 };
  const seconds = (last.t - first.t) / 1000;
  if (seconds <= 0) return { vx: 0, vy: 0 };
  return {
    vx: clamp((last.x - first.x) / seconds, -6000, 6000),
    vy: clamp((last.y - first.y) / seconds, -6000, 6000),
  };
}

const undoKeys =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? "⌘Z"
    : "Ctrl+Z";

function exitDistance(width: number) {
  return window.innerWidth / 2 + width / 2 + 80;
}

function FlashPlay({
  data,
  state,
  byId,
  details,
  detailsFailed,
  lastAction,
  onDecide,
  onUndo,
  onExit,
}: {
  data: Vocabulary;
  state: FlashState;
  byId: ReadonlyMap<string, LexiconIndexEntry>;
  details: ReadonlyMap<string, LexiconDetail>;
  detailsFailed: boolean;
  lastAction: LastAction;
  onDecide: (known: boolean) => void;
  onUndo: () => void;
  onExit: () => void;
}) {
  const top = state.queue[state.position];
  const next = state.queue[state.position + 1];
  const topEntry = top ? byId.get(top.id) : undefined;
  const nextEntry = next ? byId.get(next.id) : undefined;
  const [flippedKey, setFlippedKey] = useState<string | null>(null);
  const flipped = Boolean(top && flippedKey === top.key);
  const cardRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const enter = useRef<{ key: string; from: 1 | -1 } | null>(null);
  const motion = useRef<Motion>({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    width: 360,
    frame: 0,
    pending: null,
    reduced: false,
    drag: null,
  });
  const heading = useScreenFocus<HTMLHeadingElement>("play");

  const paint = () => {
    const m = motion.current;
    const card = cardRef.current;
    const width = m.width || 360;
    if (card) {
      const rotate = m.reduced ? 0 : clamp((m.x / width) * 12, -16, 16);
      card.style.transform =
        m.x || m.y
          ? `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0) rotate(${rotate.toFixed(2)}deg)`
          : "";
      const fade = clamp((Math.abs(m.x) - width * 0.7) / width, 0, 0.5);
      card.style.opacity = fade ? String(1 - fade) : "";
      const lean = clamp(Math.abs(m.x) / (width * 0.35), 0, 1);
      card.style.setProperty("--learn-known", m.x > 0 ? lean.toFixed(3) : "0");
      card.style.setProperty("--learn-again", m.x < 0 ? lean.toFixed(3) : "0");
    }
    deckRef.current?.style.setProperty(
      "--learn-lift",
      clamp(Math.abs(m.x) / (width * 0.7), 0, 1).toFixed(3),
    );
  };

  const stop = () => {
    const m = motion.current;
    if (m.frame) cancelAnimationFrame(m.frame);
    m.frame = 0;
  };

  /** Critically damped X/Y springs from the current on-screen value and velocity. */
  const animate = (
    targetX: number,
    targetY: number,
    {
      response,
      vx = motion.current.vx,
      vy = motion.current.vy,
      until,
      done,
    }: {
      response: number;
      vx?: number;
      vy?: number;
      until?: () => boolean;
      done?: () => void;
    },
  ) => {
    stop();
    const m = motion.current;
    const x0 = m.x - targetX;
    const y0 = m.y - targetY;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.max(0, (now - started) / 1000);
      const X = springAt(x0, vx, response, t);
      const Y = springAt(y0, vy, response, t);
      m.x = targetX + X.x;
      m.y = targetY + Y.x;
      m.vx = X.v;
      m.vy = Y.v;
      const settled =
        Math.abs(X.x) < 0.4 &&
        Math.abs(Y.x) < 0.4 &&
        Math.abs(X.v) < 12 &&
        Math.abs(Y.v) < 12;
      if (settled) {
        m.x = targetX;
        m.y = targetY;
        m.vx = 0;
        m.vy = 0;
      }
      paint();
      if (settled || until?.()) {
        m.frame = 0;
        done?.();
        return;
      }
      m.frame = requestAnimationFrame(step);
    };
    m.frame = requestAnimationFrame(step);
  };

  const commitPending = () => {
    const m = motion.current;
    if (m.pending === null) return false;
    const known = m.pending;
    m.pending = null;
    stop();
    onDecide(known);
    return true;
  };

  const settleBack = (vx = 0, vy = 0) => {
    if (motion.current.reduced) {
      stop();
      Object.assign(motion.current, { x: 0, y: 0, vx: 0, vy: 0 });
      paint();
      return;
    }
    animate(0, 0, { response: 0.4, vx, vy });
  };

  const fling = (direction: 1 | -1, vx: number, vy: number) => {
    const known = direction > 0;
    if (motion.current.reduced) {
      stop();
      onDecide(known);
      return;
    }
    const m = motion.current;
    const exit = exitDistance(m.width);
    m.pending = known;
    animate(direction * exit * 1.35, m.y + clamp(project(vy) * 0.3, -140, 140), {
      response: 0.55,
      vx,
      vy: vy * 0.4,
      until: () => Math.abs(m.x) >= exit,
      done: commitPending,
    });
  };

  const decide = (known: boolean) => {
    const m = motion.current;
    if (!top || m.drag?.active) return;
    // Never lock input during a transition: finish the card in flight, then act on the next.
    if (commitPending()) {
      onDecide(known);
      return;
    }
    m.width = cardRef.current?.offsetWidth || m.width;
    m.reduced = prefersReducedMotion();
    const direction = known ? 1 : -1;
    fling(direction, direction * 900 + m.vx, -160);
  };

  const undo = () => {
    const m = motion.current;
    // A card still flying off has not been decided yet: catch it and bring it back.
    if (m.pending !== null) {
      m.pending = null;
      settleBack(m.vx, m.vy);
      return;
    }
    const last = state.decisions[state.decisions.length - 1];
    const previous = state.queue[state.position - 1];
    if (!last || !previous) return;
    enter.current = { key: previous.key, from: last.known ? 1 : -1 };
    onUndo();
  };

  const flip = () => {
    if (!top) return;
    setFlippedKey((current) => (current === top.key ? null : top.key));
  };

  // A new top card starts at rest, or returns from the side it left on an undo.
  const topKey = top?.key;
  useLayoutEffect(() => {
    const m = motion.current;
    stop();
    m.pending = null;
    m.drag = null;
    const returning = enter.current;
    enter.current = null;
    m.width = cardRef.current?.offsetWidth || m.width;
    m.reduced = prefersReducedMotion();
    if (returning && returning.key === topKey && !m.reduced) {
      Object.assign(m, {
        x: returning.from * exitDistance(m.width),
        y: 0,
        vx: 0,
        vy: 0,
      });
      paint();
      animate(0, 0, { response: 0.45, vx: 0, vy: 0 });
    } else {
      Object.assign(m, { x: 0, y: 0, vx: 0, vy: 0 });
      paint();
    }
    // paint/animate only touch refs and the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKey]);
  useEffect(() => () => stop(), []);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.repeat) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      decide(true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      decide(false);
    } else if (event.code === "Space" && target?.tagName !== "BUTTON") {
      event.preventDefault();
      flip();
    } else if (key === "r" && topEntry) {
      speak(topEntry.headword, data.notify);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a")) return;
    const m = motion.current;
    // Grabbing a moving card catches it where it is, keeping the finger's offset.
    stop();
    m.pending = null;
    m.reduced = prefersReducedMotion();
    m.width = event.currentTarget.offsetWidth || m.width;
    m.drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: m.x,
      originY: m.y,
      active: false,
      cancelled: false,
      samples: [{ x: event.clientX, y: event.clientY, t: event.timeStamp }],
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    const drag = m.drag;
    if (!drag || drag.id !== event.pointerId || drag.cancelled) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 10) return;
      // Mostly vertical: this is a page scroll, not a swipe.
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.cancelled = true;
        return;
      }
      drag.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
    }
    drag.samples.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
    if (drag.samples.length > 8) drag.samples.shift();
    m.x = drag.originX + dx;
    m.y = drag.originY + rubberband(dy, m.width * 0.8);
    paint();
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const m = motion.current;
    const drag = m.drag;
    if (!drag || drag.id !== event.pointerId) return;
    m.drag = null;
    delete event.currentTarget.dataset.dragging;
    if (!drag.active) {
      if (m.x || m.y) settleBack(m.vx, m.vy);
      if (!drag.cancelled && event.type === "pointerup") flip();
      return;
    }
    const { vx, vy } = releaseVelocity(drag.samples, event.timeStamp);
    const direction =
      event.type === "pointerup" ? swipeDecision(m.x, vx, m.width) : 0;
    if (direction) fling(direction, vx, vy);
    else settleBack(vx, vy);
  };

  const done = state.decisions.length;
  const total = state.queue.length;
  const status = topEntry
    ? `${
        lastAction === "known"
          ? "已标记认识。"
          : lastAction === "again"
            ? "已标记再看看，这张稍后会再出现。"
            : lastAction === "undo"
              ? "已撤销上一张。"
              : ""
      }第 ${state.position + 1} / ${total} 张：${topEntry.headword}${top?.repeat ? "（再看一次）" : ""}`
    : "";

  if (!top || !topEntry)
    return (
      <main className="learn-stage learn-intro">
        <h1>这一组的词条已更新</h1>
        <button type="button" className="primary" onClick={onExit}>
          返回今日
        </button>
      </main>
    );

  return (
    <>
      <LearnHeader
        title="词卡速记"
        done={done}
        total={total}
        count={
          <>
            {Math.min(state.position + 1, total)}
            <small> / {total}</small>
          </>
        }
        onExit={onExit}
      >
        <button
          type="button"
          className="icon-button learn-undo"
          onClick={undo}
          disabled={!done}
          aria-label="撤销上一张"
          title={`撤销上一张（${undoKeys}）`}
        >
          <Undo2 size={20} aria-hidden="true" />
        </button>
      </LearnHeader>
      <main className="learn-stage learn-cards">
        <h1 ref={heading} tabIndex={-1} className="learn-sr">
          词卡速记
        </h1>
        <LiveRegion message={status} />
        <div className="learn-deck" ref={deckRef}>
          {next && nextEntry ? (
            <div
              key={next.key}
              className="learn-card is-behind"
              aria-hidden="true"
              inert
            >
              <div className="learn-flip">
                <CardFront entry={nextEntry} repeat={next.repeat} data={data} />
              </div>
            </div>
          ) : null}
          <div
            key={top.key}
            ref={cardRef}
            className="learn-card is-top"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
          >
            <span className="learn-card-stamp is-known" aria-hidden="true">
              认识
            </span>
            <span className="learn-card-stamp is-again" aria-hidden="true">
              再看看
            </span>
            <div className={`learn-flip${flipped ? " is-flipped" : ""}`}>
              <CardFront
                entry={topEntry}
                repeat={top.repeat}
                data={data}
                hidden={flipped}
              />
              <CardBack
                entry={topEntry}
                detail={details.get(topEntry.id)}
                detailsFailed={detailsFailed}
                data={data}
                hidden={!flipped}
              />
            </div>
          </div>
        </div>
        <div className="learn-card-actions">
          <button
            type="button"
            className="learn-decide is-again"
            onClick={() => decide(false)}
          >
            <ArrowLeft size={18} aria-hidden="true" />
            再看看
          </button>
          <button
            type="button"
            className="learn-flip-button"
            onClick={flip}
            aria-pressed={flipped}
          >
            {flipped ? "显示单词" : "显示释义"}
          </button>
          <button
            type="button"
            className="learn-decide is-known"
            onClick={() => decide(true)}
          >
            认识
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="learn-keys" aria-hidden="true">
          <span>
            <kbd>←</kbd> 再看看
          </span>
          <span>
            <kbd>空格</kbd> 翻面
          </span>
          <span>
            <kbd>→</kbd> 认识
          </span>
          <span>
            <kbd>{undoKeys}</kbd> 撤销
          </span>
        </p>
      </main>
    </>
  );
}

function CardFront({
  entry,
  repeat,
  data,
  hidden = false,
}: {
  entry: LexiconIndexEntry;
  repeat: boolean;
  data: Vocabulary;
  hidden?: boolean;
}) {
  return (
    <div className="learn-face is-front" inert={hidden}>
      {repeat ? <span className="learn-card-badge">再看一次</span> : null}
      <h2 className="learn-card-word" lang="en" translate="no">
        {entry.headword}
      </h2>
      <div className="learn-card-sound">
        {entry.britishIpa ? (
          <span className="learn-ipa">/{entry.britishIpa}/</span>
        ) : null}
        <Pronounce
          text={entry.headword}
          notify={data.notify}
          label={`播放 ${entry.headword} 的发音`}
        />
      </div>
      <p className="learn-card-hint">轻点卡片看释义</p>
    </div>
  );
}

function Highlight({ text, word }: { text: string; word: string }) {
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0 || !word.trim()) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong>{text.slice(at, at + word.length)}</strong>
      {text.slice(at + word.length)}
    </>
  );
}

function CardBack({
  entry,
  detail,
  detailsFailed,
  data,
  hidden,
}: {
  entry: LexiconIndexEntry;
  detail: LexiconDetail | undefined;
  detailsFailed: boolean;
  data: Vocabulary;
  hidden: boolean;
}) {
  const example = getEntryExample(entry, detail);
  return (
    <div className="learn-face is-back" inert={hidden}>
      <div className="learn-card-head">
        <span className="learn-card-small" lang="en" translate="no">
          {entry.headword}
        </span>
        <Pronounce
          text={entry.headword}
          notify={data.notify}
          label={`播放 ${entry.headword} 的发音`}
        />
      </div>
      {entry.partsOfSpeech.length ? (
        <p className="learn-card-pos" lang="en">
          {entry.partsOfSpeech.join(" · ")}
        </p>
      ) : null}
      <p className="learn-card-meaning">{entry.chineseCore}</p>
      {example ? (
        <figure className="learn-card-example">
          <blockquote lang="en">
            <Highlight text={example.en} word={entry.headword} />
          </blockquote>
          {example.zh ? <figcaption>{example.zh}</figcaption> : null}
        </figure>
      ) : (
        <p className="learn-card-quiet">
          {detail || detailsFailed ? "这个词暂时没有例句。" : "正在载入例句…"}
        </p>
      )}
      <p className="learn-card-source">{sourceLabel(entry)}</p>
    </div>
  );
}

function FlashDone({
  data,
  state,
  byId,
  day,
  onUndo,
  onAgain,
  onExit,
  onPractice,
}: {
  data: Vocabulary;
  state: FlashState;
  byId: ReadonlyMap<string, LexiconIndexEntry>;
  day: string;
  onUndo: () => void;
  onAgain: () => void;
  onExit: () => void;
  onPractice: LearnModeProps["onPractice"];
}) {
  const heading = useScreenFocus<HTMLHeadingElement>("done");
  const { known, review } = summarizeFlash(state);
  const reviewEntries = review
    .map((id) => byId.get(id))
    .filter((entry): entry is LexiconIndexEntry => Boolean(entry));
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      onUndo();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  return (
    <>
      <LearnHeader
        title="词卡速记"
        done={state.decisions.length}
        total={state.queue.length}
        onExit={onExit}
      />
      <main className="learn-stage learn-done">
        <CompletionArt
          kind="botanical"
          seed={`cards-${day}`}
          theme={data.settings.theme}
        />
        <h1 ref={heading} tabIndex={-1}>
          这一组看完了
        </h1>
        <div className="learn-stats">
          <span>
            <strong>{known.length}</strong>认识
          </span>
          <span>
            <strong>{review.length}</strong>再看看
          </span>
        </div>
        <HearList
          title="再看看的词"
          notify={data.notify}
          items={reviewEntries.map((entry) => ({
            id: entry.id,
            headword: entry.headword,
            meaning: shortMeaning(entry.chineseCore, 18),
          }))}
        />
        <div className="learn-done-actions">
          {reviewEntries.length ? (
            <button
              type="button"
              className="primary"
              onClick={() => onPractice(reviewEntries, "new")}
            >
              练习这 {reviewEntries.length} 个词
            </button>
          ) : null}
          <button
            type="button"
            className={reviewEntries.length ? "secondary" : "primary"}
            onClick={onAgain}
          >
            再来一组
          </button>
          <button type="button" className="text-button" onClick={onExit}>
            返回今日
          </button>
          <button type="button" className="text-button" onClick={onUndo}>
            <Undo2 size={15} aria-hidden="true" />
            撤销上一张
          </button>
        </div>
        <p className="learn-note">
          词卡不改变复习计划；在“练习”里作答后才会安排复习。
        </p>
      </main>
    </>
  );
}
