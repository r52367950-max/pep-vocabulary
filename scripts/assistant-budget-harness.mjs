#!/usr/bin/env -S node --experimental-strip-types

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  ASSISTANT_STABLE_SYSTEM_PREFIX,
  ASSISTANT_TASKS,
  ASSISTANT_TOKEN_BUDGETS,
  buildAssistantPrompt,
  parseAssistantRequest,
  resolveLexiconEvidence,
  upstreamPayload,
} from "../lib/assistant/core.ts";
import {
  LEARNING_ASSISTANT_TASKS,
  LEARNING_MAX_OUTPUT_TOKENS,
  LEARNING_RESPONSE_CACHE_POLICY,
  LEARNING_SYSTEM_PREFIX,
  buildLearningPrompt,
  learningResponseCacheKey,
  learningUpstreamPayload,
  parseLearningRequest,
} from "../lib/assistant/learning-core.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const encoder = new TextEncoder();

export const ASSISTANT_BUDGET_CONTRACT = Object.freeze({
  maxStaticPrefixBytes: 4_096,
  maxUserMessageBytes: 20_000,
  maxUpstreamRequestBytes: 24_000,
  maxLegacyOutputTokens: 960,
  maxLearningOutputTokens: 640,
});

const FORBIDDEN_REQUEST_KEYS = new Set([
  "apikey",
  "authorization",
  "bearertoken",
  "credential",
  "encryptedapikey",
  "keyiv",
  "password",
  "refreshtoken",
  "secret",
  "token",
]);
const SECRET_SENTINEL = "sk-harness-must-never-reach-upstream-8f4d7c2a";
const VOLATILE_PREFIX_PATTERNS = [
  ["ISO timestamp", /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ["epoch milliseconds", /\b1[6-9]\d{11}\b/],
  ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ["runtime randomness", /\b(?:Date\.now|Math\.random|randomUUID)\b/],
];

const evidenceRows = Array.from({ length: 12 }, (_, index) => {
  const ordinal = index + 1;
  return {
    id: `pep-${ordinal.toString(16).padStart(16, "0")}`,
    headword: ["abandon", "fault", "contrast", "context", "retain", "recall"][index % 6] + ordinal,
    chineseCore: `受控词库核心义 ${ordinal}；仅用于预算和缓存稳定性测试`,
    partsOfSpeech: index % 2 ? ["n", "vt"] : ["vt"],
    scopes: ["high-required", index % 2 ? "high-selective" : "middle-core"],
    sources: [
      { bookId: "HS-R1", volume: "高中英语必修第一册", unit: `Unit ${(index % 5) + 1}`, printedPage: 10 + index },
      { bookId: "HS-S1", volume: "高中英语选择性必修第一册", unit: `Unit ${(index % 4) + 1}`, printedPage: 40 + index },
    ],
    flags: { formalReleaseEligible: true },
  };
});

function bytes(value) {
  return encoder.encode(value).byteLength;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function promptHash(prompt) {
  return sha256(`${prompt.system}\u0000${prompt.user}`);
}

function normalizedKey(value) {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function forbiddenKeys(value, path = "request", result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeys(item, `${path}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (FORBIDDEN_REQUEST_KEYS.has(normalizedKey(key))) result.push(nextPath);
    forbiddenKeys(item, nextPath, result);
  }
  return result;
}

function volatileMatches(prefix) {
  return VOLATILE_PREFIX_PATTERNS
    .filter(([, pattern]) => pattern.test(prefix))
    .map(([label]) => label);
}

function evidenceFor(wordIds) {
  return resolveLexiconEvidence(evidenceRows, wordIds);
}

function reverseEvidence(evidence) {
  return [...evidence].reverse().map((item) => ({
    ...item,
    partsOfSpeech: [...item.partsOfSpeech].reverse(),
    scopes: [...item.scopes].reverse(),
    sources: [...item.sources].reverse(),
  }));
}

function legacyFixtures() {
  const ids = evidenceRows.map((row) => row.id);
  const tags = [
    "meaning-weak",
    "listening-weak",
    "spelling-weak",
    "context-weak",
    "collocation-weak",
    "output-weak",
    "recent-error",
    "new-word",
  ];
  return {
    explain: { wordId: ids[0], focus: "general", masteryTags: tags, apiKey: SECRET_SENTINEL },
    "check-sentence": {
      wordId: ids[0],
      sentence: `${"A carefully bounded model sentence. ".repeat(18)}`.slice(0, 600),
      masteryTags: tags,
      authorization: `Bearer ${SECRET_SENTINEL}`,
    },
    "generate-practice": {
      wordIds: ids.slice(0, 8),
      skill: "context",
      difficulty: "challenge",
      count: 8,
      masteryTags: tags,
      encryptedApiKey: SECRET_SENTINEL,
    },
    "contrast-words": {
      wordIds: ids.slice(0, 4),
      masteryTags: tags,
      keyIv: SECRET_SENTINEL,
    },
  };
}

function learningFixtures() {
  const ids = evidenceRows.map((row) => row.id);
  const skillStats = ["meaning", "listening", "spelling", "context", "collocation", "output"]
    .map((skill, index) => ({ skill, attempts: 200 + index, accuracyPercent: 70 + index }));
  return {
    search: {
      query: "放弃 give up 与 abandon 的教材范围和核心义区别".padEnd(80, "词").slice(0, 80),
      wordIds: ids,
      limit: 6,
    },
    "analyze-learning": {
      wordIds: ids,
      periodDays: 90,
      reviewCount: 5_000,
      uniqueWords: 4_000,
      retentionPercent: 88.8,
      averageSeconds: 12.3,
      skillStats,
    },
    "plan-study": {
      wordIds: ids,
      days: 14,
      minutesPerDay: 180,
      newWordsPerDay: 50,
      dueByDay: Array.from({ length: 14 }, (_, index) => 30 + index),
      skillStats,
    },
    memorize: {
      wordIds: ids.slice(0, 6),
      mode: "mixed",
      difficulty: "standard",
    },
  };
}

function collectJavaScriptFiles(directory, root = directory, result = []) {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScriptFiles(absolute, root, result);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const content = readFileSync(absolute);
      result.push({
        file: relative(root, absolute),
        rawBytes: content.byteLength,
        gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      });
    }
  }
  return result;
}

export function collectArtifactReport(projectRoot = PROJECT_ROOT) {
  const distRoot = join(projectRoot, "dist");
  if (!existsSync(distRoot)) return { present: false, majorJavaScript: [], dataIndexBytes: null };
  const files = collectJavaScriptFiles(distRoot)
    .sort((left, right) => right.rawBytes - left.rawBytes)
    .slice(0, 10);
  const dataIndex = join(projectRoot, "public", "data", "v1", "index.json");
  return {
    present: true,
    majorJavaScript: files,
    dataIndexBytes: existsSync(dataIndex) ? statSync(dataIndex).size : null,
  };
}

function check(checks, name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
}

export async function runAssistantBudgetHarness({ projectRoot = PROJECT_ROOT } = {}) {
  const checks = [];
  const legacy = [];
  const learning = [];
  const leakedSecrets = [];
  const legacyInput = legacyFixtures();
  const learningInput = learningFixtures();

  for (const task of ASSISTANT_TASKS) {
    const request = parseAssistantRequest(task, legacyInput[task]);
    const evidence = evidenceFor(request.wordIds);
    const firstPrompt = buildAssistantPrompt(request, evidence);
    const secondPrompt = buildAssistantPrompt(request, evidence);
    const payload = upstreamPayload("deepseek-v4-flash", firstPrompt, task, "deepseek");
    const serialized = JSON.stringify(payload);
    const record = {
      family: "assistant",
      task,
      stablePrefixBytes: bytes(ASSISTANT_STABLE_SYSTEM_PREFIX),
      systemBytes: bytes(firstPrompt.system),
      userBytes: bytes(firstPrompt.user),
      requestBytes: bytes(serialized),
      outputTokens: payload.max_tokens,
      promptHash: promptHash(firstPrompt),
      repeatPromptHash: promptHash(secondPrompt),
      forbiddenKeys: forbiddenKeys(payload),
      volatilePrefixMatches: volatileMatches(ASSISTANT_STABLE_SYSTEM_PREFIX),
    };
    if (serialized.includes(SECRET_SENTINEL)) leakedSecrets.push(`assistant:${task}:sentinel`);
    if (record.forbiddenKeys.length) leakedSecrets.push(...record.forbiddenKeys.map((path) => `assistant:${task}:${path}`));
    legacy.push(record);
  }

  let learningRejectsSecretFields = true;
  for (const task of LEARNING_ASSISTANT_TASKS) {
    try {
      parseLearningRequest(task, { ...learningInput[task], apiKey: SECRET_SENTINEL });
      learningRejectsSecretFields = false;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "unsupported_field") learningRejectsSecretFields = false;
    }

    const request = parseLearningRequest(task, learningInput[task]);
    const evidence = evidenceFor(request.wordIds);
    const firstPrompt = buildLearningPrompt(request, evidence);
    const secondPrompt = buildLearningPrompt(request, reverseEvidence(evidence));
    const payload = learningUpstreamPayload("deepseek-v4-flash", firstPrompt, task, "deepseek");
    const serialized = JSON.stringify(payload);
    const firstCacheKey = await learningResponseCacheKey("deepseek", "deepseek-v4-flash", request, evidence);
    const secondCacheKey = await learningResponseCacheKey("deepseek", "deepseek-v4-flash", request, reverseEvidence(evidence));
    const record = {
      family: "learning",
      task,
      stablePrefixBytes: bytes(LEARNING_SYSTEM_PREFIX),
      systemBytes: bytes(firstPrompt.system),
      userBytes: bytes(firstPrompt.user),
      requestBytes: bytes(serialized),
      outputTokens: payload.max_tokens,
      promptHash: promptHash(firstPrompt),
      repeatPromptHash: promptHash(secondPrompt),
      responseCacheEnabled: LEARNING_RESPONSE_CACHE_POLICY[task].enabled,
      responseCacheStable: firstCacheKey === secondCacheKey,
      responseCacheKeyPresent: firstCacheKey !== null,
      forbiddenKeys: forbiddenKeys(payload),
      volatilePrefixMatches: volatileMatches(LEARNING_SYSTEM_PREFIX),
    };
    if (serialized.includes(SECRET_SENTINEL)) leakedSecrets.push(`learning:${task}:sentinel`);
    if (record.forbiddenKeys.length) leakedSecrets.push(...record.forbiddenKeys.map((path) => `learning:${task}:${path}`));
    learning.push(record);
  }

  const all = [...legacy, ...learning];
  check(
    checks,
    "static-prefix-byte-budget",
    all.every((item) => item.stablePrefixBytes <= ASSISTANT_BUDGET_CONTRACT.maxStaticPrefixBytes),
    `maximum=${Math.max(...all.map((item) => item.stablePrefixBytes))}`,
  );
  check(
    checks,
    "user-message-byte-budget",
    all.every((item) => item.userBytes <= ASSISTANT_BUDGET_CONTRACT.maxUserMessageBytes),
    `maximum=${Math.max(...all.map((item) => item.userBytes))}`,
  );
  check(
    checks,
    "upstream-request-byte-budget",
    all.every((item) => item.requestBytes <= ASSISTANT_BUDGET_CONTRACT.maxUpstreamRequestBytes),
    `maximum=${Math.max(...all.map((item) => item.requestBytes))}`,
  );
  check(
    checks,
    "output-token-budget",
    legacy.every((item) => item.outputTokens === ASSISTANT_TOKEN_BUDGETS[item.task] && item.outputTokens <= ASSISTANT_BUDGET_CONTRACT.maxLegacyOutputTokens) &&
      learning.every((item) => item.outputTokens === LEARNING_MAX_OUTPUT_TOKENS[item.task] && item.outputTokens <= ASSISTANT_BUDGET_CONTRACT.maxLearningOutputTokens),
    `legacyMax=${Math.max(...legacy.map((item) => item.outputTokens))}; learningMax=${Math.max(...learning.map((item) => item.outputTokens))}`,
  );
  check(
    checks,
    "repeat-prompt-hash",
    all.every((item) => item.promptHash === item.repeatPromptHash),
    `${all.length} task payloads checked`,
  );
  check(
    checks,
    "stable-prefix-hygiene",
    all.every((item) => item.volatilePrefixMatches.length === 0),
    "no timestamp, UUID, epoch, or runtime-random marker",
  );
  check(
    checks,
    "server-secret-boundary",
    leakedSecrets.length === 0 && learningRejectsSecretFields,
    leakedSecrets.length ? leakedSecrets.join(", ") : "legacy extras stripped; learning extras rejected; outbound payload clean",
  );
  check(
    checks,
    "response-cache-policy",
    learning.every((item) => item.responseCacheStable && item.responseCacheKeyPresent === item.responseCacheEnabled),
    "only non-personal memorize requests produce deterministic response-cache keys",
  );

  return {
    version: 1,
    ok: checks.every((item) => item.pass),
    contract: ASSISTANT_BUDGET_CONTRACT,
    checks,
    prompts: { legacy, learning },
    security: {
      learningRejectsSecretFields,
      leakedSecrets,
    },
    artifacts: collectArtifactReport(projectRoot),
    recommendations: [
      {
        area: "route-splitting",
        action: "已把设置、词库、复习和背诵界面改为按视图加载；继续用构建报告观察入口与动态块的 gzip 变化。",
        evidence: "vocab-app.tsx 使用 React.lazy，构建已产出独立 console-* 客户端块。",
      },
      {
        area: "search-worker",
        action: "已在本地做确定性召回并只交给 AI 最多 12 条；当索引或实测输入延迟继续上升时再迁移到 Web Worker。",
        evidence: "AI 搜索不发送完整词库，当前正式索引约数千条，主线程只在用户显式点击 AI 检索时排序。",
      },
      {
        area: "indexeddb",
        action: "已复用 IndexedDB 连接并在同一事务写 card/event；事件量达到长期规模后再增加 cardId、localDate、timestampUtc 索引。",
        evidence: "storage.ts 使用 databasePromise 与 putRecords；当前分析初始化仍使用 getAll。",
      },
      {
        area: "derived-metrics",
        action: "已把 30 天事件统计改成单次映射；后续在事件达到高水位时再持久化技能与连续天数增量快照。",
        evidence: "短期数据量下全量事件仍驻留内存，但不再为每一天重复扫描一次数组。",
      },
    ],
  };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const report = await runAssistantBudgetHarness();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
