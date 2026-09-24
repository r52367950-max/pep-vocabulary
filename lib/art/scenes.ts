import {
  TAU, brush, dab, dot, fillPoly, makeNoise, makeRng, mix, paper, rgba, seal, spline, stroke, tracePoly, wash,
  type Ctx, type Point, type Rng,
} from "./core";

export type TimeOfDay = "dawn" | "day" | "dusk" | "night";
export type SceneOptions = { time?: TimeOfDay };
export type Scene = (ctx: Ctx, w: number, h: number, rng: Rng, options: SceneOptions) => void;

const INK = "#1c1c1a";
const WILLOW_LEAVES = ["#8db35e", "#a9c56f", "#6f9a4f"];

// ---------------------------------------------------------------------------
// 水墨江南: white walls and black roofs by the water, willows and scattered colour dots.
// ---------------------------------------------------------------------------
export const inkVillage: Scene = (ctx, w, h, rng) => {
  paper(ctx, w, h, "#efeeea", rng);
  const flip = rng.chance(0.5);
  const X = (x: number) => (flip ? w - x : x);
  const horizon = h * rng.range(0.44, 0.52);
  const dotColors = ["#d8443a", "#e9b23c", "#3d78b8", "#5c9a52", "#e889a1"];

  type Hill = { c: number; r: number; hgt: number };
  const ridge = (hills: Hill[], base: number, jitter: number): Point[] => {
    const pts: Point[] = [];
    for (let x = -20; x <= w + 20; x += w / 60) {
      let y = base;
      for (const m of hills) {
        const d = (x - m.c) / m.r;
        y -= m.hgt * Math.exp(-d * d * 1.6);
      }
      pts.push({ x, y: y + rng.gauss() * jitter });
    }
    pts.push({ x: w + 20, y: base + 2 }, { x: -20, y: base + 2 });
    return pts;
  };
  const far = Array.from({ length: rng.int(2, 3) }, () => ({ c: rng.range(0.15, 0.95) * w, r: rng.range(0.16, 0.3) * w, hgt: rng.range(0.12, 0.22) * h }));
  wash(ctx, ridge(far, horizon - h * 0.03, 1), "#8e9aa6", rng, { layers: 22, alpha: 0.05, spread: 0.02, edge: 0.03 });
  const near = [{ c: rng.range(0.1, 0.9) * w, r: w * 0.35, hgt: h * 0.07 }, { c: rng.range(0, 1) * w, r: w * 0.25, hgt: h * 0.05 }];
  wash(ctx, ridge(near, horizon, 1), "#6f8284", rng, { layers: 22, alpha: 0.05, spread: 0.02, edge: 0.03 });
  const mist = ctx.createLinearGradient(0, horizon - h * 0.08, 0, horizon + 4);
  mist.addColorStop(0, "rgba(239,238,234,0)");
  mist.addColorStop(1, "rgba(239,238,234,0.92)");
  ctx.fillStyle = mist;
  ctx.fillRect(0, horizon - h * 0.08, w, h * 0.08 + 6);

  // Village: white walls, black roof bands and stepped horse-head gables.
  const start = rng.range(0.02, 0.1) * w, span = rng.range(0.34, 0.5) * w;
  const houses = Array.from({ length: rng.int(6, 10) }, () => {
    const hw = rng.range(0.06, 0.12) * w;
    return { x: start + rng.range(0, span - hw), w: hw, hgt: rng.range(0.06, 0.1) * h, back: rng.chance(0.45) };
  }).sort((a, b) => Number(b.back) - Number(a.back));
  for (const house of houses) {
    const base = horizon + (house.back ? -h * 0.012 : h * 0.004);
    const top = base - house.hgt, left = X(flip ? house.x + house.w : house.x);
    ctx.fillStyle = "#f8f7f3";
    ctx.fillRect(left, top, house.w, house.hgt);
    ctx.strokeStyle = "rgba(40,40,38,0.28)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(left, top); ctx.lineTo(left, base);
    ctx.moveTo(left + house.w, top); ctx.lineTo(left + house.w, base);
    ctx.stroke();
    const roofH = Math.max(3, house.hgt * 0.16);
    ctx.fillStyle = rgba(INK, 0.92);
    ctx.fillRect(left - 2, top - roofH * 0.6, house.w + 4, roofH);
    if (rng.chance(0.7)) {
      const step = house.w * 0.12;
      [left - 2, left + house.w + 2 - step].forEach((gx, side) => {
        for (let s = 0; s < 2; s++) {
          const gy = top - roofH * 0.6 - (s + 1) * roofH * 0.9;
          ctx.fillRect(side === 0 ? gx + s * step * 0.6 : gx - s * step * 0.6, gy, step, roofH * 0.75);
        }
      });
    }
    for (let k = rng.int(0, 3); k > 0; k--) dab(ctx, left + rng.range(0.2, 0.8) * house.w, top + rng.range(0.4, 0.7) * house.hgt, rng.range(1.6, 2.8), INK, 0.35, rng);
  }
  const shore: Point[] = [];
  for (let sx = 0; sx <= w; sx += w / 40) shore.push({ x: sx, y: horizon + h * 0.012 + rng.gauss() * 0.4 });
  brush(ctx, shore, rng, { width: 2.2, bristles: 3, dry: 0.08, color: INK });
  for (const house of houses) {
    const cx = X(house.x + house.w / 2);
    for (let r = 0; r < 2; r++) {
      const ry = horizon + h * rng.range(0.03, 0.09);
      ctx.strokeStyle = rgba(INK, rng.range(0.12, 0.3));
      ctx.lineWidth = rng.range(1, 2.2);
      ctx.beginPath();
      ctx.moveTo(cx - house.w * rng.range(0.1, 0.4), ry);
      ctx.lineTo(cx + house.w * rng.range(0.1, 0.4), ry);
      ctx.stroke();
    }
  }
  // Small trees along the shore.
  for (let t = rng.int(3, 6); t > 0; t--) {
    const tx = X(rng.range(0.5, 0.95) * w), th = rng.range(0.035, 0.06) * h;
    brush(ctx, [{ x: tx, y: horizon + h * 0.012 }, { x: tx + rng.range(-1, 1), y: horizon - th }], rng, { width: 1.8, bristles: 2, color: INK });
    for (let l = 0; l < 7; l++) {
      const lx = tx + rng.range(-6, 6);
      stroke(ctx, [{ x: lx, y: horizon - th * rng.range(0.6, 1.05) }, { x: lx + rng.range(-2, 2), y: horizon - th * rng.range(0.1, 0.4) }], rgba(INK, 0.45), 0.6);
    }
    for (let d = 0; d < 4; d++) dot(ctx, tx + rng.range(-8, 8), horizon - th * rng.range(0.3, 1), rng.range(0.9, 1.8), rgba(rng.pick(dotColors), 0.85));
  }
  // Arched bridge.
  if (rng.chance(0.55)) {
    const bx = X(rng.range(0.55, 0.75) * w), br = w * 0.035, by = horizon + h * 0.012;
    ctx.strokeStyle = rgba(INK, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx - br * 2, by);
    ctx.quadraticCurveTo(bx, by - br * 1.1, bx + br * 2, by);
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(bx, by, br * 0.62, Math.PI, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(INK, 0.35);
    ctx.beginPath();
    ctx.arc(bx, by, br * 0.62, 0, Math.PI);
    ctx.stroke();
  }
  // Water strokes.
  for (let i = 0; i < 22; i++) {
    const wy = rng.range(horizon + h * 0.08, h * 0.97), wx = rng.range(-0.05, 0.9) * w, wl = rng.range(0.05, 0.22) * w;
    stroke(ctx, [{ x: wx, y: wy }, { x: wx + wl, y: wy + rng.range(-1, 1) }], rgba("#6b7478", rng.range(0.12, 0.3)), rng.range(0.8, 1.8));
  }
  // A covered boat with a boatman.
  if (rng.chance(0.75)) {
    const bx = X(rng.range(0.35, 0.6) * w), by = rng.range(0.66, 0.78) * h, bl = w * 0.07;
    ctx.fillStyle = rgba(INK, 0.9);
    ctx.beginPath();
    ctx.moveTo(bx - bl / 2, by);
    ctx.quadraticCurveTo(bx, by + bl * 0.14, bx + bl / 2, by - bl * 0.03);
    ctx.lineTo(bx + bl / 2 - 2, by + 1.5);
    ctx.quadraticCurveTo(bx, by + bl * 0.2, bx - bl / 2, by);
    ctx.fill();
    brush(ctx, [{ x: bx - bl * 0.2, y: by - 1 }, { x: bx - bl * 0.1, y: by - bl * 0.22 }, { x: bx + bl * 0.08, y: by - bl * 0.2 }, { x: bx + bl * 0.12, y: by - 1 }], rng, { width: 3, bristles: 3, color: INK });
    dot(ctx, bx + bl * 0.3, by - bl * 0.22, 2.2, INK);
    stroke(ctx, [{ x: bx + bl * 0.28, y: by - bl * 0.12 }, { x: bx + bl * 0.55, y: by + bl * 0.18 }], rgba(INK, 0.8), 1);
    dot(ctx, bx - bl * 0.02, by - bl * 0.08, 1.6, "#d8443a");
  }
  // Lotus leaves in a near corner.
  if (rng.chance(0.6)) {
    const lx0 = X(rng.range(0.05, 0.3) * w);
    for (let lf = rng.int(3, 6); lf > 0; lf--) {
      const cx = lx0 + rng.range(-0.08, 0.12) * w, cy = rng.range(0.82, 0.97) * h, rx = rng.range(0.03, 0.055) * w;
      const leaf = Array.from({ length: 10 }, (_, e) => ({ x: cx + Math.cos((e / 10) * TAU) * rx, y: cy + Math.sin((e / 10) * TAU) * rx * 0.34 }));
      wash(ctx, leaf, "#7fa77a", rng, { layers: 10, alpha: 0.09, spread: 0.04, edge: 0.05 });
    }
    for (let st = rng.int(3, 5); st > 0; st--) {
      const sx = lx0 + rng.range(-0.06, 0.1) * w, top = rng.range(0.68, 0.8) * h;
      stroke(ctx, [{ x: sx, y: h + 2 }, { x: sx + rng.range(-6, 6), y: top }], rgba(INK, 0.7), 1);
      if (rng.chance(0.6)) dab(ctx, sx, top, 3.2, "#e88aa4", 0.75, rng);
    }
  }
  // Willow: arching branches and long falling strands with new leaves.
  const trunkX = X(rng.range(0.8, 0.9) * w);
  const trunk = spline([{ x: trunkX + 8, y: h + 10 }, { x: trunkX - 5, y: h * 0.6 }, { x: trunkX + 3, y: h * 0.3 }, { x: trunkX - 2, y: h * 0.04 }], 10);
  brush(ctx, trunk, rng, { width: w * 0.02, dry: 0.28, color: INK, taper: (t) => 1 - t * 0.6 });
  for (let b = rng.int(4, 6); b > 0; b--) {
    const from = trunk[rng.int(10, 26)], dir = rng.chance(0.5) ? 1 : -1;
    const tipX = from.x + dir * rng.range(0.06, 0.16) * w, tipY = from.y - rng.range(0.06, 0.16) * h;
    const branch = spline([from, { x: (from.x + tipX) / 2, y: from.y - (from.y - tipY) * 0.8 }, { x: tipX, y: tipY }], 8);
    brush(ctx, branch, rng, { width: 2.4, bristles: 3, dry: 0.1, color: INK, taper: (t) => 1 - t * 0.7 });
    for (let s = 0; s < 16; s++) {
      const o = branch[rng.int(3, branch.length - 1)], len = rng.range(0.22, 0.62) * h, d2 = dir * rng.range(0.4, 1);
      const ex = o.x + d2 * rng.range(0.02, 0.06) * w, ey = Math.min(h + 20, o.y + len);
      const c1 = { x: o.x + d2 * w * 0.03, y: o.y - h * 0.04 }, c2 = { x: ex, y: ey - len * 0.7 };
      ctx.strokeStyle = rgba(INK, rng.range(0.3, 0.7));
      ctx.lineWidth = rng.range(0.45, 0.9);
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, ex, ey);
      ctx.stroke();
      for (let l = 0; l < 5; l++) {
        const t = rng.range(0.35, 1), m = 1 - t;
        const px = m * m * m * o.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * ex;
        const py = m * m * m * o.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * ey;
        dot(ctx, px + rng.range(-1, 1), py, rng.range(0.8, 1.6), rgba(rng.pick(WILLOW_LEAVES), rng.range(0.55, 0.9)));
      }
    }
  }
  // Wu Guanzhong's colour dots, gathered around the village.
  for (let i = 0; i < 30; i++) {
    const x = X(start + rng.range(-0.04, 1.08) * span), y = horizon + h * (rng.chance(0.6) ? rng.range(-0.004, 0.02) : rng.range(-0.16, -0.1));
    dot(ctx, x, y, rng.range(1, 2.6), rgba(rng.pick(dotColors), rng.range(0.7, 0.95)));
  }
  seal(ctx, flip ? w * 0.9 : w * 0.05, h * 0.86, Math.max(12, w * 0.024), rng);
};

// ---------------------------------------------------------------------------
// 青绿山水: layered blue-green peaks floating in mist, under a time-of-day sky.
// ---------------------------------------------------------------------------
const SKIES: Record<TimeOfDay, { top: string; bottom: string; sun: string; water: string; mist: string; night: boolean }> = {
  dawn: { top: "#e8e3dc", bottom: "#f3e7da", sun: "#e2896c", water: "#e9e5de", mist: "#f3ebe2", night: false },
  day: { top: "#e6ebe8", bottom: "#f2f1ea", sun: "#c9553e", water: "#ebeeea", mist: "#f3f3ee", night: false },
  dusk: { top: "#e7cdb8", bottom: "#f1e1cf", sun: "#c24d34", water: "#eadbca", mist: "#f2e4d4", night: false },
  night: { top: "#18202e", bottom: "#2a3446", sun: "#efe6c8", water: "#1d2635", mist: "#2c374a", night: true },
};
function pine(ctx: Ctx, x: number, y: number, size: number, color: string, rng: Rng) {
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = Math.max(0.8, size * 0.06);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + rng.range(-2, 2), y - size);
  ctx.stroke();
  for (let t = 0; t < 4; t++) {
    ctx.beginPath();
    ctx.ellipse(x + rng.range(-1, 1), y - size * (0.3 + (t / 4) * 0.72), size * (0.5 - t * 0.09), size * 0.07, rng.range(-0.1, 0.1), 0, TAU);
    ctx.fill();
  }
}
export const blueGreen: Scene = (ctx, w, h, rng, options) => {
  const sky = SKIES[options.time ?? "day"];
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sky.top);
  g.addColorStop(1, sky.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  paper(ctx, w, h, null, rng, { blots: 8, fibers: !sky.night });
  const sx = rng.range(0.15, 0.85) * w, sy = rng.range(0.12, 0.26) * h, sr = Math.min(w, h) * rng.range(0.045, 0.065);
  if (sky.night) {
    for (let s = 0; s < 120; s++) dot(ctx, rng.range(0, w), rng.range(0, h * 0.55), rng.range(0.3, 1.1), `rgba(255,250,235,${rng.range(0.25, 0.8)})`);
    const halo = ctx.createRadialGradient(sx, sy, sr, sx, sy, sr * 5);
    halo.addColorStop(0, "rgba(239,230,200,0.18)");
    halo.addColorStop(1, "rgba(239,230,200,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
  }
  const disc = Array.from({ length: 14 }, (_, i) => ({ x: sx + Math.cos((i / 14) * TAU) * sr, y: sy + Math.sin((i / 14) * TAU) * sr }));
  wash(ctx, disc, sky.sun, rng, { layers: 14, alpha: sky.night ? 0.12 : 0.1, spread: 0.02, edge: 0.03 });

  const palettes = sky.night
    ? [["#3b5670", "#2e4a52", "#2a3446"], ["#46677f", "#3b5e5a", "#2c3848"], ["#5a7d8f", "#4b7063", "#313d4c"], ["#6d8e99", "#5f8672", "#384456"]]
    : [["#9fb6c0", "#b7c9bd", sky.mist], ["#6f97ad", "#8fb7a1", "#c9cdb0"], ["#4d7c97", "#6ea287", "#c4bb8f"], ["#35637d", "#4f8a6c", "#b39a68"]];
  const layers = palettes.length;
  for (let L = 0; L < layers; L++) {
    const depth = L / (layers - 1), base = h * (0.5 + depth * 0.32);
    const peaks = Array.from({ length: rng.int(2, 4) }, () => ({ c: rng.range(-0.1, 1.1) * w, r: rng.range(0.07, 0.17) * w * (1 + depth * 0.6), hgt: rng.range(0.14, 0.3) * h * (1.1 - depth * 0.35) }));
    const pts: Point[] = [];
    for (let x = -10; x <= w + 10; x += w / 90) {
      let y = base;
      for (const m of peaks) {
        const d = Math.abs(x - m.c) / m.r;
        y -= m.hgt * Math.pow(Math.max(0, 1 - (d * d) / 4), 2.2) * (1 + 0.08 * Math.sin(x * 0.05));
      }
      pts.push({ x, y: y + rng.gauss() * 0.6 });
    }
    const minY = Math.min(...pts.map((q) => q.y)), pal = palettes[L];
    const fill = ctx.createLinearGradient(0, minY, 0, base + h * 0.04);
    fill.addColorStop(0, pal[0]);
    fill.addColorStop(0.55, pal[1]);
    fill.addColorStop(1, pal[2]);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-10, h);
    for (const q of pts) ctx.lineTo(q.x, q.y);
    ctx.lineTo(w + 10, h);
    ctx.closePath();
    ctx.fill();
    // Texture strokes down the slopes.
    ctx.strokeStyle = sky.night ? "rgba(10,16,24,0.18)" : rgba(mix(pal[0], "#1c2b33", 0.4), 0.22);
    ctx.lineWidth = 0.7;
    for (let c = 0; c < 70 * (1 + depth); c++) {
      const q = pts[rng.int(0, pts.length - 1)], yy = q.y + rng.range(2, (base - q.y) * 0.8 + 4);
      if (yy > base) continue;
      ctx.beginPath();
      ctx.moveTo(q.x, yy);
      ctx.lineTo(q.x + rng.range(-5, 5), yy + rng.range(3, 9));
      ctx.stroke();
    }
    if (L >= 2) {
      for (let t = rng.int(2, 5); t > 0; t--) {
        const q = pts[rng.int(5, pts.length - 6)];
        pine(ctx, q.x, q.y + 2, h * rng.range(0.03, 0.05) * (L === 3 ? 1.3 : 1), sky.night ? "#1a2c2a" : "#2f4d3c", rng);
      }
    }
    // Mist fills everything below this ridge, so the next ridge floats.
    const veil = ctx.createLinearGradient(0, base - h * 0.09, 0, base + h * 0.01);
    veil.addColorStop(0, rgba(sky.mist, 0));
    veil.addColorStop(1, rgba(sky.mist, sky.night ? 0.7 : 0.94));
    ctx.fillStyle = veil;
    ctx.fillRect(0, base - h * 0.09, w, h * 0.1);
    ctx.fillStyle = rgba(sky.mist, sky.night ? 0.7 : 0.94);
    ctx.fillRect(0, base + h * 0.01 - 0.5, w, h);
  }
  const waterTop = h * 0.86;
  const water = ctx.createLinearGradient(0, waterTop - h * 0.03, 0, h);
  water.addColorStop(0, rgba(sky.water, 0));
  water.addColorStop(0.2, rgba(sky.water, 1));
  water.addColorStop(1, rgba(sky.water, 1));
  ctx.fillStyle = water;
  ctx.fillRect(0, waterTop - h * 0.03, w, h - waterTop + h * 0.03);
  ctx.strokeStyle = sky.night ? "rgba(200,210,225,0.18)" : "rgba(60,90,100,0.2)";
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 60; i++) {
    const wx = rng.range(0, w), wy = rng.range(waterTop + 4, h), wr = rng.range(4, 10);
    ctx.beginPath();
    ctx.arc(wx, wy + wr, wr, Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();
  }
  if (sky.night) {
    ctx.fillStyle = "rgba(239,230,200,0.25)";
    for (let r = 0; r < 8; r++) ctx.fillRect(sx - rng.range(4, 18), waterTop + 6 + r * 5, rng.range(8, 36), 1.2);
  }
  const boat = sky.night ? "#0e141d" : "#3b3a35";
  const bx = rng.range(0.25, 0.75) * w, by = waterTop + (h - waterTop) * 0.45, bl = w * 0.05;
  ctx.fillStyle = boat;
  ctx.beginPath();
  ctx.moveTo(bx - bl / 2, by);
  ctx.quadraticCurveTo(bx, by + bl * 0.16, bx + bl / 2, by - bl * 0.04);
  ctx.quadraticCurveTo(bx, by + bl * 0.07, bx - bl / 2, by);
  ctx.fill();
  dot(ctx, bx + bl * 0.1, by - bl * 0.12, bl * 0.06, boat);
  stroke(ctx, [{ x: bx + bl * 0.16, y: by - bl * 0.06 }, { x: bx + bl * 0.42, y: by + bl * 0.2 }], boat, 0.9);
  if (!sky.night) {
    for (let b = rng.int(2, 4); b > 0; b--) {
      const x = rng.range(0.2, 0.8) * w, y = rng.range(0.1, 0.3) * h, s = rng.range(3, 5);
      ctx.strokeStyle = "rgba(40,40,40,0.6)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s * 0.4);
      ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.5, x, y);
      ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.5, x + s, y - s * 0.4);
      ctx.stroke();
    }
  }
};

// ---------------------------------------------------------------------------
// 海流: currents traced through a noise field, with one calm eddy.
// ---------------------------------------------------------------------------
const CURRENTS = [
  { bg: "#0f2433", line: "#9fcad6", accent: "#f0b67f" },
  { bg: "#eef2f1", line: "#1f5566", accent: "#d9694f" },
  { bg: "#13302c", line: "#a9d3c0", accent: "#e8c872" },
];
export const currents: Scene = (ctx, w, h, rng) => {
  const pal = rng.pick(CURRENTS);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  const noise = makeNoise(rng), scale = rng.range(1.4, 2.4) / w, bend = rng.range(0.9, 1.5);
  const lines = Math.round((w * h) / 520);
  for (let i = 0; i < lines; i++) {
    let x = rng.range(-0.1, 1.05) * w, y = rng.range(-0.05, 1.05) * h;
    const accent = rng.chance(0.025);
    ctx.strokeStyle = rgba(accent ? pal.accent : pal.line, accent ? 0.85 : rng.range(0.18, 0.55));
    ctx.lineWidth = accent ? 1.3 : rng.range(0.5, 1.1);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = rng.int(30, 90); s > 0; s--) {
      const angle = noise(x * scale, y * scale) * Math.PI * bend;
      x += Math.cos(angle) * 2.2;
      y += Math.sin(angle) * 2.2;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (rng.chance(0.7)) {
    const cx = rng.range(0.2, 0.8) * w, cy = rng.range(0.25, 0.75) * h, r = Math.min(w, h) * rng.range(0.07, 0.12);
    dot(ctx, cx, cy, r * 1.35, pal.bg);
    ctx.strokeStyle = rgba(pal.line, 0.7);
    ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(cx, cy, r * (1 - k * 0.28), 0, TAU); ctx.stroke(); }
    dot(ctx, cx, cy, r * 0.12, pal.accent);
  }
};

// ---------------------------------------------------------------------------
// 剪纸: Matisse-like cut paper fronds, stars and a disc, with a paper shadow.
// ---------------------------------------------------------------------------
const CUT = [
  { bg: "#2f4f8a", shapes: ["#f4efe4", "#f2c75c", "#f1a3a0"] },
  { bg: "#f1ece3", shapes: ["#2f4f8a", "#d9573d", "#2f6b52"] },
  { bg: "#2b4d40", shapes: ["#f4efe4", "#e9a74b", "#9cc3d5"] },
  { bg: "#c9553e", shapes: ["#f4efe4", "#223a66", "#f2c75c"] },
];
/** A frond is a tapering stem with rounded lobes alternating on each side. */
function frond(ctx: Ctx, x: number, y: number, len: number, angle: number, width: number, rng: Rng) {
  const ca = Math.cos(angle), sa = Math.sin(angle), bend = rng.range(-0.25, 0.25);
  const at = (t: number, side: number, off: number) => {
    const a = t * len, b = Math.sin(t * Math.PI) * len * bend * 0.3 + side * off;
    return { x: x + a * ca - b * sa, y: y + a * sa + b * ca };
  };
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30, sw = width * 0.22 * (1 - t * 0.85);
    left.push(at(t, -1, sw));
    right.push(at(t, 1, sw));
  }
  fillPoly(ctx, left.concat(right.reverse()));
  const lobes = rng.int(4, 7);
  for (let k = 0; k < lobes; k++) {
    const t0 = 0.12 + (k / lobes) * 0.8, side = k % 2 ? 1 : -1, size = width * (1 - t0 * 0.7) * rng.range(0.8, 1.1);
    const c = at(t0, side, size * 0.55);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(angle + side * rng.range(0.5, 0.9));
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.75, size * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  const tip = at(1, 0, 0);
  ctx.beginPath();
  ctx.ellipse(tip.x, tip.y, width * 0.28, width * 0.18, angle, 0, TAU);
  ctx.fill();
}
function star(ctx: Ctx, x: number, y: number, r: number, rng: Rng) {
  fillPoly(ctx, Array.from({ length: 10 }, (_, k) => {
    const a = (k / 10) * TAU + rng.range(-0.06, 0.06) - Math.PI / 2, rr = (k % 2 ? r * 0.45 : r) * rng.range(0.88, 1.1);
    return { x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr };
  }));
}
export const cutPaper: Scene = (ctx, w, h, rng) => {
  const pal = rng.pick(CUT);
  paper(ctx, w, h, pal.bg, rng, { blots: 10 });
  const colors = rng.shuffle(pal.shapes);
  type Item = { kind: "frond" | "star" | "disc"; x: number; y: number; size: number; angle?: number; width?: number; color: string };
  const plan: Item[] = [];
  const fronds = rng.int(2, 4);
  for (let i = 0; i < fronds; i++) {
    plan.push({ kind: "frond", x: ((i + 0.5) / fronds + rng.range(-0.08, 0.08)) * w, y: h * rng.range(1.02, 1.12), size: h * rng.range(0.6, 0.95), angle: -Math.PI / 2 + rng.range(-0.35, 0.35), width: h * rng.range(0.14, 0.2), color: colors[i % colors.length] });
  }
  for (let s = rng.int(1, 3); s > 0; s--) plan.push({ kind: "star", x: rng.range(0.1, 0.9) * w, y: rng.range(0.12, 0.5) * h, size: h * rng.range(0.04, 0.07), color: rng.pick(colors) });
  if (rng.chance(0.7)) plan.push({ kind: "disc", x: rng.range(0.1, 0.9) * w, y: rng.range(0.12, 0.4) * h, size: h * rng.range(0.06, 0.1), color: colors[colors.length - 1] });
  // Each shape redraws from its own seed so the shadow and the paper line up exactly.
  const paint = (item: Item) => {
    const local = makeRng(`${item.x}:${item.y}`);
    if (item.kind === "frond") frond(ctx, item.x, item.y, item.size, item.angle ?? 0, item.width ?? 20, local);
    else if (item.kind === "star") star(ctx, item.x, item.y, item.size, local);
    else { ctx.beginPath(); ctx.arc(item.x, item.y, item.size, 0, TAU); ctx.fill(); }
  };
  for (const item of plan) {
    ctx.save();
    ctx.translate(1.5, 2.5);
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    paint(item);
    ctx.restore();
    ctx.fillStyle = item.color;
    paint(item);
  }
};

// ---------------------------------------------------------------------------
// 植物标本: a pressed branch with washed leaves, taped down, with a ruled label.
// ---------------------------------------------------------------------------
function leafAt(ctx: Ctx, p: Point, angle: number, len: number, greens: string[], ink: string, rng: Rng) {
  const half = (sign: number) => Array.from({ length: 19 }, (_, k) => {
    const t = k / 18;
    return { a: t * len, b: sign * Math.sin(Math.PI * Math.pow(t, 0.75)) * len * 0.24 };
  });
  const shape = half(-1).concat(half(1).reverse());
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const world = shape.map((o) => ({ x: p.x + o.a * ca - o.b * sa, y: p.y + o.a * sa + o.b * ca }));
  wash(ctx, world, rng.pick(greens), rng, { layers: 8, alpha: 0.13, spread: 0.03, edge: 0.04 });
  ctx.strokeStyle = rgba(ink, 0.55);
  ctx.lineWidth = 0.7;
  tracePoly(ctx, world);
  ctx.stroke();
  stroke(ctx, [p, { x: p.x + len * 0.9 * ca, y: p.y + len * 0.9 * sa }], rgba(ink, 0.45), 0.6);
}
function branchPath(from: Point, angle: number, length: number, curl: number, steps: number): Point[] {
  const pts: Point[] = [];
  let a = angle, x = from.x, y = from.y;
  for (let i = 0; i <= steps; i++) {
    pts.push({ x, y });
    a += curl;
    x += (Math.cos(a) * length) / steps;
    y += (Math.sin(a) * length) / steps;
  }
  return pts;
}
export const botanical: Scene = (ctx, w, h, rng) => {
  paper(ctx, w, h, "#f2f1ec", rng, { blots: 12 });
  const ink = "#2b2f2a";
  const greens = rng.pick([["#6f9a6a", "#9dbb86"], ["#5d8a7c", "#9ec2ad"], ["#8a9a5b", "#b7bf7f"]]);
  const accent = rng.pick(["#c6523f", "#d69a3a", "#7b5aa6", "#d77b91"]);
  const labelLeft = rng.chance(0.5);
  const base = { x: w * (labelLeft ? rng.range(0.52, 0.62) : rng.range(0.34, 0.46)), y: h * 1.02 };
  const main = branchPath(base, -Math.PI / 2 + rng.range(-0.15, 0.15), h * 0.86, rng.range(-0.012, 0.012), 40);
  const twigs = [{ pts: main, width: 2.6 }];
  for (let s = rng.int(2, 3); s > 0; s--) {
    const at = main[rng.int(12, 30)], dir = s % 2 ? 1 : -1;
    twigs.push({ pts: branchPath(at, -Math.PI / 2 + dir * rng.range(0.5, 0.9), h * rng.range(0.22, 0.34), -dir * rng.range(0.01, 0.025), 18), width: 1.6 });
  }
  for (const twig of twigs) {
    const pts = twig.pts;
    for (let l = 5; l < pts.length - 2; l += rng.int(3, 5)) {
      const p = pts[l], q = pts[l + 1], dir = Math.atan2(q.y - p.y, q.x - p.x);
      leafAt(ctx, p, dir + (l % 2 ? 1 : -1) * rng.range(0.55, 0.95), h * rng.range(0.07, 0.12) * (1 - (l / pts.length) * 0.4), greens, ink, rng);
    }
  }
  for (const twig of twigs) {
    brush(ctx, twig.pts, rng, { width: twig.width, bristles: 3, dry: 0.03, color: ink, taper: (t) => 1 - t * 0.7 });
    const tip = twig.pts[twig.pts.length - 1];
    for (let b = rng.int(3, 5); b > 0; b--) {
      const bx = tip.x + rng.gauss() * w * 0.018, by = tip.y + rng.range(-h * 0.03, h * 0.03);
      stroke(ctx, [tip, { x: bx, y: by }], rgba(ink, 0.5), 0.6);
      dab(ctx, bx, by, rng.range(2.6, 4.2), accent, 0.72, rng);
    }
  }
  ctx.save();
  ctx.translate(main[4].x, main[4].y);
  ctx.rotate(rng.range(-0.3, 0.3));
  ctx.fillStyle = "rgba(226,214,184,0.8)";
  ctx.fillRect(-w * 0.06, -h * 0.022, w * 0.12, h * 0.044);
  ctx.restore();
  const lw = w * 0.22, lh = h * 0.17, lx = labelLeft ? w * 0.06 : w * 0.72, ly = h * 0.75;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(lx, ly, lw, lh);
  ctx.strokeStyle = rgba(ink, 0.35);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(lx, ly, lw, lh);
  for (let r = 1; r <= 3; r++) {
    ctx.beginPath();
    ctx.moveTo(lx + lw * 0.08, ly + (r * lh) / 4.2);
    ctx.lineTo(lx + lw * (r === 1 ? 0.62 : 0.9), ly + (r * lh) / 4.2);
    ctx.stroke();
  }
  seal(ctx, lx + lw * 0.7, ly + lh * 0.1, lh * 0.26, rng);
};

