import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSISTANT_BUDGET_CONTRACT,
  collectArtifactReport,
  runAssistantBudgetHarness,
} from "../scripts/assistant-budget-harness.mjs";

test("assistant prompt, request and output budgets stay bounded", async () => {
  const report = await runAssistantBudgetHarness();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((item) => !item.pass)));
  assert.equal(report.prompts.legacy.length, 4);
  assert.equal(report.prompts.learning.length, 4);

  for (const item of [...report.prompts.legacy, ...report.prompts.learning]) {
    assert.ok(item.stablePrefixBytes <= ASSISTANT_BUDGET_CONTRACT.maxStaticPrefixBytes);
    assert.ok(item.userBytes <= ASSISTANT_BUDGET_CONTRACT.maxUserMessageBytes);
    assert.ok(item.requestBytes <= ASSISTANT_BUDGET_CONTRACT.maxUpstreamRequestBytes);
    assert.match(item.promptHash, /^[a-f0-9]{64}$/);
  }
});

test("repeated runs keep prompt and response-cache hashes stable", async () => {
  const first = await runAssistantBudgetHarness();
  const second = await runAssistantBudgetHarness();
  const compact = (report) => [...report.prompts.legacy, ...report.prompts.learning].map((item) => ({
    family: item.family,
    task: item.task,
    promptHash: item.promptHash,
    repeatPromptHash: item.repeatPromptHash,
    responseCacheStable: item.responseCacheStable,
    responseCacheKeyPresent: item.responseCacheKeyPresent,
  }));
  assert.deepEqual(compact(first), compact(second));
  assert.ok(compact(first).every((item) => item.promptHash === item.repeatPromptHash));
});

test("cache prefixes contain no volatile values and outbound payloads contain no secret fields", async () => {
  const report = await runAssistantBudgetHarness();
  assert.equal(report.security.learningRejectsSecretFields, true);
  assert.deepEqual(report.security.leakedSecrets, []);
  for (const item of [...report.prompts.legacy, ...report.prompts.learning]) {
    assert.deepEqual(item.volatilePrefixMatches, []);
    assert.deepEqual(item.forbiddenKeys, []);
  }
});

test("artifact report discovers and sorts current JavaScript without fixed filenames or sizes", () => {
  const artifacts = collectArtifactReport();
  assert.equal(typeof artifacts.present, "boolean");
  if (!artifacts.present) {
    assert.deepEqual(artifacts.majorJavaScript, []);
    return;
  }
  assert.ok(artifacts.majorJavaScript.length > 0);
  assert.ok(artifacts.majorJavaScript.every((item) => item.file && item.rawBytes > 0 && item.gzipBytes > 0));
  for (let index = 1; index < artifacts.majorJavaScript.length; index += 1) {
    assert.ok(artifacts.majorJavaScript[index - 1].rawBytes >= artifacts.majorJavaScript[index].rawBytes);
  }
});

test("service worker canonicalizes static data cache keys instead of duplicating query variants", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.match(sw, /canonicalSameOriginGet/);
  assert.match(sw, /new URL\(url\.pathname,\s*self\.location\.origin\)/);
  assert.match(sw, /cache\.match\(cacheKey\)/);
  assert.match(sw, /cache\.put\(cacheKey,\s*response\.clone\(\)\)/);
  assert.doesNotMatch(sw, /cache\.put\(event\.request,\s*response\.clone\(\)\).*data\/v1/s);
});
