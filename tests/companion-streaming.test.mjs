import assert from 'node:assert/strict';
import test from 'node:test';
import { revealReply } from '../components/studio/companion/reveal.ts';
import { requestCompanion } from '../components/studio/companion/chat-client.ts';
import { invalidateLearningContext } from '../lib/learning-context-client.ts';
import { parseStoredConversations, serializeConversations } from '../components/studio/companion/persistence.ts';

const memory = { accountScope: 'scope', revision: 1, enabled: false, notes: [], recentTopics: [], contextVersion: 'v1' };
const request = { messages: [{ role: 'user', text: '解释这个句子' }], model: 'auto', includeRecords: false, temporary: false };
const payload = patch => ({ ok: true, result: { text: '你好 👩🏽‍💻，这是解释。', actions: [] }, model: 'gpt-6.1-sol', effort: 'medium', ...memory, contextRevision: 1, ...patch });
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
function mockChat(t, response) {
  invalidateLearningContext();
  t.after(invalidateLearningContext);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('/api/learning-memory')) return Response.json(memory);
    assert.equal(init.headers.Accept, 'text/event-stream');
    return response();
  });
}
function stream(text) { return new Response(text, { headers: { 'content-type': 'text/event-stream' } }); }

test('chat stream exposes bounded real phases before its validated answer and ignores keepalive comments', async t => {
  let output;
  let sawProgress;
  const progressed = new Promise(resolve => { sawProgress = resolve; });
  mockChat(t, () => new Response(new ReadableStream({ start(controller) { output = controller; controller.enqueue(encoder.encode(': keep-alive\n\n' + frame('status', { phase: 'thinking', rawReasoning: 'PRIVATE' }))); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const phases = [];
  let finished = false;
  const pending = requestCompanion(request, new AbortController().signal, 'scope', value => { phases.push(value); sawProgress(); }).then(value => { finished = true; return value; });
  await progressed;
  assert.equal(finished, false);
  assert.deepEqual(phases, [{ phase: 'thinking' }]);
  const bytes = encoder.encode(frame('status', { phase: 'tool' }) + frame('status', { phase: 'verifying' }) + frame('result', payload({ reasoningSummary: '核对了句子中的主谓关系。', reasoning_content: 'PRIVATE' })));
  for (let i = 0; i < bytes.length; i += 7) output.enqueue(bytes.slice(i, i + 7));
  output.close();
  const result = await pending;
  assert.equal(result.result.text, '你好 👩🏽‍💻，这是解释。');
  assert.equal(result.reasoningSummary, '核对了句子中的主谓关系。');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.deepEqual(phases.map(value => value.phase), ['thinking', 'tool', 'verifying']);
});

test('terminal stream errors retain their API error code and never expose an answer', async t => {
  mockChat(t, () => stream(frame('status', { phase: 'thinking' }) + frame('error', { error: { message: '来源未通过校验', code: 'evidence_violation' } })));
  await assert.rejects(requestCompanion(request, new AbortController().signal, 'scope'), error => error.code === 'evidence_violation');
});

test('partial, oversized and unsupported text streams fail without returning incomplete model prose', async t => {
  const inputs = [
    frame('status', { phase: 'thinking' }),
    frame('delta', { text: 'unvalidated answer' }),
    frame('status', { phase: 'invented-private-thought' }),
    ':'.repeat(256001),
    frame('result', payload({ reasoningSummary: 'x'.repeat(6001) })),
    Array.from({ length: 65 }, () => frame('status', { phase: 'thinking' })).join(''),
  ];
  let index = 0;
  mockChat(t, () => stream(inputs[index++]));
  for (let sample = 0; sample < inputs.length; sample++) await assert.rejects(requestCompanion(request, new AbortController().signal, 'scope'));
});

test('stop cancels a stalled response reader and rejects before any late result', async t => {
  let cancelled = false;
  mockChat(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frame('status', { phase: 'thinking' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  const controller = new AbortController();
  await assert.rejects(requestCompanion(request, controller.signal, 'scope', () => controller.abort()), error => error.code === 'aborted');
  assert.equal(cancelled, true);
});

test('a context invalidation during progress aborts the reader and excludes its late answer', async t => {
  let cancelled = false;
  mockChat(t, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frame('status', { phase: 'thinking' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(requestCompanion(request, new AbortController().signal, 'scope', invalidateLearningContext), error => error.code === 'aborted');
  assert.equal(cancelled, true);
});

test('progressive reveal preserves every grapheme and caps long-answer animation at five seconds', async () => {
  const value = '中👩🏽‍💻e\u0301🇨🇳\n'.repeat(1500);
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.index + part.segment.length));
  let now = 0, previous = '', updates = 0;
  await revealReply(value, { signal: new AbortController().signal, animated: true, current: () => true,
    now: () => now, wait: async ms => { now += ms; }, update: text => {
      assert.ok(text.startsWith(previous)); assert.ok(boundaries.has(text.length)); previous = text; updates++;
    } });
  assert.equal(previous, value); assert.ok(now <= 5000); assert.ok(updates <= 251); assert.ok(updates > 2);
});

test('stop and generation invalidation preserve the last visible prefix with no further callbacks', async () => {
  for (const mode of ['abort', 'generation']) {
    const controller = new AbortController(); let current = true, now = 0; const updates = [];
    await assert.rejects(revealReply('逐字输出的一段完整内容', { signal: controller.signal, animated: true, current: () => current,
      now: () => now, wait: async ms => { now += ms; if (mode === 'abort') controller.abort(); else current = false; }, update: text => updates.push(text),
    }), error => error.name === 'AbortError');
    assert.deepEqual(updates, ['逐']);
  }
});

test('disabled/reduced motion is instant and an already cancelled reply never starts', async () => {
  const values = [];
  await revealReply('静态完整回答', { signal: new AbortController().signal, animated: false, current: () => true, update: text => values.push(text), wait: async () => { throw new Error('No animation timer expected'); } });
  assert.deepEqual(values, ['静态完整回答']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(revealReply('不可显示', { signal: controller.signal, animated: false, current: () => true, update: () => assert.fail('Cancelled reply became visible') }));
});

test('stored progressive replies retain only their visible prefix, bounded public summary and no transient phase', () => {
  const at = 1800000000000;
  const reply = { id: 'a', role: 'assistant', at, status: 'streaming', blocks: [{ type: 'text', text: '已显示的部分' }], request: { model: 'gpt-6.1-sol' }, progress: { phase: 'thinking', secret: 'PRIVATE' }, reasoningSummary: '公开的推理摘要', hiddenAnswer: 'PRIVATE_FULL_ANSWER' };
  const conversation = { id: 'c', title: '测试', temporary: false, createdAt: at, updatedAt: at, messages: [reply] };
  const serialized = serializeConversations([conversation]);
  assert.doesNotMatch(serialized, /PRIVATE|progress/);
  const restored = parseStoredConversations(serialized)[0].messages[0];
  assert.equal(restored.status, 'stopped'); assert.equal(restored.blocks[0].text, '已显示的部分'); assert.equal(restored.reasoningSummary, '公开的推理摘要');
  reply.blocks[0].text = '长'.repeat(30000); reply.status = 'done'; reply.reasoningSummary = 'x'.repeat(6001);
  const long = parseStoredConversations(serializeConversations([conversation]))[0].messages[0];
  assert.equal(long.blocks[0].text.length, 30000); assert.equal(long.reasoningSummary, undefined);
});
