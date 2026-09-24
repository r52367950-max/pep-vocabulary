import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { currentToast, notify, subscribeToast } from "../hooks/toast-store.ts";

const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(join(root, path), "utf8");

test("toast store notifies subscribers and dismisses after five seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const unsubscribe = subscribeToast(() => calls++);
  try {
    notify("未能保存，请重试。");
    assert.equal(currentToast(), "未能保存，请重试。");
    assert.equal(calls, 1);
    t.mock.timers.tick(3000);
    // Repeating the message on screen is a no-op and does not restart the timer, as before.
    notify("未能保存，请重试。");
    assert.equal(calls, 1);
    t.mock.timers.tick(2000);
    assert.equal(currentToast(), null);
    assert.equal(calls, 2);

    // A different message replaces the current one and restarts the timer.
    notify("第一条");
    t.mock.timers.tick(4000);
    notify("第二条");
    t.mock.timers.tick(4000);
    assert.equal(currentToast(), "第二条");
    t.mock.timers.tick(1000);
    assert.equal(currentToast(), null);

    // Dismissing clears at once and cancels the timer.
    notify("第三条");
    notify(null);
    assert.equal(currentToast(), null);
    const before = calls;
    t.mock.timers.tick(5000);
    assert.equal(calls, before);
  } finally {
    unsubscribe();
    notify(null);
  }
  const settled = calls;
  notify("无人订阅");
  assert.equal(calls, settled, "unsubscribed listeners are not called");
  notify(null);
});

test("shell keeps the toast region mounted and outside the vocabulary hook", () => {
  const app = source("components/vocab-app.tsx");
  const hook = source("hooks/use-vocabulary.ts");
  assert.match(app, /className="toast-region" role="status" aria-live="polite"/);
  assert.match(app, /useToastMessage\(\)/);
  assert.doesNotMatch(hook, /setToast|\[toast,/, "toast state is not React state in the data hook");
  assert.match(hook, /return useMemo\(/, "the vocabulary value is memoized");
  assert.match(hook, /byId/);
});

test("practice and shell shortcuts bind keydown once and read state through effect events", () => {
  for (const path of ["components/studio/study-session.tsx", "components/vocab-app.tsx"]) {
    const code = source(path);
    assert.match(code, /useEffectEvent\(\(event: KeyboardEvent\)/, path);
    assert.match(code, /addEventListener\("keydown", key\);\n\s*return \(\) => \w+\.removeEventListener\("keydown", key\);\n\s*\}, \[\]\);/, path);
  }
});

test("main views stay mounted behind Activity instead of remounting per tab", () => {
  const app = source("components/vocab-app.tsx");
  assert.match(app, /<Activity mode=\{active \? "visible" : "hidden"\}>/);
  assert.doesNotMatch(app, /key=\{view\}/);
  assert.match(app, /const ActivityView = lazy\(/, "the record view is not shadowing React's Activity");
});
