import test from 'node:test';
import assert from 'node:assert/strict';
import { companionVoiceContext } from '../lib/companion-voice-context.ts';

test('voice context keeps recent user, assistant, selected text and earlier voice captions', () => {
  const messages = [
    { role: 'user', text: '这句怎么理解？', quotes: [{ text: 'Small, regular efforts matter.' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: '先看句子的主干。' }, { type: 'actions', actions: [] }] },
    { role: 'voice', captions: [{ speaker: 'user', text: '请继续解释 regular。' }, { speaker: 'ai', text: '这里表示有规律的。' }] },
  ];
  const original = structuredClone(messages);
  const result = companionVoiceContext(messages);
  for (const text of ['Small, regular efforts matter.', '这句怎么理解？', '先看句子的主干。', '请继续解释 regular。', '这里表示有规律的。']) assert.ok(result.includes(text));
  assert.match(result, /用户：/);
  assert.match(result, /助手：/);
  assert.deepEqual(messages, original);
});

test('empty and action-only history creates no invented opening text', () => {
  assert.equal(companionVoiceContext([]), '');
  assert.equal(companionVoiceContext([{ role: 'assistant', blocks: [{ type: 'actions' }] }, { role: 'result' }]), '');
});

test('voice context is bounded to the API limit and prioritizes recent messages', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `message-${i} ` + '学'.repeat(300) }));
  messages.at(-1).text = '最后一个问题';
  const text = companionVoiceContext(messages);
  assert.ok(text.length <= 600);
  assert.ok(text.endsWith('用户：最后一个问题'));
  assert.ok(!text.includes('message-0'));
});

test('UTF-16 boundaries do not split emoji in any context fragment', () => {
  const cases = [
    [{ role: 'user', text: '😀' + 'a'.repeat(219) }],
    [{ role: 'user', text: '问题', quotes: [{ text: 'a'.repeat(179) + '😀引用' }] }],
    [{ role: 'assistant', blocks: [{ type: 'text', text: '😀' + 'b'.repeat(179) }] }],
    [{ role: 'voice', captions: [{ speaker: 'user', text: '😀' + 'c'.repeat(179) }] }],
    Array.from({ length: 6 }, () => ({ role: 'user', text: '😀'.repeat(300) })),
  ];
  for (const messages of cases) {
    const result = companionVoiceContext(messages);
    assert.ok(result.length <= 600);
    assert.ok(result.isWellFormed(), JSON.stringify(result));
  }
});
