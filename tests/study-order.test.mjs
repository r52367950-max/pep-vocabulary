import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTextbookOrder, orderStudyEntries } from '../lib/study-order.ts';

const word = (id, sources) => ({ id, sources });
const rows = [
  word('a', [{ bookId: 'HS-R1', unit: 'Unit 1', textbookOrder: 3 }]),
  word('b', [{ bookId: 'HS-R1', unit: 'Unit 1', textbookOrder: 1 }]),
  word('c', [{ bookId: 'HS-R1', unit: 'Unit 1', textbookOrder: 2 }]),
];
test('verified textbook positions override alphabetical order without mutating the pool', () => {
  assert.deepEqual(orderStudyEntries(rows, 'textbook', 'HS-R1', 'Unit 1').map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']);
});
test('book and unit must match the same verified source; partial evidence cannot expose textbook order', () => {
  assert.equal(hasTextbookOrder(rows, 'HS-R1', 'Unit 1'), true);
  assert.equal(hasTextbookOrder(rows, 'HS-R2', 'Unit 1'), false);
  assert.equal(hasTextbookOrder(rows, 'HS-R1', 'Unit 2'), false);
  assert.equal(hasTextbookOrder([...rows, word('d', [{ bookId: 'HS-R1', unit: 'Unit 1' }])], 'HS-R1', 'Unit 1'), false);
  assert.equal(hasTextbookOrder([], 'HS-R1'), false);
});
test('shuffle retains all selected words and unsupported textbook order safely falls back to shuffle', () => {
  assert.deepEqual(orderStudyEntries(rows, 'random', 'HS-R1', 'all', () => 0).map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(orderStudyEntries(rows, 'textbook', 'JH-7A', 'all', () => 0).map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']);
});
