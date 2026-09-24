// Runtime measurements for the app shell under 4x CPU throttling (mid-range phone approximation).
// Usage: node artifacts/perf/runtime.mjs <label=url> [<label=url> ...] [--runs=5] [--out=file.json]
// Runs alternate between the given servers so machine noise affects both sides alike.
// Each run uses a fresh browser context (empty IndexedDB), desktop 1280x800.
import { writeFileSync } from "node:fs";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith("--")).map((a) => {
  const [label, url] = a.split("=");
  return { label, url };
});
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) || 5);
const out = args.find((a) => a.startsWith("--out="))?.slice(6);
const THROTTLE = 4;

// Injected before any page script. Records long tasks, event timing, rAF frames,
// keydown listener registrations and React component renders per commit (via the
// DevTools global hook, which production React DOM also reports to).
const instrument = () => {
  const P = (window.__perf = { longtasks: [], events: [], keydownAdds: 0, commits: [], frames: null });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) P.longtasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      P.events.push({ name: e.name, start: e.startTime, duration: e.duration, id: e.interactionId || 0, processing: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === "keydown" && (this === document || this === window)) P.keydownAdds++;
    return add.call(this, type, ...rest);
  };
  const seen = new WeakMap();
  const componentTags = new Set([0, 1, 11, 14, 15]);
  const count = (root) => {
    let rendered = 0;
    const stack = [root.current];
    while (stack.length) {
      const f = stack.pop();
      if (!f) continue;
      if (componentTags.has(f.tag)) {
        const prev = seen.get(f) || (f.alternate && seen.get(f.alternate));
        if (!prev || prev.p !== f.memoizedProps || prev.s !== f.memoizedState) rendered++;
        const record = { p: f.memoizedProps, s: f.memoizedState };
        seen.set(f, record);
        if (f.alternate) seen.set(f.alternate, record);
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return rendered;
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { id++; this.renderers.set(id, renderer); return id; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { P.commits.push({ at: performance.now(), rendered: count(root) }); },
  };
  P.startFrames = () => {
    P.frames = [];
    const tick = (t) => { if (P.frames) { P.frames.push(t); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  };
  P.stopFrames = () => { const f = P.frames; P.frames = null; return f; };
  // Key-to-feedback: from the keydown timestamp to the frame after `done()` first holds.
  addEventListener("keydown", (e) => { P.lastKey = e.timeStamp; }, true);
  P.keyToFrame = (source) => new Promise((resolve) => {
    const done = new Function(`return (${source})`)();
    const check = () => {
      if (!done()) return false;
      observer.disconnect();
      requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - P.lastKey), 0));
      return true;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  P.mark = () => ({ at: performance.now(), lt: P.longtasks.length, ev: P.events.length, cm: P.commits.length, kd: P.keydownAdds });
  P.since = (m) => {
    const lts = P.longtasks.slice(m.lt);
    const evs = P.events.slice(m.ev);
    const byInteraction = new Map();
    for (const e of evs) if (e.id) byInteraction.set(e.id, Math.max(byInteraction.get(e.id) || 0, e.duration));
    const commits = P.commits.slice(m.cm);
    return {
      ms: performance.now() - m.at,
      longTasks: lts.length,
      longTaskMs: lts.reduce((s, t) => s + t.duration, 0),
      tbt: lts.reduce((s, t) => s + Math.max(0, t.duration - 50), 0),
      interactions: [...byInteraction.values()],
      commits: commits.length,
      rendered: commits.reduce((s, c) => s + c.rendered, 0),
      keydownAdds: P.keydownAdds - m.kd,
    };
  };
};

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const settle = (page, ms = 250) => page.waitForTimeout(ms);

async function measure(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const result = {};

  // 1. Load: app ready (Today rendered) and TTI (end of last long task before a 5 s quiet window).
  if (process.env.PERF_DEBUG) console.error("phase 1");
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector(".today-view", { timeout: 60000 });
  const ready = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => {
    const lts = window.__perf.longtasks;
    const last = lts.length ? lts[lts.length - 1].start + lts[lts.length - 1].duration : 0;
    return performance.now() - Math.max(last, 0) > 5000;
  }, null, { timeout: 60000, polling: 250 });
  result.load = await page.evaluate((readyAt) => {
    const lts = window.__perf.longtasks;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const last = lts.length ? Math.max(...lts.map((t) => t.start + t.duration)) : readyAt;
    const tti = Math.max(readyAt, last);
    return {
      appReadyMs: readyAt,
      ttiMs: tti,
      tbtMs: lts.filter((t) => t.start >= fcp && t.start < tti).reduce((s, t) => s + Math.max(0, t.duration - 50), 0),
      reactCommits: window.__perf.commits.length,
    };
  }, ready);

  // 2. Toast: show (click 错词重练 with nothing due) and auto-dismiss after 5 s.
  if (process.env.PERF_DEBUG) console.error("phase 2");
  let m = await page.evaluate(() => window.__perf.mark());
  await page.click(".today-footnotes button:first-child");
  await page.waitForSelector(".toast-region .toast");
  await settle(page);
  const shown = await page.evaluate((mk) => window.__perf.since(mk), m);
  m = await page.evaluate(() => window.__perf.mark());
  await page.waitForSelector(".toast-region .toast", { state: "detached", timeout: 10000 });
  await settle(page);
  const hidden = await page.evaluate((mk) => window.__perf.since(mk), m);
  result.toast = { showRendered: shown.rendered, showCommits: shown.commits, showInteractionMs: Math.max(0, ...shown.interactions), hideRendered: hidden.rendered, hideCommits: hidden.commits };

  // 3. Tab switches (warm: first pass loads the lazy chunks, the next two are measured).
  if (process.env.PERF_DEBUG) console.error("phase 3");
  const tabs = [["词库", ".lexicon-view"], ["阅读", ".reading-shelf"], ["学习记录", ".activity-view"], ["今日学习", ".today-view"]];
  const switchTimes = [];
  const switchRendered = [];
  for (let pass = 0; pass < 3; pass++) {
    for (const [label, selector] of tabs) {
      const mk = await page.evaluate(() => window.__perf.mark());
      const ms = await page.evaluate(async ([l, s]) => {
        const button = [...document.querySelectorAll(".app-sidebar button")].find((b) => b.getAttribute("aria-label") === l);
        const t0 = performance.now();
        button.click();
        const deadline = t0 + 20000;
        while (!document.querySelector(s) || document.querySelector(".view-loading")) {
          if (performance.now() > deadline) throw new Error(`timeout ${s}`);
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        return performance.now() - t0;
      }, [label, selector]);
      await settle(page, 400);
      const s = await page.evaluate((x) => window.__perf.since(x), mk);
      if (pass > 0) { switchTimes.push(ms); switchRendered.push(s.rendered); }
    }
  }
  result.tabs = { switchMedianMs: median(switchTimes), switchMaxMs: Math.max(...switchTimes), renderedPerSwitchMedian: median(switchRendered) };

  // 4. Lexicon paging over the whole lexicon: ten "next page" clicks.
  if (process.env.PERF_DEBUG) console.error("phase 4");
  await page.click('.app-sidebar button[aria-label="词库"]');
  await page.waitForSelector(".lexicon-view");
  await page.click(".scope-switch button:has-text('全部')");
  await settle(page, 600);
  m = await page.evaluate(() => { window.__perf.startFrames(); return window.__perf.mark(); });
  const pageClicks = [];
  for (let i = 0; i < 10; i++) {
    const ms = await page.evaluate(async () => {
      const label = document.querySelector(".pagination span").textContent;
      const next = [...document.querySelectorAll(".pagination button")].at(-1);
      const t0 = performance.now();
      next.click();
      while (document.querySelector(".pagination span").textContent === label) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    });
    pageClicks.push(ms);
    await settle(page, 150);
  }
  const paging = await page.evaluate((mk) => {
    const frames = window.__perf.stopFrames();
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    return { ...window.__perf.since(mk), longFrames: gaps.filter((g) => g > 50).length, droppedFrames: gaps.reduce((s, g) => s + Math.max(0, Math.round(g / 16.7) - 1), 0) };
  }, m);
  result.paging = { clickToPaintMedianMs: median(pageClicks), longTasks: paging.longTasks, tbtMs: paging.tbt, longFrames: paging.longFrames, droppedFrames: paging.droppedFrames, renderedPerClick: paging.rendered / 10 };

  // 5. Reading: open the first article, enable lookup, then change the font size 6 times.
  if (process.env.PERF_DEBUG) console.error("phase 5");
  await page.click('.app-sidebar button[aria-label="阅读"]');
  await page.waitForSelector(".reading-card");
  await page.click(".reading-card >> nth=0");
  await page.waitForSelector(".reader-prose");
  const lookupButton = page.locator(".reader-translation-toggle", { hasText: "查词" });
  if (await lookupButton.count()) await lookupButton.click();
  await settle(page, 600);
  m = await page.evaluate(() => window.__perf.mark());
  const fontClicks = [];
  for (let i = 0; i < 6; i++) {
    const ms = await page.evaluate(async (bigger) => {
      const b = document.querySelector(`.reader-type-size button[aria-label="${bigger ? "放大字号" : "缩小字号"}"]`);
      const t0 = performance.now();
      b.click();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    }, i % 2 === 0);
    fontClicks.push(ms);
    await settle(page, 150);
  }
  const reading = await page.evaluate((mk) => window.__perf.since(mk), m);
  result.reading = { fontClickToPaintMedianMs: median(fontClicks), longTasks: reading.longTasks, tbtMs: reading.tbt };

  // 6. Practice: start 20 words from the lexicon, answer each with Space (reveal) + Space (rate).
  if (process.env.PERF_DEBUG) console.error("phase 6");
  await page.click('.app-sidebar button[aria-label="词库"]');
  await page.waitForSelector(".lexicon-view");
  await page.click(".word-list-meta .primary.small");
  await page.waitForSelector(".study-question");
  await settle(page, 800);
  m = await page.evaluate(() => window.__perf.mark());
  let answered = 0;
  const revealLatency = [];
  const nextLatency = [];
  for (let i = 0; i < 20; i++) {
    if (!(await page.$(".study-question"))) break;
    const before = await page.textContent(".study-header strong");
    // Install the observer before the key is sent, then collect the latency.
    await page.evaluate(() => { window.__perf.pending = window.__perf.keyToFrame('() => document.querySelector(".study-question.is-revealed")'); });
    await page.keyboard.press("Space");
    revealLatency.push(await page.evaluate(() => window.__perf.pending));
    await settle(page, 120);
    await page.evaluate((b) => { window.__perf.pending = window.__perf.keyToFrame(`() => { const s = document.querySelector(".study-header strong"); return !s || (s.textContent !== ${JSON.stringify(b)} && !document.querySelector(".study-question.is-revealed")); }`); }, before);
    await page.keyboard.press("Space");
    nextLatency.push(await page.evaluate(() => window.__perf.pending));
    await settle(page, 120);
    answered++;
  }
  const practice = await page.evaluate((mk) => window.__perf.since(mk), m);
  const sorted = [...practice.interactions].sort((a, b) => a - b);
  result.practice = {
    answered,
    keyPresses: answered * 2,
    longTasks: practice.longTasks,
    longTaskMs: Math.round(practice.longTaskMs),
    tbtMs: Math.round(practice.tbt),
    interactionMedianMs: median(practice.interactions),
    interactionP90Ms: sorted[Math.floor(sorted.length * 0.9)] ?? null,
    interactionMaxMs: sorted.at(-1) ?? null,
    renderedPerKey: practice.rendered / Math.max(1, answered * 2),
    revealKeyToFrameMedianMs: median(revealLatency),
    nextCardKeyToFrameMedianMs: median(nextLatency),
    nextCardKeyToFrameP90Ms: [...nextLatency].sort((a, b) => a - b)[Math.floor(nextLatency.length * 0.9)],
    keydownListenerAdds: practice.keydownAdds,
  };
  result.errors = errors;
  await context.close();
  return result;
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const all = Object.fromEntries(targets.map((t) => [t.label, []]));
for (let run = 0; run < runs; run++) {
  for (const t of run % 2 ? [...targets].reverse() : targets) {
    const r = await measure(browser, t.url);
    all[t.label].push(r);
    console.error(`run ${run + 1}/${runs} ${t.label}: ready ${Math.round(r.load.appReadyMs)} ms, practice TBT ${r.practice.tbtMs} ms, errors ${r.errors.length}`);
  }
}
await browser.close();

const summarize = (list) => {
  const pick = (f) => median(list.map(f));
  return {
    runs: list.length,
    load: { appReadyMs: pick((r) => r.load.appReadyMs), ttiMs: pick((r) => r.load.ttiMs), tbtMs: pick((r) => r.load.tbtMs) },
    toast: { showRendered: pick((r) => r.toast.showRendered), hideRendered: pick((r) => r.toast.hideRendered), showInteractionMs: pick((r) => r.toast.showInteractionMs) },
    tabs: { switchMedianMs: pick((r) => r.tabs.switchMedianMs), switchMaxMs: pick((r) => r.tabs.switchMaxMs), renderedPerSwitch: pick((r) => r.tabs.renderedPerSwitchMedian) },
    paging: { clickToPaintMs: pick((r) => r.paging.clickToPaintMedianMs), longTasks: pick((r) => r.paging.longTasks), tbtMs: pick((r) => r.paging.tbtMs), longFrames: pick((r) => r.paging.longFrames), droppedFrames: pick((r) => r.paging.droppedFrames), renderedPerClick: pick((r) => r.paging.renderedPerClick) },
    reading: { fontClickToPaintMs: pick((r) => r.reading.fontClickToPaintMedianMs), longTasks: pick((r) => r.reading.longTasks), tbtMs: pick((r) => r.reading.tbtMs) },
    practice: {
      keyPresses: pick((r) => r.practice.keyPresses),
      longTasks: pick((r) => r.practice.longTasks),
      tbtMs: pick((r) => r.practice.tbtMs),
      interactionMedianMs: pick((r) => r.practice.interactionMedianMs),
      interactionP90Ms: pick((r) => r.practice.interactionP90Ms),
      interactionMaxMs: pick((r) => r.practice.interactionMaxMs),
      renderedPerKey: pick((r) => r.practice.renderedPerKey),
      revealKeyToFrameMs: pick((r) => r.practice.revealKeyToFrameMedianMs),
      nextCardKeyToFrameMs: pick((r) => r.practice.nextCardKeyToFrameMedianMs),
      nextCardKeyToFrameP90Ms: pick((r) => r.practice.nextCardKeyToFrameP90Ms),
      keydownListenerAdds: pick((r) => r.practice.keydownListenerAdds),
    },
    errors: [...new Set(list.flatMap((r) => r.errors))],
  };
};
const summary = { throttle: `${THROTTLE}x CPU`, viewport: "1280x800", runs, results: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, summarize(v)])) };
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(out, JSON.stringify({ summary, raw: all }, null, 2));
