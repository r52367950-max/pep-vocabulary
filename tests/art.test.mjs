import assert from "node:assert/strict";
import test from "node:test";
import { makeRng, hashString } from "../lib/art/core.ts";
import { blueGreen, botanical, currents, cutPaper, inkVillage } from "../lib/art/scenes.ts";
import { artKey, readingArtKind, timeOfDay } from "../lib/art/index.ts";

// A stand-in 2D context that records every drawing call, so scenes can run without a browser.
function recordingContext() {
  const log = [];
  const gradient = { addColorStop: (...args) => log.push(["stop", ...args]) };
  const ctx = new Proxy({ canvas: { width: 0, height: 0 } }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") return (...args) => { log.push([key, ...args.map(Math.round)]); return gradient; };
      return (...args) => { log.push([key, ...args.map((v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v))]); };
    },
    set(target, key, value) { log.push(["set", key, value]); return true; },
  });
  return { ctx, log };
}
const scenes = { inkVillage, blueGreen, currents, cutPaper, botanical };

test("seeded randomness is stable across runs and differs between seeds", () => {
  const a = makeRng("noaa-tides"), b = makeRng("noaa-tides"), c = makeRng("noaa-currents");
  const first = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(first, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(first, Array.from({ length: 5 }, () => c.next()));
  assert.ok(first.every((value) => value >= 0 && value < 1));
  assert.equal(hashString("词迹"), hashString("词迹"));
});

test("every scene paints without errors at card, banner and thumbnail sizes, for many seeds", () => {
  for (const [name, scene] of Object.entries(scenes)) {
    for (const [w, h] of [[480, 320], [1100, 320], [120, 80], [350, 150]]) {
      for (let seed = 0; seed < 4; seed++) {
        const { ctx, log } = recordingContext();
        scene(ctx, w, h, makeRng(`${name}:${seed}`), { time: ["dawn", "day", "dusk", "night"][seed] });
        assert.ok(log.length > 50, `${name} ${w}x${h} drew almost nothing`);
        assert.ok(log.every((entry) => entry.every((value) => typeof value !== "number" || Number.isFinite(value))), `${name} produced a non-finite coordinate`);
      }
    }
  }
});

test("the same article always gets the same picture, and different articles differ", () => {
  const paint = (seed) => { const { ctx, log } = recordingContext(); inkVillage(ctx, 480, 320, makeRng(`ink:${seed}`), {}); return JSON.stringify(log); };
  assert.equal(paint("thoreau-walking"), paint("thoreau-walking"));
  assert.notEqual(paint("thoreau-walking"), paint("emerson-nature"));
});

test("reading categories map to their illustration style", () => {
  assert.equal(readingArtKind("essay"), "ink");
  assert.equal(readingArtKind("fiction"), "cutout");
  assert.equal(readingArtKind("science"), "currents");
});

test("the Today landscape follows the local hour", () => {
  const at = (h, m = 0) => timeOfDay(new Date(2026, 8, 24, h, m));
  assert.equal(at(4, 59), "night");
  assert.equal(at(5), "dawn");
  assert.equal(at(7, 59), "dawn");
  assert.equal(at(8), "day");
  assert.equal(at(16, 59), "day");
  assert.equal(at(17), "dusk");
  assert.equal(at(19, 29), "dusk");
  assert.equal(at(19, 30), "night");
  assert.equal(at(23), "night");
});

test("cache keys separate size, pixel ratio, time of day and the copy's clear area", () => {
  const base = { kind: "shanshui", seed: "2026-09-24", time: "day", width: 620, height: 320, ratio: 2 };
  assert.notEqual(artKey(base), artKey({ ...base, ratio: 1 }));
  assert.notEqual(artKey(base), artKey({ ...base, time: "night" }));
  assert.notEqual(artKey(base), artKey({ ...base, width: 621 }));
  assert.notEqual(artKey(base), artKey({ ...base, clear: 0.72 }));
});

test("the Today moon keeps out from under the copy and leaves the rest of the picture in place", () => {
  // Counts each draw from the generator, so two paintings can be compared draw for draw.
  const counted = (seed) => {
    const rng = makeRng(seed), draws = [];
    return { draws, rng: new Proxy(rng, { get: (target, key) => typeof target[key] === "function" ? (...args) => { draws.push(key); return target[key](...args); } : target[key] }), next: () => rng.next() };
  };
  const paint = (seed, clear) => {
    const { ctx, log } = recordingContext();
    const counter = counted(`shanshui:${seed}`);
    blueGreen(ctx, 350, 210, counter.rng, { time: "night", clear });
    // The halo is centred on the moon. Paper blots start their gradients at radius 0; the halo starts at the moon's rim.
    return { moonX: log.find((entry) => entry[0] === "createRadialGradient" && entry[3] > 0)[1], draws: counter.draws, after: counter.next() };
  };
  const free = [];
  for (let seed = 0; seed < 24; seed++) {
    const open = paint(seed), kept = paint(seed, 0.72);
    free.push(open.moonX);
    assert.ok(kept.moonX >= 0.72 * 350 - 1 && kept.moonX <= 0.85 * 350 + 1, `seed ${seed} put the moon at ${kept.moonX}`);
    assert.deepEqual(kept.draws, open.draws, `seed ${seed} drew a different sequence`);
    assert.equal(kept.after, open.after, `seed ${seed} left the generator elsewhere`);
  }
  assert.ok(Math.min(...free) < 0.4 * 350, "without a clear area the moon still roams the whole sky");
});
