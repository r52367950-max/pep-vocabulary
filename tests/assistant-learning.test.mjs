import assert from "node:assert/strict";
import test from "node:test";
import {
  LEARNING_ASSISTANT_TASKS,
  LEARNING_MAX_OUTPUT_TOKENS,
  LEARNING_RESPONSE_CACHE_POLICY,
  LEARNING_SYSTEM_PREFIX,
  buildLearningPrompt,
  canonicalLearningJson,
  learningResponseCacheKey,
  learningUpstreamPayload,
  parseLearningRequest,
  sanitizeLearningResult,
} from "../lib/assistant/learning-core.ts";
import { AssistantInputError, AssistantUpstreamError } from "../lib/assistant/core.ts";

const wordA = "pep-1e3e7e41accdc5f7";
const wordB = "pep-07d418db40de3fe8";
const evidence = [
  {
    id: wordA,
    headword: "abandon",
    chineseCore: "舍弃；抛弃；放弃",
    partsOfSpeech: ["vt"],
    scopes: ["high-selective"],
    sources: [{ bookId: "HS-S3", volume: "选择性必修第三册", unit: "Unit 4", printedPage: 109 }],
  },
  {
    id: wordB,
    headword: "fault",
    chineseCore: "弱点；过错",
    partsOfSpeech: ["n"],
    scopes: ["middle-core", "high-selective"],
    sources: [{ bookId: "HS-S2", volume: "选择性必修第二册", unit: "Unit 1", printedPage: 5 }],
  },
];

const stats = [
  { skill: "spelling", attempts: 9, accuracyPercent: 55.55 },
  { skill: "meaning", attempts: 12, accuracyPercent: 83.34 },
];

test("four learning requests are bounded, canonical and reject identity-bearing fields", () => {
  const search = parseLearningRequest("search", { query: "  放弃   give up  ", wordIds: [wordA, wordB] });
  assert.deepEqual(search, { task: "search", query: "放弃 give up", wordIds: [wordA, wordB], limit: 5 });
  assert.throws(
    () => parseLearningRequest("search", { query: "me@example.com", wordIds: [wordA] }),
    (error) => error instanceof AssistantInputError && error.code === "personal_data_not_allowed",
  );
  assert.throws(
    () => parseLearningRequest("search", { query: "abandon", wordIds: [wordA], apiKey: "secret" }),
    (error) => error instanceof AssistantInputError && error.code === "unsupported_field",
  );

  const analysis = parseLearningRequest("analyze-learning", {
    wordIds: [wordA, wordB],
    periodDays: 14,
    reviewCount: 30,
    uniqueWords: 18,
    retentionPercent: 82.25,
    averageSeconds: 7.54,
    skillStats: stats,
  });
  assert.deepEqual(analysis.skillStats.map((item) => item.skill), ["meaning", "spelling"]);
  assert.equal(analysis.retentionPercent, 82.3);
  assert.equal(analysis.averageSeconds, 7.5);
  assert.throws(() => parseLearningRequest("analyze-learning", {
    wordIds: [wordA], periodDays: 7, reviewCount: 1, uniqueWords: 1, retentionPercent: 90,
    averageSeconds: 5, skillStats: [], userName: "Luna",
  }), /不受支持的字段/);

  assert.deepEqual(parseLearningRequest("plan-study", {
    wordIds: [wordA], days: 3, minutesPerDay: 20, newWordsPerDay: 5, dueByDay: [3, 5, 2], skillStats: [],
  }).dueByDay, [3, 5, 2]);
  assert.throws(() => parseLearningRequest("plan-study", {
    wordIds: [wordA], days: 3, minutesPerDay: 20, newWordsPerDay: 5, dueByDay: [3, 5], skillStats: [],
  }), /计划天数等长/);

  assert.deepEqual(parseLearningRequest("memorize", { wordIds: [wordA] }), {
    task: "memorize", wordIds: [wordA], mode: "mixed", difficulty: "standard",
  });
  assert.throws(() => parseLearningRequest("memorize", { wordIds: [wordA, wordA] }), /不重复/);
});

test("system prefix is identical for every task and user JSON is deterministic", () => {
  const requests = [
    parseLearningRequest("search", { query: "abandon", wordIds: [wordA] }),
    parseLearningRequest("analyze-learning", {
      wordIds: [wordA], periodDays: 7, reviewCount: 10, uniqueWords: 5, retentionPercent: 80,
      averageSeconds: 7, skillStats: [],
    }),
    parseLearningRequest("plan-study", {
      wordIds: [wordA], days: 2, minutesPerDay: 20, newWordsPerDay: 4, dueByDay: [3, 2], skillStats: [],
    }),
    parseLearningRequest("memorize", { wordIds: [wordA] }),
  ];
  const systems = requests.map((request) => buildLearningPrompt(request, [evidence[0]]).system);
  assert.equal(new Set(systems).size, 1);
  assert.equal(systems[0], LEARNING_SYSTEM_PREFIX);
  assert.match(systems[0], /只返回一个紧凑 JSON 对象/);
  assert.match(systems[0], /suppliedEvidence/);
  assert.match(systems[0], /不得在自然语言中声明教材页码/);

  assert.equal(
    canonicalLearningJson({ z: 1, a: { d: 4, c: 3 } }),
    canonicalLearningJson({ a: { c: 3, d: 4 }, z: 1 }),
  );
  const first = buildLearningPrompt(requests[3], [evidence[0]]);
  const second = buildLearningPrompt(requests[3], [{ ...evidence[0], sources: [...evidence[0].sources].reverse() }]);
  assert.equal(first.user, second.user);
  assert.throws(() => buildLearningPrompt(requests[3], [evidence[1]]), /证据必须与请求词条完全一致/);
});

test("all payloads have small task budgets, JSON mode and no default DeepSeek thinking", () => {
  assert.deepEqual(LEARNING_ASSISTANT_TASKS, ["search", "analyze-learning", "plan-study", "memorize"]);
  for (const task of LEARNING_ASSISTANT_TASKS) {
    assert.ok(LEARNING_MAX_OUTPUT_TOKENS[task] <= 640);
    const payload = learningUpstreamPayload("deepseek-v4-flash", { system: "json", user: "{}" }, task, "deepseek");
    assert.equal(payload.max_tokens, LEARNING_MAX_OUTPUT_TOKENS[task]);
    assert.equal(payload.temperature, 0.1);
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.stream, false);
  }
  const compatible = learningUpstreamPayload("provider-flash", { system: "json", user: "{}" }, "search", "openai-compatible");
  assert.equal("thinking" in compatible, false);
});

test("search output is short, strict and evidence-bound", () => {
  const request = parseLearningRequest("search", { query: "abandon", wordIds: [wordA, wordB], limit: 2 });
  const result = sanitizeLearningResult(request, JSON.stringify({
    summary: "优先匹配核心义和词形。",
    hits: [
      { wordId: wordA, reason: "与查询词形完全一致。", score: "high" },
      { wordId: wordB, reason: "仅作对比候选。", score: "low" },
    ],
    evidenceIds: [wordA, wordB],
    limitations: [],
  }), evidence);
  assert.equal(result.kind, "search");
  assert.equal(result.hits.length, 2);
  assert.throws(() => sanitizeLearningResult(request, JSON.stringify({
    summary: "结果", hits: [], evidenceIds: ["pep-ffffffffffffffff"], limitations: [],
  }), evidence), (error) => error instanceof AssistantUpstreamError && error.code === "evidence_violation");
  assert.throws(() => sanitizeLearningResult(request, JSON.stringify({
    summary: "结果", hits: [], evidenceIds: [wordA], limitations: [], verboseDump: "not allowed",
  }), evidence), /额外字段/);
});

test("analysis and plan output enforce action, day and evidence limits", () => {
  const analysis = parseLearningRequest("analyze-learning", {
    wordIds: [wordA, wordB], periodDays: 14, reviewCount: 30, uniqueWords: 18,
    retentionPercent: 82, averageSeconds: 8, skillStats: stats,
  });
  const analyzed = sanitizeLearningResult(analysis, JSON.stringify({
    summary: "拼写比词义薄弱，应先做短回忆。",
    findings: [{ signal: "skill-gap", note: "拼写正确率较低。", evidenceIds: [wordA] }],
    actions: [{ action: "spell", detail: "先遮住词形回忆，再核对。", wordIds: [wordA] }],
    evidenceIds: [wordA],
    limitations: [],
  }), evidence);
  assert.equal(analyzed.actions[0].action, "spell");

  const plan = parseLearningRequest("plan-study", {
    wordIds: [wordA, wordB], days: 2, minutesPerDay: 20, newWordsPerDay: 4, dueByDay: [3, 2], skillStats: [],
  });
  const planned = sanitizeLearningResult(plan, JSON.stringify({
    summary: "两天都保留回忆练习。",
    sessions: [
      { day: 2, minutes: 15, focus: "review", wordIds: [wordB], steps: ["先回忆，再核对。"] },
      { day: 1, minutes: 20, focus: "learn", wordIds: [wordA], steps: ["先看核心义。", "遮住答案回忆。"] },
    ],
    evidenceIds: [wordA, wordB],
    limitations: [],
  }), evidence);
  assert.deepEqual(planned.sessions.map((item) => item.day), [1, 2]);
  assert.throws(() => sanitizeLearningResult(plan, JSON.stringify({
    summary: "计划", sessions: [
      { day: 1, minutes: 21, focus: "learn", wordIds: [wordA], steps: ["学习"] },
    ], evidenceIds: [wordA], limitations: [],
  }), evidence), /minutes/);
});

test("memorize output covers every requested word and marks examples as generated", () => {
  const request = parseLearningRequest("memorize", { wordIds: [wordA, wordB], mode: "mixed", difficulty: "foundation" });
  const result = sanitizeLearningResult(request, JSON.stringify({
    cards: [
      {
        wordId: wordA,
        hook: "把 a-band-on 联想到离开乐队。",
        recallPrompt: "“放弃计划”用哪个动词？",
        answer: "abandon",
        microExample: "They abandoned the plan.",
        translation: "他们放弃了计划。",
      },
      {
        wordId: wordB,
        hook: "fault 指过错或责任。",
        recallPrompt: "“这是我的错”中的名词是什么？",
        answer: "fault",
        microExample: "It was my fault.",
        translation: "这是我的错。",
      },
    ],
    evidenceIds: [wordA, wordB],
    limitations: [],
  }), evidence);
  assert.equal(result.cards[0].origin, "model-generated");
  assert.equal(result.origin, "model-generated");
  assert.throws(() => sanitizeLearningResult(request, JSON.stringify({
    cards: [{
      wordId: wordA, hook: "提示", recallPrompt: "问题", answer: "abandon",
      microExample: "教材原句是 They abandoned it.", translation: "他们放弃了它。",
    }],
    evidenceIds: [wordA, wordB], limitations: [],
  }), evidence), /数量异常|教材原句/);
  assert.throws(() => sanitizeLearningResult(request, JSON.stringify({
    cards: [
      {
        wordId: wordA,
        hook: "According to the textbook, see page 999.",
        recallPrompt: "“放弃计划”用哪个动词？",
        answer: "abandon",
        microExample: "They abandoned the plan.",
        translation: "他们放弃了计划。",
      },
      {
        wordId: wordB,
        hook: "fault 指过错或责任。",
        recallPrompt: "“这是我的错”中的名词是什么？",
        answer: "fault",
        microExample: "It was my fault.",
        translation: "这是我的错。",
      },
    ],
    evidenceIds: [wordA, wordB],
    limitations: [],
  }), evidence), (error) => error instanceof AssistantUpstreamError && error.code === "evidence_violation");
});

test("SHA-256 response cache is deterministic and only enabled for non-personal memorize requests", async () => {
  assert.equal(LEARNING_RESPONSE_CACHE_POLICY.search.enabled, false);
  assert.equal(LEARNING_RESPONSE_CACHE_POLICY["analyze-learning"].enabled, false);
  assert.equal(LEARNING_RESPONSE_CACHE_POLICY["plan-study"].enabled, false);
  assert.equal(LEARNING_RESPONSE_CACHE_POLICY.memorize.enabled, true);

  const search = parseLearningRequest("search", { query: "abandon", wordIds: [wordA] });
  assert.equal(await learningResponseCacheKey("deepseek", "deepseek-v4-flash", search, [evidence[0]]), null);

  const memorize = parseLearningRequest("memorize", { wordIds: [wordA, wordB], mode: "mixed", difficulty: "standard" });
  const first = await learningResponseCacheKey("deepseek", "deepseek-v4-flash", memorize, evidence);
  const reorderedEvidence = [
    { ...evidence[1], scopes: [...evidence[1].scopes].reverse() },
    evidence[0],
  ];
  const second = await learningResponseCacheKey("deepseek", "deepseek-v4-flash", memorize, reorderedEvidence);
  assert.equal(first, second);
  assert.match(first, /^ai-learning:v1:[a-f0-9]{64}$/);

  const changed = await learningResponseCacheKey(
    "deepseek",
    "deepseek-v4-flash",
    parseLearningRequest("memorize", { wordIds: [wordA, wordB], mode: "spelling-recall", difficulty: "standard" }),
    evidence,
  );
  assert.notEqual(first, changed);
});
