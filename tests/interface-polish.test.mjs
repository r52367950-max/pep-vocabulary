import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a learner without answers gets one invitation to study instead of empty charts", () => {
  const activity = source("components/studio/activity.tsx");
  const app = source("components/vocab-app.tsx");
  const styles = source("app/interface.css");
  assert.match(activity, /const empty = !data\.history\.active\.length && !data\.cards\.size;/);
  assert.match(activity, /\{empty \? <FirstRecord onStart=\{onStart\} \/> : <ActivityRecord \{\.\.\.props\} \/>\}/);
  assert.match(activity, /<button type="button" className="primary" onClick=\{onStart\}>[\s\S]*开始今天的学习/);
  // The action continues an unfinished round first, exactly as the Today feature does.
  assert.match(app, /const startToday = useCallback\(\(\) => \{\s*if \(resumeSession\) resumeSession\(\);\s*else startSession\("daily"\);/);
  assert.match(app, /<ActivityView [^>]*onStart=\{startToday\}/);
  assert.match(styles, /\.activity-empty \{[^}]*background: var\(--grouped\)/);
  assert.match(styles, /\.activity-empty p \{[^}]*color: var\(--muted-strong\)/);
});

test("Today keeps its estimate legible over the artwork and its pickers sized to the choice", () => {
  const styles = source("app/interface.css");
  const narrow = styles.slice(styles.indexOf("@media (max-width: 760px) {"));
  assert.match(narrow, /\.feature-action > span \{[^}]*background: var\(--hero-bg, var\(--grouped\)\)/);
  assert.match(styles, /\.course-context \.course-picker select \{ field-sizing: content; \}/);
});

test("paper dictation renders its one-time recognition gate from state", () => {
  const paper = source("components/studio/voice/paper-dictation.tsx");
  const render = paper.slice(paper.indexOf("return (\n    <section"));
  assert.doesNotMatch(render, /\.current\s*&&/, "render must not branch on a ref");
  assert.match(render, /\{!sent && <button type="button" className="primary" onClick=\{\(\) => void recognize\(\)\}>识别文字<\/button>\}/);
  // The ref still closes the gate synchronously; only choosing a new photo reopens it.
  assert.match(paper, /if \(!photo \|\| locked\.current \|\| phase !== "ready" \|\| !eligible\.length\) return;\s*locked\.current = true;\s*setSent\(true\);/);
  assert.match(paper, /locked\.current = false;\s*setSent\(false\);/);
});

test("dictation applies a prepared plan without an effect and requests at most one per context", () => {
  const panel = source("components/studio/voice/dictation-panel.tsx");
  assert.doesNotMatch(panel, /useEffect\(\(\) => \{\s*if \(preparedPlan/);
  assert.match(panel, /if \(!appliedPlan \|\| appliedPlan\.plan !== incomingPlan \|\| appliedPlan\.key !== planKey\) \{/);
  // Busy state is read through an effect event, so finishing a request never triggers another.
  assert.match(panel, /const prepareOnEntry = useEffectEvent\(/);
  assert.match(panel, /useEffect\(\(\) => \{ prepareOnEntry\(\); \}, \[active, accountScope, contextEpoch, queue\.length, conversationContext\]\);/);
});

test("a replacement started on this page reports its own result instead of the generic notice", () => {
  const app = source("components/vocab-app.tsx");
  // onReplaced runs before the reload that changes the data generation.
  assert.match(app, /const onReplaced = \(\) => \{\s*replacingHere\.current = true;/);
  assert.match(app, /if \(replacingHere\.current\) replacingHere\.current = false;\s*else notify\("本机学习数据已替换/);
  const tools = source("components/studio/data-tools.tsx");
  assert.match(tools, /await replaced\(\);\s*data\.notify\(mergeMessage\(summary\)\);/);
});
