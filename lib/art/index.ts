import { grain, makeRng } from "./core";
import { blueGreen, botanical, currents, cutPaper, geometry, inkVillage, type Scene, type TimeOfDay } from "./scenes";
import type { ReadingCategory } from "../reading-library";

export type { TimeOfDay } from "./scenes";
export type ArtKind = "ink" | "shanshui" | "geometry" | "currents" | "cutout" | "botanical";

const SCENES: Record<ArtKind, { scene: Scene; grain: number }> = {
  ink: { scene: inkVillage, grain: 0.55 },
  shanshui: { scene: blueGreen, grain: 0.45 },
  geometry: { scene: geometry, grain: 0.6 },
  currents: { scene: currents, grain: 0.4 },
  cutout: { scene: cutPaper, grain: 0.7 },
  botanical: { scene: botanical, grain: 0.45 },
};

/** Essays are ink landscapes, stories are cut paper, science is ocean currents. */
export function readingArtKind(category: ReadingCategory): ArtKind {
  return category === "essay" ? "ink" : category === "fiction" ? "cutout" : "currents";
}

/** The Today landscape follows the learner's local clock. */
export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 19.5) return "dusk";
  return "night";
}

export type ArtRequest = { kind: ArtKind; seed: string; time?: TimeOfDay; width: number; height: number; ratio: number };
export const artKey = (r: ArtRequest) => `${r.kind}|${r.seed}|${r.time ?? ""}|${r.width}x${r.height}@${r.ratio}`;

/** Paints one illustration synchronously. The same request always yields the same picture. */
export function paintArtwork(canvas: HTMLCanvasElement, request: ArtRequest) {
  const { kind, seed, time, width, height, ratio } = request;
  const spec = SCENES[kind];
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  spec.scene(ctx, width, height, makeRng(`${kind}:${seed}`), { time });
  grain(ctx, spec.grain);
}

// Finished pictures are kept as bitmaps so revisiting a page redraws in one blit.
const cache = new Map<string, ImageBitmap>();
const CACHE_LIMIT = 48;
export function cachedArtwork(key: string) {
  const bitmap = cache.get(key);
  if (bitmap) {
    cache.delete(key);
    cache.set(key, bitmap);
  }
  return bitmap;
}
export function rememberArtwork(key: string, canvas: HTMLCanvasElement) {
  if (typeof createImageBitmap !== "function") return;
  createImageBitmap(canvas).then((bitmap) => {
    cache.set(key, bitmap);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string;
      cache.get(oldest)?.close();
      cache.delete(oldest);
    }
  }).catch(() => { /* Drawing again later is fine. */ });
}

// Paint at most one picture per idle slice, so a shelf of covers never blocks scrolling or input.
type Job = { run: () => void; cancelled: boolean };
const queue: Job[] = [];
let pumping = false;
const idle = (callback: () => void) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 120 });
  else setTimeout(callback, 16);
};
function pump() {
  const job = queue.shift();
  if (!job) { pumping = false; return; }
  if (!job.cancelled) job.run();
  idle(pump);
}
export function scheduleArtwork(run: () => void, urgent = false) {
  const job: Job = { run, cancelled: false };
  if (urgent) queue.unshift(job);
  else queue.push(job);
  if (!pumping) { pumping = true; idle(pump); }
  return () => { job.cancelled = true; };
}
