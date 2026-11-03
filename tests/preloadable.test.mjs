import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { preloadable, preloadWhenIdle } from "../components/studio/preloadable.ts";

const Greeting = ({ name }) => createElement("p", null, `你好，${name}`);
const inSuspense = (Component) => renderToString(createElement(Suspense, { fallback: createElement("i", null, "正在准备…") }, createElement(Component, { name: "小林" })));

test("a code-split surface renders straight away once preloaded", async () => {
  let loads = 0;
  const Surface = preloadable(async () => { loads++; return { default: Greeting }; });
  assert.match(inSuspense(Surface), /正在准备…/, "before loading it falls back like React.lazy");
  await Surface.preload();
  await Surface.preload();
  assert.match(inSuspense(Surface), /你好，小林/);
  assert.equal(loads, 1, "the chunk is requested once");
});

test("a chunk that failed to load is requested again by the next preload", async () => {
  let online = false;
  const Surface = preloadable(async () => { if (!online) throw new Error("offline"); return { default: Greeting }; });
  await assert.rejects(Surface.preload(), /offline/);
  online = true;
  await Surface.preload();
  assert.match(inSuspense(Surface), /你好，小林/);
});

test("idle warm-up loads one chunk per slice, keeps going past failures and stops when cancelled", async () => {
  const slices = [];
  const original = globalThis.requestIdleCallback;
  const cancelOriginal = globalThis.cancelIdleCallback;
  globalThis.requestIdleCallback = (run) => slices.push(run);
  globalThis.cancelIdleCallback = () => {};
  try {
    const started = [];
    const cancel = preloadWhenIdle([
      async () => { started.push("a"); throw new Error("offline"); },
      async () => { started.push("b"); },
      async () => { started.push("c"); },
    ]);
    const flush = async () => { slices.shift()?.(); await new Promise((resolve) => setTimeout(resolve, 0)); };
    await flush();
    assert.deepEqual(started, ["a"], "one loader per idle slice");
    await flush();
    assert.deepEqual(started, ["a", "b"], "a failed chunk does not stop the rest");
    cancel();
    await flush();
    assert.deepEqual(started, ["a", "b"], "nothing loads after cancelling");
  } finally {
    globalThis.requestIdleCallback = original;
    globalThis.cancelIdleCallback = cancelOriginal;
  }
});

test("delayed warm-up can be cancelled before it schedules an idle slice", async () => {
  const originalWindow = globalThis.window;
  const originalIdle = globalThis.requestIdleCallback;
  let scheduled = false;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.requestIdleCallback = () => { scheduled = true; };
  try {
    const cancel = preloadWhenIdle([async () => {}], 15);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(scheduled, false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.requestIdleCallback = originalIdle;
  }
});
