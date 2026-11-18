const wordA = 'pep-1e3e7e41accdc5f7';
const wordB = 'pep-07d418db40de3fe8';
const backup = { schemaVersion: '1.2.0', cards: [], events: [], lists: [], settings: [], writings: [] };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=';

// Test-only inputs that pass pre-authentication parsing, shared by route and HTTP tests.
export const validBodies = {
  '/api/writing/generate-topic': { operationId: 'security-topic-1234', kind: 'free' },
  '/api/writing/recognize': { operationId: 'security-writing-123', image },
  '/api/voice/dictation-plan': { operationId: 'security-dictation-plan', text: 'book' },
  '/api/voice/dictation-recognize': { operationId: 'security-dictation-image', image },
  '/api/voice/learning-tool': { name: 'prepare_dictation', callId: 'call_test', sessionId: 'live_test', arguments: { query: 'book', count: 3, mode: 'words' }, accountScope: 'test-scope' },
  '/api/learning-journal': { accountScope: 'test-scope', privacyRevision: 0, eventId: 'test-event', kind: 'study', title: 'Study', summary: 'Completed a practice.', refIds: [], counts: {}, occurredAt: new Date().toISOString(), timezone: 'UTC' },
  '/api/sync': { schemaVersion: '1.2.0', baseRevision: 0, clientUpdatedAt: '2026-09-24T00:00:00Z', payload: backup },
  '/api/ai/config': { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-only-not-a-real-key-000000', dailyLimit: 30, timeoutSeconds: 25 },
  '/api/ai/test': {},
  '/api/assistant/chat': { messages: [{ role: 'user', text: '安排今天的复习' }], model: 'auto', temporary: true },
  '/api/assistant/explain': { wordId: wordA },
  '/api/assistant/check-sentence': { wordId: wordA, sentence: 'They abandoned the plan.' },
  '/api/assistant/generate-practice': { wordIds: [wordA, wordB], count: 3 },
  '/api/assistant/contrast-words': { wordIds: [wordA, wordB] },
  '/api/assistant/review-essay': { wordIds: [wordA], genre: 'free', essay: 'I abandoned my old plan and started again.' },
  '/api/assistant/mnemonic': { wordId: wordA },
  '/api/assistant/story': { wordIds: [wordA, wordB, 'pep-0000000000000001'] },
  '/api/assistant/diagnose': { wordIds: [wordA] },
  '/api/reading/classify': { title: 'A test article', text: 'This is an English reading sample. '.repeat(5) },
  '/api/voice/session': { sdp: 'v=0\r\n', topicId: 'daily', level: 'B2', minutes: 10 },
  '/api/voice/close': { sessionId: 'test-session' },
  '/api/voice/speech': { text: 'A short listening exercise.' },
  '/api/voice/feedback': { topicId: 'daily', transcript: [{ role: 'user', text: 'I prefer the train because it is comfortable.' }] },
  '/api/voice/memory': { revision: 0, enabled: true, notes: [{ id: 'test_note', text: 'Practice discussing books.' }], recentTopics: [] },
  '/api/learning-memory': { accountScope: 'test-scope', revision: 0, enabled: true, notes: [{ id: 'test_note', text: 'Practice discussing books.' }], recentTopics: [] },
  '/api/voice/recommend': { topicId: 'culture', level: 'B2', minutes: 10 },
  '/api/voice/discuss': { topicId: 'culture', level: 'B2', transcript: [{ role: 'user', text: 'I enjoy reading novels.' }], messages: [{ role: 'user', text: 'How could I say that more naturally?' }] },
};

export const actions = { '/api/ai/config': 'settings', '/api/ai/test': 'settings', '/api/reading/classify': 'reading-classify', '/api/sync': 'sync' };

// These GET handlers explicitly check same-origin; sync/config GET rely on identity.
export const sameOriginGetPaths = new Set(['/api/learning-journal', '/api/learning-memory', '/api/voice/memory', '/api/voice/status']);
