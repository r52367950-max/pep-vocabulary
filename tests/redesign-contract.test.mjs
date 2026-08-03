import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Vocab Redesign console shell is wired to live application state", async () => {
  const [app, styles, study, lexicon, settings] = await Promise.all([
    read("components/vocab-app.tsx"),
    read("app/console.css"),
    read("components/console-study-session.tsx"),
    read("components/console-lexicon.tsx"),
    read("components/console-settings.tsx"),
  ]);
  assert.match(app, /className="console-app"/);
  assert.match(app, /dailyQueuePreview/);
  assert.match(app, /<ConsoleStudySession/);
  assert.match(app, /<ConsoleLexicon/);
  assert.match(styles, /grid-template-columns:208px minmax\(0,1fr\)/);
  assert.match(styles, /console-mobile-nav/);
  assert.match(study, /previewReviewIntervals/);
  assert.match(study, /左滑忘记 · 右滑记得 · 上滑轻松/);
  assert.match(lexicon, /visibleDetails/);
  assert.match(lexicon, /FSRS 主状态/);
  assert.match(app, /<ConsoleSettings/); assert.match(settings, /AI 接口/); assert.match(styles, /settings-layout/);
});

test("review event schema preserves learning evidence and supports 1.0 migration", async () => {
  const [storage, scheduler, api, layout] = await Promise.all([
    read("lib/storage.ts"),
    read("lib/scheduler.ts"),
    read("app/api/sync/route.ts"),
    read("app/layout.tsx"),
  ]);
  assert.match(storage, /USER_DATA_SCHEMA_VERSION = "1\.1\.0"/);
  assert.match(storage, /payload\.schemaVersion !== "1\.0\.0"/);
  assert.match(storage, /answerGiven\?: string \| null/);
  assert.match(scheduler, /intervalAfterDays/);
  assert.match(scheduler, /forecastDueLoad/);
  assert.match(api, /USER_DATA_SCHEMA_VERSION/);
  assert.match(api, /5 MB private-sync limit/);
  assert.match(layout, /@fontsource\/barlow/);
});
