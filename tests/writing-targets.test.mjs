import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_WRITING_TARGETS, mergeTargetIds, searchTargetWords, targetWordAdditions, toggleTargetWord } from '../lib/writing-targets.ts';

const word = (id, headword, chineseCore = '', bookId = 'book-a') => ({ id, headword, lookup: headword.toLowerCase(), chineseCore, sources: [{ bookId }] });
const entries = [word('pineapple', 'pineapple', '菠萝'), word('apple-pie', 'apple pie', '苹果派'), word('meaning', 'fruit', '苹果类水果', 'book-b'), word('apple', 'apple', '苹果')];

test('target picker searches English and Chinese across the whole index with exact matches first', () => {
  assert.deepEqual(searchTargetWords(entries, { query: ' ＡＰＰＬＥ ' }).map(row => row.id), ['apple', 'apple-pie', 'pineapple']);
  assert.deepEqual(searchTargetWords(entries, { query: '苹果' }).map(row => row.id), ['apple-pie', 'meaning', 'apple']);
  const largeIndex = [...Array.from({ length: 200 }, (_, index) => word(`w${index}`, `word ${index}`)), word('late', 'zebra', '斑马')];
  assert.equal(searchTargetWords(largeIndex, { query: 'zebra' })[0].id, 'late');
});

test('target selection survives query, learned and textbook filtering without changing existing words', () => {
  const existing = new Set(['apple']);
  let draft = toggleTargetWord(new Set(), 'meaning', existing);
  const selected = new Set([...existing, ...draft]);
  assert.deepEqual(searchTargetWords(entries, { scope: 'selected', selectedIds: selected }).map(row => row.id), ['meaning', 'apple']);
  assert.deepEqual(searchTargetWords(entries, { query: 'apple', bookId: 'book-a', scope: 'learned', learnedIds: new Set(['apple-pie']) }).map(row => row.id), ['apple-pie']);
  assert.deepEqual([...draft], ['meaning'], 'search filtering never changes draft selection');
  draft = toggleTargetWord(draft, 'apple', existing);
  assert.deepEqual([...draft], ['meaning'], 'already added targets cannot be selected again');
  draft = toggleTargetWord(draft, 'meaning', existing);
  assert.equal(draft.size, 0);
});

test('target additions preserve stable IDs, remove duplicates and allow more than six words', () => {
  const valid = new Set(Array.from({ length: 20 }, (_, index) => `word-${index}`));
  const additions = targetWordAdditions(new Set(['word-0']), ['word-0', ...valid, 'word-7', 'not-in-library'], valid);
  assert.equal(additions.length, 19);
  assert.equal(additions[0], 'word-1');
  assert.equal(additions.includes('word-0'), false);
  assert.equal(additions.includes('not-in-library'), false);
});

test('target picker respects the existing twenty-word storage contract and frees capacity when unchecked', () => {
  const valid = new Set(Array.from({ length: 30 }, (_, index) => `word-${index}`));
  const existing = new Set([...valid].slice(0, 19));
  let draft = toggleTargetWord(new Set(), 'word-19', existing);
  assert.equal(draft.size, 1);
  draft = toggleTargetWord(draft, 'word-20', existing);
  assert.equal(draft.has('word-20'), false);
  draft = toggleTargetWord(draft, 'word-19', existing);
  draft = toggleTargetWord(draft, 'word-20', existing);
  assert.deepEqual([...draft], ['word-20']);
  assert.deepEqual(targetWordAdditions(existing, ['word-19', 'word-20'], valid), ['word-19']);
  assert.deepEqual(targetWordAdditions(new Set([...valid].slice(0, 20)), ['word-20'], valid), []);
  const merged = mergeTargetIds(['word-0', 'word-0', 'invalid'], valid, new Map([...valid].map(id => [id, {}])));
  assert.equal(merged.length, MAX_WRITING_TARGETS);
  assert.equal(new Set(merged).size, MAX_WRITING_TARGETS);
  assert.equal(merged.includes('invalid'), false);
});
