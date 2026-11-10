import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationGroups, createConversationListSelector } from '../components/studio/companion/conversation-list.ts';

const timestamp = new Date(2026, 10, 10, 12).getTime();
const message = { role: 'user', text: 'Review irregular verbs', quotes: [], attachments: [] };
const conversation = (id, patch = {}) => ({ id, title: id, temporary: false, messages: [message], createdAt: timestamp, updatedAt: timestamp, ...patch });
const draft = (text = '') => ({ text, quotes: [], attachments: [], includeRecords: true, includeArticle: true });

test('list selector retains newest saved conversations and other nonempty drafts, excluding temporary and active empty conversations', () => {
  const select = createConversationListSelector();
  const conversations = [conversation('old', { updatedAt: timestamp - 86400000 }), conversation('temp', { temporary: true }), conversation('active', { messages: [] }), conversation('draft', { messages: [] }), conversation('empty', { messages: [] })];
  const rows = select(conversations, { active: draft('in progress'), draft: draft('other draft'), empty: draft() }, 'active');
  assert.deepEqual(rows.map(row => row.conversation.id), ['draft', 'old']);
  assert.equal(rows[0].title, 'other draft');
  assert.equal(rows[0].draftOnly, true);
  assert.equal(rows[1].draftOnly, false);
});

test('142 active-composer keystrokes reuse the list and leave saved content untouched', () => {
  const select = createConversationListSelector();
  const conversations = Array.from({ length: 50 }, (_, index) => conversation(`c${index}`));
  const drafts = { c0: draft() };
  const initial = select(conversations, drafts, 'c0');
  for (let count = 1; count <= 142; count++) {
    assert.equal(select(conversations, { ...drafts, c0: draft('x'.repeat(count)) }, 'c0'), initial);
  }
  assert.equal(initial.length, 50);
  assert.equal(conversations[0].messages[0].text, message.text);
});

test('other drafts, deletion, new messages and selected conversation changes invalidate the list', () => {
  const select = createConversationListSelector();
  const conversations = [conversation('active', { messages: [] }), conversation('other', { messages: [] }), conversation('saved')];
  let drafts = { active: draft('my text'), other: draft() };
  const initial = select(conversations, drafts, 'active');
  assert.equal(initial.length, 1);
  drafts = { ...drafts, other: draft('hello\u0000\u0001世界') };
  const changed = select(conversations, drafts, 'active');
  assert.notEqual(changed, initial);
  assert.equal(changed[0].title, drafts.other.text);
  assert.equal(select(conversations, drafts, 'active'), changed);
  const switched = select(conversations, drafts, 'other');
  assert.equal(switched[0].conversation.id, 'active');
  const removed = select(conversations.slice(0, 2), drafts, 'other');
  assert.ok(!removed.some(row => row.conversation.id === 'saved'));
  const updated = select([conversation('active', { title: 'new reply' })], drafts, 'active');
  assert.equal(updated[0].title, 'new reply');
});

test('search matches visible draft titles or user messages and preserves day groups', () => {
  const select = createConversationListSelector();
  const rows = select([conversation('today'), conversation('old', { updatedAt: timestamp - 86400000 }), conversation('draft', { messages: [] }), conversation('assistant-only', { messages: [{ role: 'assistant', text: 'private search token' }] })], { draft: draft('Words to learn') }, 'today');
  const today = new Date(timestamp).toDateString();
  const groups = conversationGroups(rows, 'IRREGULAR', today);
  assert.deepEqual(groups.map(([, items]) => items.map(row => row.conversation.id)), [['today'], ['old']]);
  assert.equal(conversationGroups(rows, 'words', today)[0][1][0].conversation.id, 'draft');
  assert.deepEqual(conversationGroups(rows, 'private search token', today).map(([, items]) => items), [[], []]);
});

test('legacy finite timestamps outside the Date range retain conversations without breaking the panel', () => {
  const rows = createConversationListSelector()([conversation('legacy', { updatedAt: 1e20 })], {}, 'legacy');
  assert.equal(rows[0].dateLabel, '日期未知');
  assert.equal(conversationGroups(rows, '', new Date(timestamp).toDateString())[1][1][0].conversation.id, 'legacy');
});
