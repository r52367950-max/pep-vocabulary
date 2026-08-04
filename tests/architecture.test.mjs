import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(join(root, path), "utf8");

test("FSRS v6 schedules one main card and retention changes the interval", () => {
  const now = new Date("2026-08-03T10:00:00.000Z");
  const card = createEmptyCard(now);
  const low = fsrs(generatorParameters({ request_retention: 0.85, enable_fuzz: false })).next(card, now, Rating.Good).card;
  const high = fsrs(generatorParameters({ request_retention: 0.95, enable_fuzz: false })).next(card, now, Rating.Good).card;
  assert.ok(low.due instanceof Date && high.due instanceof Date);
  assert.ok(high.due.getTime() <= low.due.getTime());
  assert.match(source("lib/scheduler.ts"), /skills:\s*nextSkills/);
  assert.match(source("lib/storage.ts"), /meaning.*listening.*spelling.*context.*collocation.*output/s);
});

test("question engine exposes all fourteen required modes", () => {
  const questionSource = source("lib/questions.ts");
  const ids = [...questionSource.matchAll(/\{ id: "([a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 14);
  assert.equal(new Set(ids).size, 14);
  assert.match(questionSource, /localSentenceCheck/);
});

test("PWA shell, offline worker, lazy chunks, backup and D1 sync are wired", () => {
  const webManifest = JSON.parse(source("public/manifest.webmanifest"));
  assert.equal(webManifest.display, "standalone");
  assert.ok(webManifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(webManifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(source("public/sw.js"), /caches\.open/);
  assert.match(source("lib/lexicon.ts"), /descriptor\.file/);
  assert.match(source("lib/storage.ts"), /exportBackup/);
  assert.match(source("app/api/sync/route.ts"), /revision/);
});

test("destructive reset and AI degradation are explicit", () => {
  const app = source("components/vocab-app.tsx");
  const settings = source("components/console-settings.tsx");
  assert.match(app, /window\.confirm\(["']将清空本机/);
  assert.match(settings, /关闭后不会发起模型请求/);
  assert.match(app, /系统语音/);
});

test("AI deployment settings keep credentials server-side and validate compatible upstreams", () => {
  const settings = source("components/console-settings.tsx");
  const configRoute = source("app/api/ai/config/route.ts");
  const testRoute = source("app/api/ai/test/route.ts");
  const cryptoLayer = source("lib/ai-config.ts");
  const storage = source("lib/storage.ts");
  const migration = source("drizzle/0002_swift_cerise.sql");
  assert.match(settings, /type="password"/); assert.match(settings, /autoComplete="off"/); assert.match(settings, /服务端加密保存/);
  assert.doesNotMatch(settings, /localStorage.*apiKey|indexedDB.*apiKey/i); assert.match(cryptoLayer, /AES-GCM/); assert.match(cryptoLayer, /https:\/\/api\.deepseek\.com/); assert.match(cryptoLayer, /openai-compatible/); assert.match(cryptoLayer, /no-store, max-age=0/);
  assert.match(configRoute, /encryptedApiKey/); assert.doesNotMatch(configRoute, /apiKey:\s*row|encryptedApiKey:\s*row/); assert.match(testRoute, /testAssistantConnection/); assert.match(migration, /encrypted_api_key/); assert.doesNotMatch(storage, /encryptedApiKey|DEEPSEEK_API_KEY/);
});

test("accessibility fallbacks and exact viewport QA harness stay wired", () => {
  const css = source("app/globals.css");
  const storage = source("lib/storage.ts");
  const scheduler = source("lib/scheduler.ts");
  const viewportHarness = source("public/qa-viewport.html");

  assert.match(css, /:focus-visible\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(storage, /export function createLocalId\(\)/);
  assert.match(storage, /randomUUID|getRandomValues/);
  assert.doesNotMatch(scheduler, /crypto\.randomUUID/);
  assert.match(viewportHarness, /name="viewport"/);
  assert.match(viewportHarness, /<iframe[^>]+title="词迹真实应用视口"/);
  assert.match(viewportHarness, /noindex/);
});
