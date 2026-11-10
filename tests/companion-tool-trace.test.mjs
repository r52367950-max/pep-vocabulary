import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatToolSteps, chatToolSummary } from '../lib/assistant/tool-trace.ts';
import { parseStoredConversations, serializeConversations } from '../components/studio/companion/persistence.ts';
import { requestCompanion } from '../components/studio/companion/chat-client.ts';
import { invalidateLearningContext } from '../lib/learning-context-client.ts';

const successful = { name: 'lookup_words', ok: true, cached: false };
const at = 1_800_000_000_000;
const answer = patch => ({ id: 'a', role: 'assistant', at, status: 'done', blocks: [{ type: 'text', text: '回答' }], request: { model: 'gpt-6.1-sol' }, ...patch });
const conversation = messages => ({ id: 'c', title: '查词', temporary: false, createdAt: at, updatedAt: at, messages });

test('tool trace retains only known names and exact booleans within the dispatch cap', () => {
  assert.deepEqual(parseChatToolSteps([
    { ...successful, arguments: { text: 'PRIVATE_SOURCE' }, label: '<script>untrusted</script>' },
    { name: 'execute_python', ok: true, cached: false },
    { name: '__proto__', ok: true, cached: false },
    { name: 'calculate', ok: 'true', cached: false },
    { name: 'calculate', ok: true },
    null,
    { name: 'calculate', ok: true, cached: false },
  ]), [successful]);
  for (const value of [null, {}, 'lookup_words', true]) assert.deepEqual(parseChatToolSteps(value), []);
  assert.equal(parseChatToolSteps(Array.from({ length: 100 }, () => successful)).length, 6);
});

test('fixed summaries distinguish failed tools and omit invented activity for direct answers', () => {
  const steps = parseChatToolSteps([
    successful,
    { name: 'search_lexicon', ok: true, cached: true },
    { name: 'calculate', ok: false, cached: false },
    { name: 'read_source', ok: true, cached: false },
  ]);
  assert.equal(chatToolSummary(steps), '已查词库 · 计算未完成 · 已读取资料');
  assert.equal(chatToolSummary([]), '');
});

test('history roundtrip keeps actual tool status without retaining private source or arbitrary labels', () => {
  const encoded = serializeConversations([conversation([answer({ toolSteps: [
    { ...successful, arguments: { query: 'PRIVATE_QUERY' }, result: 'PRIVATE_RESULT', label: 'INVENTED_LABEL' },
    { name: 'calculate', ok: false, cached: false },
    { name: 'open_url', ok: true, cached: false },
  ] })])]);
  for (const secret of ['PRIVATE_QUERY', 'PRIVATE_RESULT', 'INVENTED_LABEL', 'open_url']) assert.ok(!encoded.includes(secret));
  const restored = parseStoredConversations(encoded)[0].messages[0];
  assert.deepEqual(restored.toolSteps, [successful, { name: 'calculate', ok: false, cached: false }]);
  assert.deepEqual(parseStoredConversations(serializeConversations([conversation([answer({})])]))[0].messages[0].toolSteps, []);
  assert.deepEqual(parseStoredConversations(serializeConversations([{ ...conversation([answer({ toolSteps: [successful] })]), temporary: true }])), []);
});

test('actual chat client projects only returned trace after identity and context checks', async t => {
  invalidateLearningContext();
  const memory = { accountScope: 'scope', revision: 1, enabled: false, notes: [], recentTopics: [], contextVersion: 'v1' };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).startsWith('/api/learning-memory')) return Response.json(memory);
    assert.equal(url, '/api/assistant/chat');
    return Response.json({ ok: true, result: { text: '结果', actions: [] }, model: 'gpt-6.1-sol', effort: 'medium',
      ...memory, contextRevision: 1, harness: { modelCalls: 2, tools: [{ ...successful, arguments: 'PRIVATE' }, { name: 'send_email', ok: true, cached: false }] } });
  });
  const result = await requestCompanion({ messages: [{ role: 'user', text: '查词' }], model: 'auto', includeRecords: false, temporary: false }, new AbortController().signal, 'scope');
  assert.deepEqual(result.toolSteps, [successful]);
  assert.equal(requests.filter(url => url === '/api/assistant/chat').length, 1);
  assert.equal(requests.filter(url => url.startsWith('/api/learning-memory')).length, 2);
  invalidateLearningContext();
});

test('a context change before final client validation discards the answer and its tool trace', async t => {
  invalidateLearningContext();
  let reads = 0;
  const memory = { accountScope: 'scope', revision: 1, enabled: false, notes: [], recentTopics: [], contextVersion: 'v1' };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('/api/learning-memory')) return Response.json({ ...memory, revision: ++reads === 1 ? 1 : 2 });
    return Response.json({ ok: true, result: { text: '结果', actions: [] }, ...memory, contextRevision: 1,
      harness: { tools: [successful] } });
  });
  await assert.rejects(requestCompanion({ messages: [{ role: 'user', text: '查词' }], model: 'auto', includeRecords: false, temporary: false }, new AbortController().signal, 'scope'), error => error.name === 'AbortError' || error.code === 'aborted');
  invalidateLearningContext();
});
