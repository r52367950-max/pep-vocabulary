"use client";

import { useSyncExternalStore } from "react";

/**
 * The single transient message shown in the toast region. It lives outside React state so
 * showing or dismissing a message re-renders only the toast region, not the whole app.
 * A message dismisses itself after five seconds; repeating the message on screen does not
 * restart the timer, and a different message replaces it and restarts the timer.
 */
const DISMISS_MS = 5000;
let message: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function notify(next: string | null) {
  if (next === message) return;
  message = next;
  clearTimeout(timer);
  timer = next ? setTimeout(() => notify(null), DISMISS_MS) : undefined;
  for (const listener of listeners) listener();
}

export function subscribeToast(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const currentToast = () => message;
const serverSnapshot = () => null;

export function useToastMessage() {
  return useSyncExternalStore(subscribeToast, currentToast, serverSnapshot);
}
