"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

const KEY = "__vocabBackGuard";

type GuardState = Record<string, unknown> | null;
const guarded = (state: unknown) => !!state && typeof state === "object" && (state as GuardState)![KEY] === true;

type Navigate = ((href: string, depth?: number, kind?: string, ...rest: unknown[]) => Promise<unknown>) & { vocabBackGuard?: true };

/**
 * vinext answers every popstate with a same-URL RSC "traverse" navigation, and
 * its listener is registered before any app code runs. For guard entries that
 * costs a request, and offline its failure path reloads the page. Its handler
 * looks the navigator up on window at call time, so skip exactly those
 * traversals and pass everything else through.
 */
function skipGuardTraversals(involved: () => boolean) {
  const target = window as unknown as { __VINEXT_RSC_NAVIGATE__?: Navigate };
  const original = target.__VINEXT_RSC_NAVIGATE__;
  if (typeof original !== "function" || original.vocabBackGuard) return;
  const page = location.pathname + location.search;
  const wrapped: Navigate = (href, depth, kind, ...rest) => {
    const url = new URL(href, location.origin);
    if (kind === "traverse" && url.pathname + url.search === page && involved()) return Promise.resolve();
    return original(href, depth, kind, ...rest);
  };
  wrapped.vocabBackGuard = true;
  target.__VINEXT_RSC_NAVIGATE__ = wrapped;
}

/**
 * Keeps one same-URL history entry while `active`, so the system back gesture
 * (iOS edge swipe, Android back) closes the current layer instead of leaving
 * the app. The URL never changes; these pops never reach the router.
 */
export function useBackGuard(active: boolean, onBack: () => void) {
  const back = useEffectEvent(onBack);
  const activeRef = useRef(active);
  // A history.back() issued here to drop the guard; its popstate is ours.
  const pending = useRef(false);
  // Re-check after every handled back, in case the layer below also needs a guard.
  const [pops, setPops] = useState(0);
  // Read at popstate, before this hook handles it: the layer that was open, or our own back().
  const involved = () => pending.current || activeRef.current || guarded(history.state);

  useEffect(() => {
    activeRef.current = active;
    if (pending.current) return;
    const onGuard = guarded(history.state);
    if (active && !onGuard) {
      // Idempotent; retried here in case the router's navigator was not ready at mount.
      skipGuardTraversals(involved);
      history.pushState({ ...(history.state as GuardState), [KEY]: true }, "");
    }
    else if (!active && onGuard) {
      pending.current = true;
      history.back();
    }
  }, [active, pops]);

  useEffect(() => {
    skipGuardTraversals(involved);
    const onPop = (event: PopStateEvent) => {
      if (pending.current) {
        pending.current = false;
        event.stopImmediatePropagation();
        if (activeRef.current && !guarded(event.state)) history.pushState({ ...(event.state as GuardState), [KEY]: true }, "");
        return;
      }
      if (guarded(event.state)) {
        // Forward onto a stale guard: step back off it.
        event.stopImmediatePropagation();
        if (!activeRef.current) {
          pending.current = true;
          history.back();
        }
        return;
      }
      if (!activeRef.current) return;
      event.stopImmediatePropagation();
      back();
      setPops((n) => n + 1);
    };
    // Later listeners (the navigation shim) have nothing to do for guard entries.
    window.addEventListener("popstate", onPop, { capture: true });
    return () => window.removeEventListener("popstate", onPop, { capture: true });
  }, []);
}
