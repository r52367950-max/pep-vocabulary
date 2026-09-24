"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Timer } from "lucide-react";
import type { LexiconIndexEntry } from "@/lib/lexicon";
import {
  MATCH_MIN_WORDS,
  buildMatchRounds,
  formatClock,
  shortMeaning,
  summarizeMatch,
  type MatchMistake,
  type MatchRound,
} from "@/lib/learn";
import {
  CompletionArt,
  HearList,
  LearnHeader,
  LearnIntro,
  LiveRegion,
  prefersReducedMotion,
  useScreenFocus,
  type LearnModeProps,
} from "./parts";

type Side = "left" | "right";
type Game = {
  seed: number;
  rounds: MatchRound[];
  round: number;
  matched: ReadonlySet<string>;
  mistakes: MatchMistake[];
  finishedMs: number | null;
};

/**
 * Elapsed play time. The visible value changes at most once a second, and the
 * clock stops while the tab is hidden.
 */
function useStopwatch(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  const total = useRef(0);
  const since = useRef<number | null>(null);
  const read = useCallback(
    () =>
      total.current +
      (since.current === null ? 0 : performance.now() - since.current),
    [],
  );
  const reset = useCallback(() => {
    total.current = 0;
    since.current = null;
    setSeconds(0);
  }, []);
  useEffect(() => {
    if (!running) return;
    const pause = () => {
      if (since.current === null) return;
      total.current += performance.now() - since.current;
      since.current = null;
    };
    const resume = () => {
      if (since.current === null && document.visibilityState === "visible")
        since.current = performance.now();
    };
    const visibility = () => (document.hidden ? pause() : resume());
    resume();
    // React skips the render when the whole-second value has not changed.
    const timer = window.setInterval(
      () => setSeconds(Math.floor(read() / 1000)),
      250,
    );
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      pause();
    };
  }, [running, read]);
  return { seconds, read, reset };
}

export default function Match({
  data,
  bookId,
  unit,
  onCourse,
  onExit,
  onPractice,
}: LearnModeProps) {
  const [game, setGame] = useState<Game | null>(null);
  const [selected, setSelected] = useState<Record<Side, string | null>>({
    left: null,
    right: null,
  });
  const [wrong, setWrong] = useState<{
    left: string;
    right: string;
    count: number;
  } | null>(null);
  const [message, setMessage] = useState("");
  const timers = useRef(new Set<number>());
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const board = useRef<HTMLDivElement>(null);
  const playing = Boolean(game && game.finishedMs === null);
  const clock = useStopwatch(playing);
  const byId = useMemo(
    () => new Map(data.index.map((entry) => [entry.id, entry])),
    [data.index],
  );
  const preview = useMemo(
    () =>
      buildMatchRounds(data.index, data.cards, { bookId, unit, seed: "preview" }),
    [data.index, data.cards, bookId, unit],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const later = (callback: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      callback();
    }, ms);
    timers.current.add(timer);
  };

  const start = () => {
    const seed = Date.now();
    const rounds = buildMatchRounds(data.index, data.cards, {
      bookId,
      unit,
      seed,
    });
    if (!rounds.length) {
      data.notify(`这个范围可配对的词不足 ${MATCH_MIN_WORDS} 个，换一个单元试试。`);
      return;
    }
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    clock.reset();
    setSelected({ left: null, right: null });
    setWrong(null);
    setGame({
      seed,
      rounds,
      round: 0,
      matched: new Set(),
      mistakes: [],
      finishedMs: null,
    });
    setMessage(
      `第 1 / ${rounds.length} 轮，${rounds[0].pairs.length} 对。先选一个英文词，再选它的中文意思。`,
    );
  };

  // A new round (or a new game) puts keyboard focus back at the top of the board.
  const roundKey = game && game.finishedMs === null ? `${game.seed}-${game.round}` : "";
  useLayoutEffect(() => {
    if (!roundKey) return;
    const active = document.activeElement;
    if (active && active !== document.body && !board.current?.contains(active))
      return;
    board.current
      ?.querySelector<HTMLButtonElement>(".learn-tile:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [roundKey]);

  if (!game)
    return (
      <LearnIntro
        symbol="match"
        title="配对消除"
        lead="左边是英文，右边是中文。选中一对，配对正确就消掉。看看用多少时间能全部消完。"
        data={data}
        bookId={bookId}
        unit={unit}
        onCourse={onCourse}
        onExit={onExit}
        meta={
          preview.length
            ? `共 ${preview.length} 轮，每轮 ${preview[0].pairs.length} 对左右。`
            : `这个范围可配对的词不足 ${MATCH_MIN_WORDS} 个，换一个单元试试。`
        }
        note="配对是练习游戏，不会改变复习计划。"
        action={
          <button
            type="button"
            className="primary learn-start"
            disabled={!preview.length}
            onClick={start}
          >
            开始配对
          </button>
        }
      />
    );

  if (game.finishedMs !== null)
    return (
      <MatchDone
        data={data}
        game={game}
        byId={byId}
        onAgain={start}
        onExit={onExit}
        onPractice={onPractice}
      />
    );

  const round = game.rounds[game.round];
  const pairById = new Map(round.pairs.map((pair) => [pair.id, pair]));
  const totalPairs = game.rounds.reduce((sum, r) => sum + r.pairs.length, 0);
  const donePairs =
    game.rounds.slice(0, game.round).reduce((sum, r) => sum + r.pairs.length, 0) +
    game.matched.size;
  const advancing = game.matched.size === round.pairs.length;

  /** Keep keyboard users in the same column after their tile disappears. */
  const moveFocusFrom = (side: Side, id: string, matched: ReadonlySet<string>) => {
    const current = tiles.current.get(`${side}:${id}`);
    if (!current || document.activeElement !== current) return;
    const order = side === "left" ? round.left : round.right;
    const at = order.indexOf(id);
    const nextId =
      order.slice(at + 1).find((candidate) => !matched.has(candidate)) ??
      [...order.slice(0, at)].reverse().find((candidate) => !matched.has(candidate));
    const other = side === "left" ? "right" : "left";
    const fallback = (other === "left" ? round.left : round.right).find(
      (candidate) => !matched.has(candidate),
    );
    const target = nextId
      ? tiles.current.get(`${side}:${nextId}`)
      : fallback
        ? tiles.current.get(`${other}:${fallback}`)
        : undefined;
    target?.focus({ preventScroll: true });
  };

  const choose = (side: Side, id: string) => {
    if (advancing || game.matched.has(id)) return;
    const next = { ...selected, [side]: selected[side] === id ? null : id };
    if (!next.left || !next.right) {
      setSelected(next);
      return;
    }
    setSelected({ left: null, right: null });
    const pair = pairById.get(next.left);
    if (next.left === next.right && pair) {
      const matched = new Set(game.matched).add(pair.id);
      moveFocusFrom(side, id, matched);
      setWrong(null);
      setGame({ ...game, matched });
      const finishedRound = matched.size === round.pairs.length;
      const last = game.round + 1 >= game.rounds.length;
      setMessage(
        `配对正确：${pair.headword}，${pair.meaning}。${
          finishedRound
            ? last
              ? "全部配对完成。"
              : `第 ${game.round + 1} 轮完成。`
            : `还剩 ${round.pairs.length - matched.size} 对。`
        }`,
      );
      if (finishedRound) {
        const wait = prefersReducedMotion() ? 320 : 560;
        const finishedAt = last ? clock.read() : null;
        later(() => {
          setGame((current) =>
            current && current.seed === game.seed
              ? last
                ? { ...current, finishedMs: finishedAt ?? clock.read() }
                : { ...current, round: current.round + 1, matched: new Set() }
              : current,
          );
          if (!last)
            setMessage(
              `第 ${game.round + 2} / ${game.rounds.length} 轮，${game.rounds[game.round + 1].pairs.length} 对。`,
            );
        }, wait);
      }
      return;
    }
    const word = pairById.get(next.left);
    const meaning = pairById.get(next.right);
    setGame({
      ...game,
      mistakes: [...game.mistakes, { left: next.left, right: next.right }],
    });
    setWrong((current) => ({
      left: next.left!,
      right: next.right!,
      count: (current?.count ?? 0) + 1,
    }));
    setMessage(
      `不是一对：${word?.headword ?? ""} 和“${meaning?.meaning ?? ""}”。再试一次。`,
    );
    later(
      () =>
        setWrong((current) =>
          current && current.left === next.left && current.right === next.right
            ? null
            : current,
        ),
      420,
    );
  };

  const tile = (side: Side, id: string, index: number) => {
    const pair = pairById.get(id);
    if (!pair) return null;
    const matched = game.matched.has(id);
    const isSelected = selected[side] === id;
    const isWrong = wrong?.[side] === id;
    const className = [
      "learn-tile",
      side === "left" ? "is-word" : "is-meaning",
      isSelected ? "is-selected" : "",
      matched ? "is-matched" : "",
      isWrong ? (wrong!.count % 2 ? "is-wrong-a" : "is-wrong-b") : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={id}
        type="button"
        ref={(node) => {
          const key = `${side}:${id}`;
          if (node) tiles.current.set(key, node);
          else tiles.current.delete(key);
        }}
        className={className}
        style={{ "--i": index } as CSSProperties}
        aria-pressed={isSelected}
        aria-hidden={matched || undefined}
        disabled={matched}
        lang={side === "left" ? "en" : undefined}
        translate={side === "left" ? "no" : undefined}
        onClick={() => choose(side, id)}
      >
        <span>{side === "left" ? pair.headword : pair.meaning}</span>
      </button>
    );
  };

  return (
    <>
      <LearnHeader
        title="配对消除"
        done={donePairs}
        total={totalPairs}
        count={
          <>
            第 {game.round + 1}
            <small> / {game.rounds.length} 轮</small>
          </>
        }
        onExit={onExit}
      />
      <main className="learn-stage learn-match">
        <h1 className="learn-sr">配对消除，第 {game.round + 1} 轮</h1>
        <LiveRegion message={message} />
        <div className="learn-match-status">
          {/* A ticking clock is noise for a screen reader; the final time is on the result screen. */}
          <span aria-hidden="true">
            <Timer size={16} />
            <time className="learn-tabular" dateTime={`PT${clock.seconds}S`}>
              {formatClock(clock.seconds * 1000)}
            </time>
          </span>
          <span>
            失误 <strong className="learn-tabular">{game.mistakes.length}</strong>
          </span>
        </div>
        <div
          ref={board}
          key={`${game.seed}-${game.round}`}
          className="learn-board"
          data-advancing={advancing || undefined}
        >
          <div className="learn-column" role="group" aria-label="英文">
            {round.left.map((id, index) => tile("left", id, index))}
          </div>
          <div className="learn-column" role="group" aria-label="中文意思">
            {round.right.map((id, index) => tile("right", id, index))}
          </div>
        </div>
        <p className="learn-hint">先选一边，再选另一边；再点一次可以取消选择。</p>
      </main>
    </>
  );
}

function MatchDone({
  data,
  game,
  byId,
  onAgain,
  onExit,
  onPractice,
}: {
  data: LearnModeProps["data"];
  game: Game;
  byId: ReadonlyMap<string, LexiconIndexEntry>;
  onAgain: () => void;
  onExit: () => void;
  onPractice: LearnModeProps["onPractice"];
}) {
  const heading = useScreenFocus<HTMLHeadingElement>("done");
  const summary = summarizeMatch(game.rounds, game.mistakes);
  const missed = summary.mismatchedIds
    .map((id) => byId.get(id))
    .filter((entry): entry is LexiconIndexEntry => Boolean(entry));
  return (
    <>
      <LearnHeader
        title="配对消除"
        done={summary.pairs}
        total={summary.pairs}
        onExit={onExit}
      />
      <main className="learn-stage learn-done">
        <CompletionArt
          kind="cutout"
          seed={`match-${game.seed}`}
          theme={data.settings.theme}
        />
        <h1 ref={heading} tabIndex={-1}>
          全部配对完成
        </h1>
        <div className="learn-stats">
          <span>
            <strong className="learn-tabular">
              {formatClock(game.finishedMs ?? 0)}
            </strong>
            用时
          </span>
          <span>
            <strong>{summary.pairs}</strong>对
          </span>
          <span>
            <strong>{summary.mistakes}</strong>失误
          </span>
        </div>
        <HearList
          title="配错过的词"
          notify={data.notify}
          items={missed.map((entry) => ({
            id: entry.id,
            headword: entry.headword,
            meaning: shortMeaning(entry.chineseCore, 18),
          }))}
        />
        {!missed.length ? (
          <p className="learn-done-lead">一次都没有配错。</p>
        ) : null}
        <div className="learn-done-actions">
          {missed.length ? (
            <button
              type="button"
              className="primary"
              onClick={() => onPractice(missed, "mistakes")}
            >
              练习配错的 {missed.length} 个词
            </button>
          ) : null}
          <button
            type="button"
            className={missed.length ? "secondary" : "primary"}
            onClick={onAgain}
          >
            再来一局
          </button>
          <button type="button" className="text-button" onClick={onExit}>
            返回今日
          </button>
        </div>
        <p className="learn-note">配对不改变复习计划；在“练习”里作答后才会安排复习。</p>
      </main>
    </>
  );
}
