import { createElement, lazy, useState, type ComponentType } from "react";

type Module<P> = { default: ComponentType<P> };

/**
 * A code-split component that can load before it is needed. React.lazy suspends on its first
 * render even when the chunk is already in memory, and React then holds the fallback for about
 * 300 ms before revealing the content. Once `preload()` has settled, a new mount renders the loaded
 * component directly, without a fallback or that hold.
 */
export function preloadable<P extends object>(load: () => Promise<Module<P>>) {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<Module<P>> | null = null;
  const preload = () => {
    loading ??= load().then(
      (module) => { loaded = module.default; return module; },
      // A failed chunk (offline, new deploy) may be requested again by the next mount.
      (error: unknown) => { loading = null; throw error; },
    );
    return loading;
  };
  function Preloaded(props: P) {
    // Chosen once per mount: swapping the lazy wrapper for the loaded component would remount it.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? lazy(preload));
    return createElement(Component, props);
  }
  return Object.assign(Preloaded, { preload });
}

/** Loads each chunk in its own idle slice, so warming several never blocks input. */
export function preloadWhenIdle(loaders: ReadonlyArray<() => Promise<unknown>>, delay = 0) {
  let cancelled = false;
  let handle: number | undefined;
  let timer: number | undefined;
  const idle = (run: () => void) => typeof requestIdleCallback === "function"
    ? requestIdleCallback(run, { timeout: 3000 })
    : window.setTimeout(run, 400);
  const next = (index: number) => {
    if (cancelled || index >= loaders.length) return;
    handle = idle(() => {
      handle = undefined;
      if (cancelled) return;
      void loaders[index]().catch(() => undefined).finally(() => next(index + 1));
    });
  };
  if (delay > 0) timer = window.setTimeout(() => { timer = undefined; next(0); }, delay);
  else next(0);
  return () => {
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    if (handle === undefined) return;
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    else clearTimeout(handle);
  };
}
