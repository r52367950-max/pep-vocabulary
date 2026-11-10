import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatProvenance } from '../lib/assistant/chat-contract.ts';
import { assistantEntryLocations } from '../lib/assistant-provenance.ts';
import { parseStoredConversations, serializeConversations } from '../components/studio/companion/persistence.ts';

const wordId = 'pep-1e3e7e41accdc5f7';
const at = 1800000000000;
const answer = provenance => ({ id: 'a', at, role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '生成解释' }], request: { model: 'gpt-6.1-sol' }, provenance });
const conversation = message => ({ id: 'c', title: '对话', temporary: false, createdAt: at, updatedAt: at, messages: [message] });

test('history keeps only bounded origin metadata and always downgrades old or forged authenticity', () => {
  const provenance = { origin: 'verified-textbook', textbookQuotes: 'verified', evidenceIds: [wordId, wordId, 'unknown'],
    userProvidedMaterial: true, evidence: [{ wordId, sources: [{ printedPage: 999 }] }], privateSource: 'PRIVATE_SOURCE' };
  const encoded = serializeConversations([conversation(answer(provenance))]);
  assert.ok(!encoded.includes('PRIVATE_SOURCE'));
  assert.ok(!encoded.includes('999'));
  assert.deepEqual(parseStoredConversations(encoded)[0].messages[0].provenance, {
    origin: 'model-generated', textbookQuotes: 'unverified', evidenceIds: [wordId], userProvidedMaterial: true,
  });
  const old = parseStoredConversations(serializeConversations([conversation(answer(undefined))]))[0].messages[0];
  assert.deepEqual(old.provenance, parseChatProvenance(null));
  assert.equal(parseChatProvenance({ userProvidedMaterial: 'true' }).userProvidedMaterial, false);
  assert.equal(parseChatProvenance({ evidenceIds: Array.from({ length: 100 }, (_, i) => `pep-${i.toString(16).padStart(16, '0')}`) }).evidenceIds.length, 80);
});

test('chat history entry locations come from current formally released vocabulary', () => {
  const restored = parseStoredConversations(serializeConversations([conversation(answer({ evidenceIds: [wordId] }))]))[0].messages[0];
  const source = { bookId: 'HS-S3', volume: '选择性必修第三册', unit: 'Unit 4', printedPage: 109 };
  const words = new Map([[wordId, { id: wordId, headword: 'abandon', flags: { formalReleaseEligible: true }, sources: [source] }]]);
  assert.deepEqual(assistantEntryLocations(restored.provenance, words), [{ wordId, headword: 'abandon', sources: [source] }]);
  words.get(wordId).flags.formalReleaseEligible = false;
  assert.deepEqual(assistantEntryLocations(restored.provenance, words), []);
});
