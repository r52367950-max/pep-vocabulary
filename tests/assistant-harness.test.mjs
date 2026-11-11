import assert from 'node:assert/strict';
import test from 'node:test';
import { HARNESS_LIMITS, runChatHarness } from '../lib/assistant/harness.ts';

const usage = { prompt: 100, completion: 20, cacheHit: 40, total: 120, estimated: false };
const final = { text: '答案是 42。', actions: [] };
const call = (id = 'step_1', name = 'calculate', args = { expression: '6 * 7' }) => ({ id, name, arguments: args });
function harness(outputs, overrides = {}) {
  const sent = [];
  let checked = 0;
  const options = {
    messages: [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Calculate 6 * 7.' }],
    evidence: [], context: { sources: { article: null, files: [], quotes: [] }, loadLexicon: async () => { throw new Error('index must stay lazy'); } },
    signal: new AbortController().signal,
    verifyContext: async () => { checked++; },
    generate: async (messages, remainingMs) => {
      sent.push({ messages: structuredClone(messages), remainingMs });
      assert.ok(outputs.length > 0, 'unexpected extra model call');
      return { completion: { content: JSON.stringify(outputs.shift()), usage, finishReason: 'stop' }, today: sent.length * usage.total };
    },
    ...overrides,
  };
  return { run: () => runChatHarness(options), sent, checks: () => checked };
}

test('direct answers use one generation and never load the lexicon', async () => {
  const h = harness([final]); const result = await h.run();
  assert.deepEqual(result.result, { ...final, provenance: { origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [], userProvidedMaterial: false } });
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.trace, { modelCalls: 1, tools: [] });
  assert.equal(h.checks(), 1);
});

test('tool outputs return to the model, usage aggregates, and trace contains no arguments or source text', async () => {
  const h = harness([{ toolCalls: [call()] }, final]);
  const result = await h.run();
  const returned = JSON.parse(h.sent[1].messages.at(-1).content);
  assert.equal(returned.toolResults[0].ok, true);
  assert.equal(returned.toolResults[0].data.value, 42);
  assert.equal(result.usage.total, 240);
  assert.equal(result.usage.cacheHit, 80);
  assert.equal(result.today, 240);
  assert.deepEqual(result.trace, { modelCalls: 2, tools: [{ name: 'calculate', ok: true, cached: false }] });
  assert.equal(h.checks(), 3);
});

test('identical read-only calls share a request-local result, and IDs remain correlated', async () => {
  const h = harness([{ toolCalls: [call('a'), call('b')] }, final]);
  const result = await h.run();
  const returned = JSON.parse(h.sent[1].messages.at(-1).content).toolResults;
  assert.deepEqual(returned.map(item => item.id), ['a', 'b']);
  assert.deepEqual(result.trace.tools.map(item => item.cached), [false, true]);
});

test('malformed, mixed, oversized or duplicate dispatch envelopes never execute a tool', async () => {
  for (const output of [
    { toolCalls: [call()], text: 'also final' }, { toolCalls: [] },
    { toolCalls: [call('a'), call('a')] },
    { toolCalls: Array.from({ length: 4 }, (_, i) => call(`c${i}`)) },
    { toolCalls: [{ ...call(), id: '<script>' }] },
    { toolCalls: [{ ...call(), arguments: [] }] },
    { toolCalls: [call('a', 'calculate', { expression: 'x'.repeat(40001) })] },
  ]) {
    const h = harness([output]);
    await assert.rejects(h.run(), { code: 'invalid_tool_request' });
    assert.equal(h.sent.length, 1);
    assert.equal(h.checks(), 0);
  }
});

test('unavailable tools return a bounded error and do not gain execution capabilities', async () => {
  const h = harness([{ toolCalls: [call('a', 'shell', { command: 'rm -rf /' })] }, final]);
  const result = await h.run();
  assert.equal(result.trace.tools[0].ok, false);
  const error = JSON.parse(h.sent[1].messages.at(-1).content).toolResults[0];
  assert.equal(error.ok, false);
  assert.equal(error.evidence, undefined);
});

test('three-generation limit stops a repeated tool loop and forces the last model turn to answer', async () => {
  const h = harness([1, 2, 3].map(i => ({ toolCalls: [call(`c${i}`)] })));
  await assert.rejects(h.run(), { code: 'tool_limit_reached' });
  assert.equal(h.sent.length, HARNESS_LIMITS.modelCalls);
  assert.match(h.sent[2].messages.at(-1).content, /不再调用工具/);
});

test('context changes after a tool request stop all further provider calls', async () => {
  const h = harness([{ toolCalls: [call()] }, final], { verifyContext: async () => { throw new Error('privacy-changed'); } });
  await assert.rejects(h.run(), /privacy-changed/);
  assert.equal(h.sent.length, 1);
});

test('caller abort and total deadline stop work even between provider responses', async () => {
  const controller = new AbortController(); controller.abort();
  const aborted = harness([final], { signal: controller.signal });
  await assert.rejects(aborted.run(), { code: 'request_aborted' });
  assert.equal(aborted.sent.length, 0);
  let time = 0;
  const timed = harness([final], { now: () => time,
    generate: async () => { time = HARNESS_LIMITS.totalMs; return { completion: { content: JSON.stringify(final), usage, finishReason: 'stop' }, today: 120 }; },
  });
  await assert.rejects(timed.run(), { code: 'upstream_timeout' });
});

test('caller abort interrupts a pending source load without waiting for its promise', async () => {
  const controller = new AbortController();
  const h = harness([{ toolCalls: [call('a', 'search_lexicon', { query: 'abandon' })] }], {
    signal: controller.signal,
    context: { sources: { article: null, files: [], quotes: [] }, loadLexicon: async () => {
      queueMicrotask(() => controller.abort()); return new Promise(() => {});
    } },
  });
  await assert.rejects(h.run(), { code: 'request_aborted' });
  assert.equal(h.sent.length, 1);
});

test('the run deadline also bounds a stalled context read', async () => {
  let time = 0;
  let generated = 0;
  const h = harness([], { now: () => time,
    generate: async () => { generated++; time = HARNESS_LIMITS.totalMs - 10;
      return { completion: { content: JSON.stringify({ toolCalls: [call()] }), usage, finishReason: 'stop' }, today: 120 };
    },
    verifyContext: () => new Promise(() => {}),
  });
  await assert.rejects(h.run(), { code: 'upstream_timeout' });
  assert.equal(generated, 1);
});

test('the next round receives only the remaining wall time and truncated output is never dispatched', async () => {
  let time = 0;
  const h = harness([{ toolCalls: [call()] }, final], { now: () => time++ * 100 });
  await h.run();
  assert.ok(h.sent[1].remainingMs < h.sent[0].remainingMs);
  const truncated = harness([], { generate: async () => ({ completion: { content: JSON.stringify({ toolCalls: [call()] }), usage, finishReason: 'length' }, today: 120 }) });
  await assert.rejects(truncated.run(), { code: 'output_truncated' });
  assert.equal(truncated.checks(), 0);
});
