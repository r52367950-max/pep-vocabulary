import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeConversations, parseStoredConversations, HISTORY_LIMITS } from '../components/studio/companion/persistence.ts';
import { checkFile, decodeText, attachmentText } from '../components/studio/companion/sources.ts';
import { parseCompanionPreferences } from '../lib/companion-preferences.ts';

const at = Date.now();
const user = { id: 'u1', role: 'user', at, text: '解释这段', quotes: [], attachments: [{ id: 'file1', name: 'private.txt', kind: 'text', status: 'read', size: 10, content: 'RAW_PRIVATE_FILE', previewUrl: 'blob:SECRET' }], via: 'text' };
const conversation = (patch = {}) => ({ id: 'c1', title: '学习', temporary: false, createdAt: at, updatedAt: at, messages: [user], ...patch });

test('normal history serializes only supported fields and omits temporary conversations, attachment raw data and drafts', () => {
  const encoded = serializeConversations([conversation({ drafts: { text: 'PRIVATE_DRAFT' } }), conversation({ id: 'temp', temporary: true, messages: [{ ...user, text: 'TEMP_SECRET' }] })]);
  for (const secret of ['RAW_PRIVATE_FILE', 'blob:SECRET', 'PRIVATE_DRAFT', 'TEMP_SECRET']) assert.equal(encoded.includes(secret), false);
  const restored = parseStoredConversations(encoded);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].messages[0].text, '解释这段');
  assert.deepEqual(restored[0].messages[0].attachments, []);
});

test('untrusted stored history is validated deeply and pending answers restore as stopped', () => {
  const value = { version: 1, conversations: [conversation({ model: 'bad', messages: [null, 'bad', { id: 'a1', at, role: 'assistant', status: 'streaming', blocks: [{ type: 'text', text: 'valid' }, { type: 'actions', actions: [{ id: 'evil', label: 'open', intent: 'javascript:alert(1)' }] }], request: { model: 'custom' } }] }), conversation({ id: 'c1' })] };
  const restored = parseStoredConversations(JSON.stringify(value));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].model, undefined);
  assert.equal(restored[0].messages[0].status, 'stopped');
  assert.equal(restored[0].messages[0].blocks[0].text, 'valid');
  assert.deepEqual(restored[0].messages[0].blocks[1].actions, []);
});

test('history size bounds retain the newest supported rows within storage cap', () => {
  const conversations = Array.from({ length: 80 }, (_, index) => conversation({ id: `c${index}`, messages: Array.from({ length: 140 }, (_, message) => ({ ...user, id: `u${message}`, text: '词'.repeat(6000) })) }));
  const encoded = serializeConversations(conversations);
  assert.ok(encoded.length <= HISTORY_LIMITS.chars);
  const restored = parseStoredConversations(encoded);
  assert.ok(restored.length <= 50);
  assert.equal(restored[0].id, 'c0');
  assert.ok(restored[0].messages.length <= 120);
});

test('real exercise result survives normal history and allows only formal word IDs', () => {
  const result = { id: 'r1', at, role: 'result', result: { title: '听写', source: '词库', mode: 'review', rounds: [[{ item: { id: 'pep-0123456789abcdef', text: 'review' }, answer: 'reveiw', score: { correct: false, explanation: '字母顺序' } }, { item: { id: 'javascript:test', text: 'bad' }, score: {} }]] } };
  const restored = parseStoredConversations(serializeConversations([conversation({ messages: [result] })]));
  assert.equal(restored[0].messages[0].result.mode, 'review');
  assert.equal(restored[0].messages[0].result.rounds[0].length, 1);
  assert.equal(restored[0].messages[0].result.rounds[0][0].score.correct, false);
});

test('attachment controls reject empty/oversize/active markup types and strictly decode UTF-8', () => {
  assert.equal(checkFile('x.svg', 'image/svg+xml', 20, 0).ok, false);
  assert.equal(checkFile('x.txt', 'text/plain', 0, 0).ok, false);
  assert.equal(checkFile('x.pdf', 'application/pdf', 13 * 1024 * 1024, 0).ok, false);
  assert.equal(checkFile('x.txt', 'text/plain', 20, 4).ok, false);
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe])).ok, false);
  assert.equal(decodeText(new TextEncoder().encode('学习 review')).text, '学习 review');
  attachmentText.set('private', 'raw');
  attachmentText.drop({ id: 'private' });
  assert.equal(attachmentText.get('private'), undefined);
});

test('settings parser rejects unsupported model and malformed options with stable defaults', () => {
  assert.deepEqual(parseCompanionPreferences('{"routePreference":"bad","sendMode":42,"includeRecords":"false"}'), { routePreference: 'auto', sendMode: 'enter', animateReplies: true, includeRecords: true, includeArticle: true });
  assert.equal(parseCompanionPreferences('{"routePreference":"gpt-6.1-sol","includeRecords":false}').includeRecords, false);
  assert.equal(parseCompanionPreferences('{"animateReplies":false}').animateReplies, false);
  assert.equal(parseCompanionPreferences('{"animateReplies":"false"}').animateReplies, true);
});

test('typed follow-up includes real voice captions and exercise evidence within endpoint history limits', async () => {
  const { requestHistory } = await import('../components/studio/companion/history.ts');
  const rows = [
    { id: 'v1', at, role: 'voice', seconds: 12, captions: [{ speaker: 'user', text: 'explain effort' }, { speaker: 'ai', text: 'Effort means the work you put in.' }] },
    { id: 'r1', at, role: 'result', result: { title: '听写', source: '词库', rounds: [[{ item: { id: 'pep-0123456789abcdef', text: 'effort' }, answer: 'efort', score: { correct: false, explanation: '拼写' } }]] } },
  ];
  const turns = requestHistory(rows, '继续解释刚才的词');
  assert.deepEqual(turns.slice(0, 2), [{ role: 'user', text: 'explain effort' }, { role: 'assistant', text: 'Effort means the work you put in.' }]);
  assert.match(turns[2].text, /effort｜作答：efort｜待复习/);
  assert.equal(turns.at(-1).text, '继续解释刚才的词');
  const bounded = requestHistory(Array.from({ length: 120 }, () => ({ ...rows[0], captions: Array.from({ length: 100 }, () => ({ speaker: 'user', text: 'a'.repeat(6000) })) })), 'next');
  assert.ok(bounded.length <= 24);
  assert.ok(bounded.every((turn) => turn.text.length <= 6000));
  assert.ok(bounded.reduce((n, turn) => n + turn.text.length, 0) <= 20000);
});
