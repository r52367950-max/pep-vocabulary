"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { artKey, cachedArtwork, paintArtwork, rememberArtwork, scheduleArtwork, type ArtKind, type ArtRequest, type TimeOfDay } from "@/lib/art";

/**
 * A generated illustration that fills its box. It paints once when it nears the viewport,
 * in an idle slice, and repaints only when the box changes size noticeably.
 * Size the element with CSS through className; without a label it is decorative.
 */
export function Artwork({ kind, seed, time, className, label, eager = false }: {
  kind: ArtKind; seed: string; time?: TimeOfDay; className?: string; label?: string; eager?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let painted = "";
    let pending = "";
    let cancel: (() => void) | undefined;
    let visible = false;
    let width = 0;
    const draw = () => {
      const box = canvas.getBoundingClientRect();
      const request: ArtRequest = { kind, seed, time, width: Math.round(box.width), height: Math.round(box.height), ratio: Math.min(2, window.devicePixelRatio || 1) };
      if (request.width < 8 || request.height < 8) return;
      const key = artKey(request);
      if (key === painted || key === pending) return;
      cancel?.();
      const bitmap = cachedArtwork(key);
      if (bitmap) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        painted = key;
        canvas.dataset.ready = "true";
        return;
      }
      pending = key;
      cancel = scheduleArtwork(() => {
        paintArtwork(canvas, request);
        rememberArtwork(key, canvas);
        painted = key;
        pending = "";
        canvas.dataset.ready = "true";
      }, eager);
    };
    const onScreen = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) draw();
    }, { rootMargin: "240px" });
    const resize = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (Math.abs(next - width) / Math.max(1, width) < 0.06) return;
      width = next;
      if (visible) draw();
    });
    onScreen.observe(canvas);
    resize.observe(canvas);
    return () => {
      onScreen.disconnect();
      resize.disconnect();
      cancel?.();
    };
  }, [kind, seed, time, eager]);
  return <canvas ref={ref} className={`artwork${className ? ` ${className}` : ""}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const subscribeScheme = (notify: () => void) => {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
/** Whether the app is showing its dark appearance, following the in-app theme setting first. */
export function useDarkAppearance(theme: "light" | "dark" | "system") {
  const systemDark = useSyncExternalStore(subscribeScheme, () => window.matchMedia(DARK_QUERY).matches, () => false);
  return theme === "dark" || (theme === "system" && systemDark);
}
