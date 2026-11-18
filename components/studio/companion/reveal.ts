type RevealOptions = {
  signal: AbortSignal;
  animated: boolean;
  current: () => boolean;
  update: (text: string) => void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("已停止", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Reveal only an already validated answer; retain whole graphemes and bound extra waiting. */
export async function revealReply(text: string, options: RevealOptions): Promise<void> {
  const check = () => {
    if (options.signal.aborted || !options.current()) throw new DOMException("已停止", "AbortError");
  };
  check();
  // Older browsers without grapheme segmentation use the accessible instant path.
  if (!options.animated || typeof Intl.Segmenter !== "function" || !text) { options.update(text); return; }
  const ends = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), part => part.index + part.segment.length);
  const now = options.now ?? performance.now.bind(performance), wait = options.wait ?? pause;
  const start = now(), duration = Math.min(5000, Math.max(200, ends.length * 8));
  let shown = 0;
  while (shown < ends.length) {
    check();
    const next = Math.min(ends.length, Math.max(1, Math.ceil((now() - start) / duration * ends.length)));
    if (next > shown) { shown = next; options.update(text.slice(0, ends[shown - 1])); }
    if (shown < ends.length) await wait(20, options.signal);
  }
}
