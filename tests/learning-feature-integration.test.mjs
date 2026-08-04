import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { recallSearchCandidates } from "../lib/assistant/local-search.ts";
import { AssistantUpstreamError, readChatCompletionDetailed } from "../lib/assistant/core.ts";

const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(join(root, path), "utf8");
const row = (id, headword, chineseCore, highValue = false) => ({
  id, headword, lookup: headword, chineseCore, britishIpa: "", americanIpa: "", tier: "A",
  scopes: ["high-required"], partsOfSpeech: ["v"], sources: [],
  flags: { highValue, properName: false, formalReleaseEligible: true, highFrequencyContinuation: false },
});

test("local recall is deterministic, typo tolerant and bounded before AI reranking", () => {
  const entries = [
    row("pep-1111111111111111", "abandon", "放弃；抛弃", true),
    row("pep-2222222222222222", "persist", "坚持；持续"),
    row("pep-3333333333333333", "fault", "过错；缺点"),
  ];
  assert.equal(recallSearchCandidates(entries, "abndon")[0].headword, "abandon");
  assert.equal(recallSearchCandidates(entries, "表示坚持的词")[0].headword, "persist");
  assert.deepEqual(recallSearchCandidates(entries, "放弃", { limit: 1 }).map((entry) => entry.headword), ["abandon"]);
  assert.equal(recallSearchCandidates(entries, "a", { limit: 99 }).length <= 12, true);
});

test("provider usage is reduced to safe numbers and truncated output fails closed", async () => {
  const detailed = await readChatCompletionDetailed(new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
    usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, secret: "never-return" },
  }), { status: 200 }));
  assert.equal(detailed.usage.promptCacheHitTokens, 80);
  assert.equal("secret" in detailed.usage, false);
  await assert.rejects(
    readChatCompletionDetailed(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }), { status: 200 })),
    (error) => error instanceof AssistantUpstreamError && error.code === "output_budget_exceeded",
  );
});

test("learning routes, server cache policy and browser secret boundary are wired", () => {
  for (const task of ["search", "analyze-learning", "plan-study", "memorize"]) {
    assert.match(source(`app/api/assistant/${task}/route.ts`), new RegExp(`handleLearningAssistantRequest\\(request, ["']${task}["']\\)`));
  }
  const server = source("lib/assistant/server.ts");
  const client = source("lib/assistant/client.ts");
  assert.match(server, /learningResponseCacheKey/);
  assert.match(server, /LEARNING_RESPONSE_CACHE_POLICY/);
  assert.match(server, /cache:\s*"hit"/);
  assert.doesNotMatch(client, /apiKey|authorization|localStorage|indexedDB/i);
  assert.match(client, /credentials:\s*"same-origin"/);
});

test("new words use acquisition before FSRS and low-frequency views are lazy chunks", () => {
  const app = source("components/vocab-app.tsx");
  const storage = source("lib/storage.ts");
  assert.match(app, /startAcquisitionSession/);
  assert.match(app, /getFsrsPromotionCandidates/);
  assert.match(app, /questionType:\s*"acquisition-delayed-recall"/);
  assert.match(app, /延迟再测/);
  assert.match(app, /eligibleNew\.slice\(0, Math\.min\(6, todayNew\)\)/);
  assert.match(app, /先背 \$\{Math\.min\(6, todayNew\)\} 个新词/);
  assert.doesNotMatch(app, /Math\.max\(4, Math\.min\(6, todayNew/);
  assert.match(app, /normalizedAcquisitionText\(item\.headword\).*normalizedAcquisitionText\(entry\.headword\)/s);
  assert.match(app, /normalizedAcquisitionText\(item\.meaning\).*normalizedAcquisitionText\(entry\.chineseCore\)/s);
  assert.match(app, /lazy\(\(\) => import\("@\/components\/console-lexicon"\)\)/);
  assert.match(app, /lazy\(\(\) => import\("@\/components\/console-memorize-session"\)\)/);
  assert.match(storage, /let databasePromise/);
  assert.match(storage, /putRecords/);
});
