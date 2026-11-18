import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { orderWords, shuffleWords } from '../lib/word-order.ts';
import { decodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';
import { selectEntries } from '../lib/study.ts';

const index = decodeLexiconIndex(JSON.parse(readFileSync(new URL('../public/data/v1/index.json', import.meta.url))));
const unit = selectEntries(index, { bookId: 'HS-R1', unit: 'Unit 1' });

test('textbook order follows original source rows within the selected book and unit', () => {
  const ordered = orderWords(unit, 'textbook', { bookId: 'HS-R1', unit: 'Unit 1' });
  assert.deepEqual(ordered.slice(0, 5).map(e => e.headword), ['teenage', 'teenager', 'ballet', 'volunteer', 'debate']);
  const sequence = ordered.map(e => e.sources.find(s => s.bookId === 'HS-R1' && s.unit === 'Unit 1').sequence);
  assert.ok(sequence.every((value, i) => Number.isInteger(value) && (i === 0 || value >= sequence[i - 1])));
  assert.deepEqual(new Set(ordered.map(e => e.id)), new Set(unit.map(e => e.id)));
});

test('textbook order never borrows a position from another book or unit', () => {
  const a = { id: 'a', headword: 'a', sources: [{ bookId: 'HS-R1', unit: 'Unit 2', sequence: 1 }, { bookId: 'HS-R2', unit: 'Unit 1', sequence: 70 }] };
  const b = { id: 'b', headword: 'b', sources: [{ bookId: 'HS-R2', unit: 'Unit 1', sequence: 2 }] };
  assert.deepEqual(orderWords([a, b], 'textbook', { bookId: 'HS-R2', unit: 'Unit 1' }), [b, a]);
});

test('alphabetical directions are exact inverses and do not mutate the source', () => {
  const before = unit.map(e => e.id);
  const az = orderWords(unit, 'az');
  assert.deepEqual(orderWords(unit, 'za'), [...az].reverse());
  assert.deepEqual(unit.map(e => e.id), before);
});

test('shuffle produces a complete stable queue without modifying source entries', () => {
  const before = [...unit];
  const queue = shuffleWords(unit, () => 0);
  assert.notDeepEqual(queue, unit);
  assert.deepEqual(new Set(queue), new Set(unit));
  assert.deepEqual(unit, before);
  assert.deepEqual(shuffleWords([], () => 0), []);
  assert.deepEqual(shuffleWords([unit[0]], () => 0), [unit[0]]);
});

test('old cached indexes without source order remain readable', () => {
  const encoded = JSON.parse(readFileSync(new URL('../public/data/v1/index.json', import.meta.url)));
  delete encoded.sourceOrders;
  const legacy = decodeLexiconIndex(encoded);
  assert.equal(legacy.length, index.length);
  assert.equal(legacy[0].sources[0].sequence, undefined);
  assert.equal(orderWords(legacy, 'textbook').length, legacy.length);
});

test('source order columns reject missing, negative, fractional or misaligned positions', () => {
  const encoded = JSON.parse(readFileSync(new URL('../public/data/v1/index.json', import.meta.url)));
  for (const bad of [[], null, -1, 0, 1.5, '3']) {
    const value = structuredClone(encoded);
    if (Array.isArray(bad) || bad === null) value.sourceOrders = bad;
    else value.sourceOrders[0][0] = bad;
    assert.throws(() => decodeLexiconIndex(value), /Invalid lexicon index/);
  }
});
