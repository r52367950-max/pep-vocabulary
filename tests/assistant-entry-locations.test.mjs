import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantEntryLocations } from '../lib/assistant-provenance.ts';

const source = { bookId: 'middle-7-up', volume: '七年级上册', unit: 'Unit 2', printedPage: 109 };
const word = (id = 'word-a', sources = [source], formalReleaseEligible = true) => ({
  id, headword: `sample-${id}`, sources, flags: { formalReleaseEligible },
});
const known = new Map([['word-a', word()]]);

test('cached and model attribution cannot replace current lexicon entry locations', () => {
  const forged = {
    evidenceIds: ['word-a'],
    origin: 'verified-textbook',
    provenance: { textbookQuotes: 'verified', evidence: [{ wordId: 'word-a', sources: [{ bookId: 'forged', printedPage: 45 }] }] },
    citations: [{ book: '伪造教材', page: 45, verified: true }],
  };
  const before = structuredClone(forged);
  assert.deepEqual(assistantEntryLocations(forged, known), [{ wordId: 'word-a', headword: 'sample-word-a', sources: [source] }]);
  assert.deepEqual(forged, before);
});

test('untrusted citation properties are not read, including for earlier saved reviews', () => {
  const earlier = { evidenceIds: ['word-a'] };
  for (const key of ['origin', 'provenance', 'citations']) {
    Object.defineProperty(earlier, key, { get() { throw new Error('untrusted attribution was read'); } });
  }
  assert.equal(assistantEntryLocations(earlier, known)[0].sources[0].printedPage, 109);
  assert.deepEqual(assistantEntryLocations({ origin: 'textbook', citations: [{ page: 45 }] }, known), []);
});

test('unknown, duplicate and non-formal IDs do not acquire source locations', () => {
  const words = new Map([...known, ['draft', word('draft', [source], false)], ['legacy', { id: 'legacy', sources: [source] }]]);
  const result = assistantEntryLocations({ evidenceIds: ['unknown', null, 5, 'word-a', 'word-a', 'draft', 'legacy'] }, words);
  assert.deepEqual(result.map((entry) => entry.wordId), ['word-a']);
  assert.deepEqual(assistantEntryLocations(null, words), []);
  assert.deepEqual(assistantEntryLocations({ evidenceIds: 'word-a' }, words), []);
});

test('saved results use the current release and do not retain obsolete citation metadata', () => {
  const current = new Map([['word-a', word('word-a', [{ ...source, printedPage: 110 }])]]);
  assert.equal(assistantEntryLocations({ evidenceIds: ['word-a'], provenance: { page: 109 } }, current)[0].sources[0].printedPage, 110);
});

test('entry locations preserve distinct current positions, deduplicate and isolate their data', () => {
  const sources = [source, { ...source, status: 'verified' }, { ...source, printedPage: null, unit: 'Appendix' }];
  const words = new Map([['word-a', word('word-a', sources)]]);
  const locations = assistantEntryLocations({ evidenceIds: ['word-a'] }, words);
  assert.deepEqual(locations[0].sources, [source, { ...source, printedPage: null, unit: 'Appendix' }]);
  locations[0].sources[0].printedPage = 1;
  assert.equal(source.printedPage, 109);
});

test('an imported result cannot expand the source display beyond its bounded entries and positions', () => {
  const words = new Map(Array.from({ length: 20 }, (_, i) => [`word-${i}`, word(`word-${i}`, Array.from({ length: 20 }, (_, page) => ({ ...source, printedPage: page + 1 })))]));
  const ids = [...words.keys()];
  const result = assistantEntryLocations({ evidenceIds: [...ids, ...ids] }, words);
  assert.equal(result.length, 12);
  assert.ok(result.every((entry) => entry.sources.length === 12));
});
