import { flushSync } from "react-dom";

export function prefersReducedMotion() {
  return document.documentElement.dataset.motion === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Runs a layout-changing update inside a view transition when the browser and motion settings allow. */
export function withTransition(update: () => void) {
  const start = (document as Document & { startViewTransition?: (callback: () => void) => unknown }).startViewTransition;
  if (prefersReducedMotion() || !start) { update(); return; }
  start.call(document, () => flushSync(update));
}
