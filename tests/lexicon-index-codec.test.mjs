import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeLexiconIndex, encodeLexiconIndex, LEXICON_INDEX_FORMAT } from '../lib/lexicon-index-codec.mjs';
import { lexiconIndexEntry, validateLexiconRelease } from '../scripts/lexicon-release.mjs';

const published = JSON.parse(readFileSync(new URL('../public/data/v1/index.json', import.meta.url), 'utf8'));

test('the published index is row encoded and decodes to the exact chunk projection', () => {
  assert.equal(published.format, LEXICON_INDEX_FORMAT);
  const { entries } = validateLexiconRelease(new URL('../public/data/v1/', import.meta.url).pathname);
  const decoded = decodeLexiconIndex(published);
  assert.deepEqual(decoded, entries.map((entry) => JSON.parse(JSON.stringify(lexiconIndexEntry(entry)))));
  assert.deepEqual(encodeLexiconIndex(decoded), published, 'encoding is stable');
  assert.ok(JSON.stringify(published).length < JSON.stringify(decoded).length * 0.4);
});

test('legacy object arrays from an older cached release are read unchanged', () => {
  const legacy = decodeLexiconIndex(published).slice(0, 3);
  assert.equal(decodeLexiconIndex(legacy), legacy);
});

test('malformed encodings are rejected instead of producing partial entries', () => {
  const sample = encodeLexiconIndex(decodeLexiconIndex(published).slice(0, 2));
  const broken = [
    null, 'text', {}, { ...sample, format: 'pep-lexicon-index/1' }, { ...sample, books: [['HS-R1']] },
    { ...sample, rows: [sample.rows[0].slice(0, 10)] },
    { ...sample, rows: [[...sample.rows[0].slice(0, 9), [[99, 'Unit 1', null]], sample.rows[0][10]]] },
    { ...sample, rows: [[...sample.rows[0].slice(0, 9), [[0, 'Unit 1', '12']], sample.rows[0][10]]] },
    { ...sample, rows: [[sample.rows[0][0], 7, ...sample.rows[0].slice(2)]] },
    { ...sample, rows: [[...sample.rows[0].slice(0, 4), ['middle-core', 3], ...sample.rows[0].slice(5)]] },
  ];
  for (const value of broken) assert.throws(() => decodeLexiconIndex(value), /Invalid lexicon index/);
});

test('lookup equal to the headword and every flag combination survive a round trip', () => {
  const base = decodeLexiconIndex(published)[0];
  const entries = Array.from({ length: 16 }, (_, bits) => ({
    ...base, id: `pep-${bits.toString(16).padStart(16, '0')}`, lookup: bits % 2 ? base.headword : `${base.headword}-lookup`,
    flags: { highFrequencyContinuation: !!(bits & 1), highValue: !!(bits & 2), properName: !!(bits & 4), formalReleaseEligible: !!(bits & 8) },
  }));
  assert.deepEqual(decodeLexiconIndex(JSON.parse(JSON.stringify(encodeLexiconIndex(entries)))), entries);
});
