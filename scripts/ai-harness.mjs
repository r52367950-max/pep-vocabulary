// Prompt harness for the vocabulary assistant.
//
//   node --import ./tests/register.mjs scripts/ai-harness.mjs            # offline: build and inspect every prompt
//   HARNESS_API_KEY=... node --import ./tests/register.mjs scripts/ai-harness.mjs --live [--case essay-practical] [--repeat 2]
//
// Offline mode builds each case exactly as the server would (release evidence, validated profile,
// static system prompt first) and checks that every request shares the same cacheable prefix.
// Live mode sends the cases to a real OpenAI-compatible endpoint (default: DeepSeek) and records
// latency, token usage, cache hits and whether the answer passes the production validator.
// Live calls cost money. The key is read from the environment and never written anywhere.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildAssistantPrompt, chatCompletionsUrl, fetchCompletion, parseAssistantRequest, resolveLexiconEvidence,
  resolveMaxOutputTokens, sanitizeModelResult, upstreamPayload,
} from '../lib/assistant/core.ts';
import { parseLearnerProfile } from '../lib/assistant/profile.ts';
import { SYSTEM_PROMPT } from '../lib/assistant/prompt.ts';

const args = process.argv.slice(2);
const live = args.includes('--live');
const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
const repeat = args.includes('--repeat') ? Math.max(1, Number(args[args.indexOf('--repeat') + 1]) || 1) : live ? 2 : 1;
const fixtures = JSON.parse(readFileSync(new URL('./ai-harness/cases.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../public/data/v1/index.json', import.meta.url), 'utf8'));
const words = new Map(rows.filter((row) => row.flags?.formalReleaseEligible === true).map((row) => [row.id, { headword: row.headword }]));
const profile = parseLearnerProfile(fixtures.profile, words);
const provider = process.env.HARNESS_PROVIDER || 'deepseek';
const baseUrl = process.env.HARNESS_BASE_URL || 'https://api.deepseek.com/v1';
const model = process.env.HARNESS_MODEL || 'deepseek-v4-flash';
const apiKey = process.env.HARNESS_API_KEY || '';
if (live && !apiKey) { console.error('Set HARNESS_API_KEY for --live.'); process.exit(2); }

// About 3 characters per token for mixed Chinese/English JSON; only for the offline overview.
const estimate = (text) => Math.ceil(text.length / 3);
const cases = fixtures.cases.filter((item) => !only || item.name === only);
const report = { startedAt: new Date().toISOString(), live, provider, baseUrl, model, systemPromptChars: SYSTEM_PROMPT.length, cases: [] };
let sharedProfilePrefix = null;

function checkExpectations(expect = {}, result) {
  const failures = [];
  if (expect.personalNote && !result.personalNote) failures.push('personalNote missing');
  if (expect.verdict && result.verdict !== expect.verdict) failures.push(`verdict ${result.verdict} ≠ ${expect.verdict}`);
  if (expect.minIssues && (result.issues?.length || 0) < expect.minIssues) failures.push(`only ${result.issues?.length || 0} issues`);
  return failures;
}

for (const item of cases) {
  const request = parseAssistantRequest(item.task, item.input);
  const evidence = resolveLexiconEvidence(rows, request.wordIds);
  const prompt = buildAssistantPrompt(request, evidence, profile);
  const profileBlock = prompt.user.slice(0, prompt.user.indexOf('本次任务'));
  sharedProfilePrefix ??= profileBlock;
  const entry = {
    name: item.name, task: item.task,
    promptChars: { system: prompt.system.length, user: prompt.user.length },
    estimatedPromptTokens: estimate(prompt.system + prompt.user),
    sharesPrefix: prompt.system === SYSTEM_PROMPT && profileBlock === sharedProfilePrefix,
    runs: [],
  };
  for (let run = 0; live && run < repeat; run++) {
    const startedAt = Date.now();
    const outcome = { run: run + 1 };
    try {
      const completion = await fetchCompletion(fetch, chatCompletionsUrl(baseUrl, provider), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
        body: JSON.stringify(upstreamPayload(model, prompt, item.task, provider, { maxTokens: resolveMaxOutputTokens(model), stream: true, baseUrl, cacheKey: 'ciji-harness' })),
      }, { idleMs: 30_000, totalMs: 300_000, stream: true, promptChars: prompt.system.length + prompt.user.length });
      Object.assign(outcome, { latencyMs: Date.now() - startedAt, usage: completion.usage, finishReason: completion.finishReason, outputChars: completion.content.length });
      const result = sanitizeModelResult(item.task, completion.content, evidence, request.task === 'generate-practice' ? request.count : 8, request);
      outcome.valid = true;
      outcome.expectationFailures = checkExpectations(item.expect, result);
      outcome.result = result;
    } catch (error) {
      Object.assign(outcome, { latencyMs: Date.now() - startedAt, valid: false, error: error?.code || error?.name || 'error', message: error?.message });
    }
    entry.runs.push(outcome);
  }
  report.cases.push(entry);
}

const rowsOut = report.cases.map((entry) => {
  const last = entry.runs.at(-1);
  return {
    case: entry.name,
    'prompt≈tok': entry.estimatedPromptTokens,
    prefix: entry.sharesPrefix ? 'shared' : 'DIFFERENT',
    ...(live ? {
      valid: entry.runs.map((run) => (run.valid ? (run.expectationFailures?.length ? 'expect✗' : 'ok') : run.error)).join(' / '),
      'ms': entry.runs.map((run) => run.latencyMs).join(' / '),
      'cache hit': entry.runs.map((run) => (run.usage ? `${run.usage.cacheHit}/${run.usage.prompt}` : '-')).join(' / '),
      out: last?.usage?.completion ?? '-',
      finish: last?.finishReason ?? '-',
    } : {}),
  };
});
console.table(rowsOut);
const failures = report.cases.filter((entry) => !entry.sharesPrefix || entry.runs.some((run) => !run.valid || run.expectationFailures?.length));
if (live) {
  mkdirSync(new URL('../artifacts/ai-harness/', import.meta.url), { recursive: true });
  const file = new URL(`../artifacts/ai-harness/report-${report.startedAt.replace(/[:.]/g, '-')}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${file.pathname}`);
}
if (failures.length) { console.error(`Failed: ${failures.map((entry) => entry.name).join(', ')}`); process.exitCode = 1; }
