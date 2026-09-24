/** Drawing primitives shared by the generated illustrations: seeded randomness, noise, brush, wash and paper. */

export type Ctx = CanvasRenderingContext2D;
export type Point = { x: number; y: number; v?: number };
export type Rng = ReturnType<typeof makeRng>;

export const TAU = Math.PI * 2;

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** mulberry32: small, fast and identical on every platform, so an article always gets the same picture. */
export function makeRng(seed: string | number) {
  let a = (typeof seed === "number" ? seed : hashString(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
    chance: (p: number) => next() < p,
    gauss: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(TAU * next()),
    shuffle: <T,>(list: readonly T[]): T[] => {
      const copy = list.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

/** Seeded 2D gradient noise, roughly in [-1, 1]. */
export function makeNoise(rng: Rng) {
  const perm = rng.shuffle(Array.from({ length: 256 }, (_, i) => i));
  const table = perm.concat(perm);
  const grads = Array.from({ length: 256 }, () => {
    const a = rng.next() * TAU;
    return [Math.cos(a), Math.sin(a)] as const;
  });
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const corner = (ix: number, iy: number, x: number, y: number) => {
    const g = grads[table[(ix & 255) + table[iy & 255]] & 255];
    return g[0] * x + g[1] * y;
  };
  return (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fade(fx), sy = fade(fy);
    const top = corner(x0, y0, fx, fy) + sx * (corner(x0 + 1, y0, fx - 1, fy) - corner(x0, y0, fx, fy));
    const bottom = corner(x0, y0 + 1, fx, fy - 1) + sx * (corner(x0 + 1, y0 + 1, fx - 1, fy - 1) - corner(x0, y0 + 1, fx, fy - 1));
    return (top + sy * (bottom - top)) * 1.4;
  };
}

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
export function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a), y = hexRgb(b);
  return `#${x.map((n, i) => Math.round(n + (y[i] - n) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Catmull-Rom through the control points. */
export function spline(points: Point[], steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const axis = (k: "x" | "y") => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push({ x: axis("x"), y: axis("y") });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Recursive midpoint displacement of a closed polygon: the soft edge of a watercolour layer. */
export function deform(points: Point[], depth: number, variance: number, rng: Rng): Point[] {
  let poly = points;
  for (let d = 0; d < depth; d++) {
    const next: Point[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y), v = a.v ?? variance;
      next.push(a, {
        x: (a.x + b.x) / 2 + rng.gauss() * len * v * 0.5,
        y: (a.y + b.y) / 2 + rng.gauss() * len * v * 0.5,
        v: v * 0.9,
      });
    }
    poly = next;
  }
  return poly;
}

export function tracePoly(ctx: Ctx, poly: Point[]) {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}
export function fillPoly(ctx: Ctx, poly: Point[]) {
  tracePoly(ctx, poly);
  ctx.fill();
}

export function wash(ctx: Ctx, poly: Point[], color: string, rng: Rng, options: { layers?: number; alpha?: number; spread?: number; edge?: number } = {}) {
  const { layers = 24, alpha = 0.045, spread = 0.18, edge = 0.12 } = options;
  const base = deform(poly, 2, spread, rng);
  ctx.fillStyle = rgba(color, alpha);
  for (let i = 0; i < layers; i++) fillPoly(ctx, deform(base, 3, edge, rng));
}

/** Dry brush: parallel bristles along a path, tapered, with broken ink toward the edges. */
export function brush(ctx: Ctx, pts: Point[], rng: Rng, options: { width: number; bristles?: number; dry?: number; color?: string; taper?: (t: number) => number }) {
  const { width, dry = 0.12, color = "#1d1d1b" } = options;
  const bristles = options.bristles ?? Math.max(3, Math.round(width / 1.3));
  const taper = options.taper ?? ((t: number) => Math.min(1, Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.08)) + 0.15));
  const normals = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    return { x: -dy / l, y: dx / l };
  });
  ctx.lineCap = "round";
  for (let k = 0; k < bristles; k++) {
    const off = (k / Math.max(1, bristles - 1) - 0.5) * width, wobble = rng.range(-0.3, 0.3);
    ctx.strokeStyle = rgba(color, rng.range(0.55, 0.95));
    ctx.lineWidth = Math.max(0.5, (width / bristles) * rng.range(0.9, 1.6));
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const s = taper(i / (pts.length - 1));
      const x = pts[i].x + normals[i].x * (off * s + wobble), y = pts[i].y + normals[i].y * (off * s + wobble);
      if (i === 0 || rng.chance(dry * (Math.abs(off) / width + 0.3))) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

export function stroke(ctx: Ctx, pts: Point[], color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}
export function dot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}
/** A soft, slightly irregular dab of pigment. */
export function dab(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number, rng: Rng) {
  const poly = Array.from({ length: 8 }, (_, i) => ({ x: x + Math.cos((i / 8) * TAU) * r, y: y + Math.sin((i / 8) * TAU) * r }));
  ctx.fillStyle = rgba(color, alpha);
  for (let k = 0; k < 3; k++) fillPoly(ctx, deform(poly, 2, 0.25, rng));
}

/** Paper ground: flat colour, faint mottling and a few fibres. */
export function paper(ctx: Ctx, w: number, h: number, base: string | null, rng: Rng, options: { blots?: number; fibers?: boolean } = {}) {
  if (base) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
  }
  for (let i = 0; i < (options.blots ?? 14); i++) {
    const x = rng.range(0, w), y = rng.range(0, h), r = rng.range(w * 0.15, w * 0.45);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rng.chance(0.5) ? "rgba(60,55,45,0.028)" : "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  if (options.fibers === false) return;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < (w * h) / 2600; i++) {
    const fx = rng.range(0, w), fy = rng.range(0, h), a = rng.range(0, TAU), l = rng.range(3, 12);
    ctx.strokeStyle = rng.chance(0.5) ? "rgba(90,80,65,0.06)" : "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.quadraticCurveTo(fx + Math.cos(a) * l * 0.5 + rng.range(-2, 2), fy + Math.sin(a) * l * 0.5 + rng.range(-2, 2), fx + Math.cos(a) * l, fy + Math.sin(a) * l);
    ctx.stroke();
  }
}

let grainTile: HTMLCanvasElement | null = null;
/** Film grain from one cached tile, composited on the GPU instead of reading pixels back. */
export function grain(ctx: Ctx, strength: number) {
  if (!grainTile) {
    const size = 128, tile = document.createElement("canvas");
    tile.width = tile.height = size;
    const g = tile.getContext("2d");
    if (!g) return;
    const image = g.createImageData(size, size), rng = makeRng("grain");
    for (let i = 0; i < image.data.length; i += 4) {
      const v = rng.chance(0.5) ? 0 : 255;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = Math.round(rng.next() * 30);
    }
    g.putImageData(image, 0, 0);
    grainTile = tile;
  }
  const pattern = ctx.createPattern(grainTile, "repeat");
  if (!pattern) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = strength;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** The red 迹 seal used as a quiet signature. */
export function seal(ctx: Ctx, x: number, y: number, size: number, rng: Rng) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rng.range(-0.04, 0.04));
  ctx.strokeStyle = ctx.fillStyle = "rgba(196,58,44,0.82)";
  ctx.lineWidth = size * 0.09;
  ctx.strokeRect(0, 0, size, size);
  ctx.font = `600 ${Math.round(size * 0.66)}px "Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("迹", size / 2, size / 2 + size * 0.03);
  ctx.restore();
}
