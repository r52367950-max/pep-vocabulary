import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAssistantRequest, resolveLexiconEvidence, sanitizeModelResult } from '../lib/assistant/core.ts';

const word = 'pep-1e3e7e41accdc5f7';
const evidence = resolveLexiconEvidence([{
  id: word, headword: 'abandon', chineseCore: '放弃', partsOfSpeech: ['vt'], scopes: ['high-selective'],
  sources: [{ bookId: 'HS-S3', volume: '选择性必修第三册', unit: 'Unit 4', printedPage: 109 }],
  flags: { formalReleaseEligible: true },
}], [word]);
const explain = (extra = {}) => ({ summary: '表示放弃。', meaning: [], grammar: [], collocations: [], examples: [], evidenceIds: [word], limitations: [], ...extra });
const essay = (extra = {}) => ({ overall: '内容清楚。', scores: { content: 3, vocabulary: 3, grammar: 3, structure: 3 }, estimatedScore: 8,
  issues: [], targetWords: [], upgrades: [], revised: 'A revised diary entry.', nextSteps: [], evidenceIds: [word], limitations: [], ...extra });
const violation = error => error.code === 'evidence_violation';

test('the reported Chinese sentence-attribution bypass is rejected even for a known lexicon page', () => {
  for (const page of [45, 109]) assert.throws(() => sanitizeModelResult('explain', JSON.stringify(explain({
    summary: `课本第 ${page} 页的句子是：They abandoned their plan.`,
  })), evidence), violation);
});

test('English textbook quotations do not become verified from a matching location', () => {
  for (const summary of ['The sentence in the textbook on page 109 is: They abandoned their plan.', 'According to the coursebook, "They abandoned their plan."'])
    assert.throws(() => sanitizeModelResult('explain', JSON.stringify(explain({ summary })), evidence), violation);
});

test('an unrelated integer in student text cannot authorize a model page claim', () => {
  const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: 'Together 45 families abandoned their plans and helped us.' });
  for (const page of [45, 1000]) assert.throws(() => sanitizeModelResult('review-essay', JSON.stringify(essay({ overall: `参考 page ${page}。` })), evidence, 8, request), violation);
});

test('actual student diary page wording remains quotable in feedback and revised text', () => {
  const source = 'I abandoned my plan. On page 45 of my diary I wrote it down.';
  const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: source });
  const result = sanitizeModelResult('review-essay', JSON.stringify(essay({
    issues: [{ quote: 'On page 45 of my diary', type: 'style', suggestion: 'On page 45 of my diary', reason: '日记细节可以保留。' }],
    revised: source,
  })), evidence, 8, request);
  assert.equal(result.issues[0].quote, 'On page 45 of my diary');
  assert.equal(result.revised, source);
});

test('a real student page reference cannot authorize unrelated feedback or added revision prose', () => {
  const source = 'I abandoned my plan. On page 45 of my diary I wrote it down.';
  const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: source });
  for (const extra of [{ overall: '参考 page 45。' }, { revised: `${source} See page 45 for more evidence.` }])
    assert.throws(() => sanitizeModelResult('review-essay', JSON.stringify(essay(extra)), evidence, 8, request), violation);
});

test('rewriting another sentence preserves an unchanged student diary clause', () => {
  const source = 'I abandoned my plan. On page 45 of my diary I wrote it down.';
  const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: source });
  const revised = 'I decided to abandon my earlier plan. On page 45 of my diary I wrote it down.';
  assert.equal(sanitizeModelResult('review-essay', JSON.stringify(essay({ revised })), evidence, 8, request).revised, revised);
});

test('normal grammar corrections preserve explicit diary references without granting other citations', () => {
  for (const reference of ['page 45 of my diary', 'p. 45 of my diary', 'my diary page 45', 'page 45 of my old diary', 'page 45 of my research notebook', 'page 45 of my story notebook', 'page 1000 of my diary']) {
    const source = `I abandoned my plan. On ${reference} I write notes.`;
    const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: source });
    const revised = source.replace('I write', 'I wrote');
    assert.equal(sanitizeModelResult('review-essay', JSON.stringify(essay({ revised })), evidence, 8, request).revised, revised);
    for (const text of [revised.replace(/diary|notebook/, 'textbook'), `${revised} See page 45 for evidence.`])
      assert.throws(() => sanitizeModelResult('review-essay', JSON.stringify(essay({ revised: text })), evidence, 8, request), violation);
  }
});

test('feedback can quote a located student reference without authorizing claims outside the quote', () => {
  const source = 'I abandoned my plan. On page 45 of my diary I wrote it down.';
  const request = parseAssistantRequest('review-essay', { wordIds: [word], essay: source });
  for (const [open, close] of [['“', '”'], ['"', '"'], ['‘', '’']]) {
    const overall = `你写的${open}On page 45 of my diary${close}这个细节可以保留。`;
    assert.equal(sanitizeModelResult('review-essay', JSON.stringify(essay({ overall })), evidence, 8, request).overall, overall);
    for (const text of [overall.replace('diary', 'textbook'), `${overall}参考 page 45。`])
      assert.throws(() => sanitizeModelResult('review-essay', JSON.stringify(essay({ overall: text })), evidence, 8, request), violation);
  }
});

test('ordinary textbook prose and supported word-list locations remain usable', () => {
  for (const extra of [
    ...['I abandoned the textbook because it contains outdated information.',
      'I wrote a sentence in my textbook before I abandoned the exercise.',
      'The textbook reads easily, so I did not abandon it.',
      'The sentence in the textbook inspired me to abandon my old plan.']
      .map(sentence => ({ examples: [{ sentence, translation: '用于练习的 AI 新写例句。' }] })),
    { examples: [{ sentence: 'I abandoned the idea of taking notes beside the sentences in my textbook.', translation: '我放弃了在课本的句子旁做笔记的想法。' }] },
    { summary: 'According to the textbook vocabulary list, abandon appears on page 109.' }])
    assert.doesNotThrow(() => sanitizeModelResult('explain', JSON.stringify(explain(extra)), evidence));
});

test('provider origin and citation claims cannot control server-owned provenance', () => {
  const result = sanitizeModelResult('explain', JSON.stringify(explain({
    origin: 'textbook-verified', citations: [{ bookId: 'fake', printedPage: 45, verified: true }],
    provenance: { textbookQuotes: 'verified', sourceKind: 'textbook-original', evidence: [{ wordId: word, sources: [{ printedPage: 45 }] }] },
  })), evidence);
  assert.equal(result.origin, 'model-generated');
  assert.equal(result.citations, undefined);
  assert.deepEqual(result.provenance, { textbookQuotes: 'unverified', sourceKind: 'lexicon-entry-locations',
    evidence: [{ wordId: word, headword: 'abandon', sources: evidence[0].sources }] });
});

test('generated examples and ordinary numerical prose retain normal behavior', () => {
  const result = sanitizeModelResult('explain', JSON.stringify(explain({
    summary: '练习 45 次有助于记忆。', examples: [{ sentence: 'They abandoned their plan.', translation: '他们放弃了计划。' }],
  })), evidence);
  assert.equal(result.summary, '练习 45 次有助于记忆。');
  assert.equal(result.examples[0].origin, 'model-generated');
});
