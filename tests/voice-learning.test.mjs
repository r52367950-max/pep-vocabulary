import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTutorInstructions, getVoiceTopic, VOICE_LEVELS, VOICE_TOPICS } from '../lib/voice/curriculum.ts';
import { compareDictation, dictationTokens, DICTATION_SENTENCES, parseDictationHistory, recordDictationAttempt, selectDictationRound, wordDictationItems } from '../lib/voice/dictation.ts';

test('dictation accepts punctuation, typographic apostrophes, listed UK spelling and unambiguous contractions', () => {
  assert.equal(compareDictation("I'm travelling to the city centre.", 'I am traveling to the city center!').correct, true);
  assert.equal(compareDictation('We cannot organise it.', "We can’t organize it").correct, true);
  assert.equal(compareDictation("She's visited before.", 'She has visited before.').correct, false, 'ambiguous contractions must not receive an invented expansion');
  assert.equal(compareDictation('We walk.', 'We walked.').correct, false, 'tense must not be normalised away');
});
test('word alignment identifies an omission without shifting later words', () => {
  const result = compareDictation('The museum is near the station.', 'The museum near the station');
  assert.equal(result.correct, false);
  assert.equal(result.matched, 5);
  assert.equal(result.total, 6);
  assert.deepEqual(result.differences.filter((part) => part.kind !== 'equal'), [{ kind: 'missing', expected: 'is' }]);
});
test('word alignment separately reports replacement and insertion', () => {
  assert.deepEqual(compareDictation('We need a solution.', 'We need the solution now').differences.filter((part) => part.kind !== 'equal'), [
    { kind: 'replace', expected: 'a', actual: 'the' }, { kind: 'extra', actual: 'now' },
  ]);
  assert.deepEqual(compareDictation('a a b', 'a b').differences.map((part) => part.kind), ['missing', 'equal', 'equal']);
  assert.equal(compareDictation('', '').correct, false);
  assert.equal(compareDictation('listen', '').matched, 0);
  assert.equal(dictationTokens('word '.repeat(10000)).length, 160, 'alignment work is bounded');
});
test('word rounds deduplicate headwords, retain stable vocabulary IDs and never mutate their source', () => {
  const entries = [{ id: 'a', headword: 'Give up', chineseCore: '放弃' }, { id: 'b', headword: 'give up', chineseCore: '' }, { id: 'c', headword: '123', chineseCore: '' }];
  const original = JSON.stringify(entries);
  const items = wordDictationItems(entries);
  assert.equal(items.length, 1);
  assert.equal(items[0].wordId, 'a');
  assert.equal(items[0].id, 'word:a');
  assert.equal(JSON.stringify(entries), original);
  assert.deepEqual(selectDictationRound([1, 2, 3], 2, () => 0), [2, 3]);
});
test('mistakes are retained after successful retry and isolated by activity identity', () => {
  const item = DICTATION_SENTENCES[0];
  let records = recordDictationAttempt([], item, 'wrong', '2026-10-29T00:00:00Z');
  assert.equal(records[0].resolved, false);
  records = recordDictationAttempt(records, item, item.text, '2026-10-29T00:01:00Z');
  assert.equal(records.length, 1);
  assert.equal(records[0].resolved, true);
  assert.equal(records[0].attempts, 2);
  assert.equal(records[0].mistakes, 1);
  assert.deepEqual(parseDictationHistory(JSON.stringify(records)), records);
  const other = { ...item, id: 'word:separate', mode: 'words' };
  records = recordDictationAttempt(records, other, 'wrong');
  assert.equal(records.length, 2);
  assert.equal(records[1].resolved, true);
});
test('corrupt or excessive local history is rejected and retention is bounded', () => {
  assert.deepEqual(parseDictationHistory('{'), []);
  assert.deepEqual(parseDictationHistory('{}'), []);
  assert.deepEqual(parseDictationHistory('[null, {"attempts": 1}]'), []);
  assert.deepEqual(parseDictationHistory('x'.repeat(2_000_001)), []);
  let records = [];
  for (let i = 0; i < 305; i++) records = recordDictationAttempt(records, { ...DICTATION_SENTENCES[0], id: `item:${i}` }, 'wrong');
  assert.equal(records.length, 300);
  assert.equal(records[0].item.id, 'item:304');
  assert.deepEqual(parseDictationHistory(JSON.stringify([{ ...records[0], mistakes: -1 }])), []);
});
test('curriculum spans six topics and levels, supporting concise goal-oriented discussion', () => {
  assert.equal(new Set(VOICE_TOPICS.map((topic) => topic.id)).size, 6);
  assert.deepEqual(VOICE_LEVELS.map((level) => level.id), ['B1', 'B2', 'C1']);
  for (const topic of VOICE_TOPICS) {
    assert.equal(topic.phrases.length, 3);
    assert.ok(topic.openingPrompt && topic.goal && topic.prompts.length >= 3);
    const prompt = buildTutorInstructions({ topicId: topic.id, level: 'B2', targetWords: ['perspective'] });
    assert.ok(prompt.includes(topic.goal));
    assert.match(prompt, /exactly one question/);
    assert.match(prompt, /time to think/);
    assert.match(prompt, /Do not interrupt/);
    assert.match(prompt, /Never invent pronunciation/);
    assert.match(prompt, /Transcription is fallible/);
  }
  assert.equal(getVoiceTopic('unknown').id, 'everyday');
  assert.ok(DICTATION_SENTENCES.every((item) => item.source === '词迹原创练习句'));
});
