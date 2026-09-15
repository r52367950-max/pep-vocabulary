import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

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
  assert.doesNotMatch(layout, /@fontsource|fonts\.css/);
});
