import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { buildQuestion, gradeQuestion, normalizeAnswer, localSentenceCheck } from '../lib/questions.ts';
import { newStoredCard, scheduleReview, forecastDueLoad, isDue } from '../lib/scheduler.ts';
import { clearUserData, updateCardMetadata, putOne, getOne, getAll, commitReview, exportBackup, restoreBackup, validateBackup, defaultSettings, loadSettings } from '../lib/storage.ts';
import { matchesLexiconQuery } from '../lib/lexicon.ts';
import { readJsonObject, sameOriginRequest } from '../lib/http.ts';
import { delimitedCell } from '../lib/export.ts';
import { normalizeBaseUrl } from '../lib/assistant/core.ts';

const entry = (id, headword, chineseCore) => ({ id, headword, lookup: headword, chineseCore, scopes: ['high-required'], sources: [], partsOfSpeech: [], flags: {}, britishIpa: '' });
const apple = entry('apple', 'apple', '苹果');
const now = new Date('2026-09-14T12:00:00Z');
function review(stored = null) {
  return scheduleReview({ stored, cardId: 'apple', rating: 3, retention: 0.9, skill: 'meaning', questionType: 'meaning-recall', correct: true, responseMs: 1000, hints: 0, errorType: null, now }).event;
}

test('Chinese choices are distinguished and empty/punctuation answers are rejected', () => {
  const q = buildQuestion(apple, undefined, 'listening-choice', [apple, entry('pear', 'pear', '梨')]);
  assert.equal(gradeQuestion(q, '苹果'), true);
  assert.equal(gradeQuestion(q, '梨'), false);
  assert.equal(gradeQuestion(q, '!!!'), false);
  assert.equal(normalizeAnswer('ＡＰＰＬＥ'), 'apple');
});
test('choices contain one correct option and no duplicate Chinese meanings', () => {
  const q = buildQuestion(apple, undefined, 'listening-choice', [apple, entry('a', 'apples', '苹果'), entry('b', 'apple2', '苹果'), entry('c', 'pear', '梨'), entry('d', 'pears', '梨'), entry('e', 'peach', '桃'), entry('f', 'plum', '李')]);
  assert.equal(q.choices.length, 4);
  assert.equal(new Set(q.choices).size, 4);
});
test('Chinese and punctuation searches cannot turn into an empty Latin prefix', () => {
  assert.equal(matchesLexiconQuery(apple, '苹果'), true);
  assert.equal(matchesLexiconQuery(apple, '学校'), false);
  assert.equal(matchesLexiconQuery(apple, '!!!'), false);
  assert.equal(matchesLexiconQuery(apple, 'ＡＰＰ'), true);
});
test('sentence target check uses word boundaries', () => {
  assert.equal(localSentenceCheck('I went to the theater yesterday.', 'he').hasTarget, false);
  assert.equal(localSentenceCheck('He went to the theater yesterday.', 'he').hasTarget, true);
});
test('forecasts exclude distant, paused and unseen cards without clamping to the last day', () => {
  const make = (id, due, status = 'learning') => ({ ...newStoredCard(id, now), due, status });
  const cards = [make('a', '2026-09-13T00:00:00Z'), make('b', '2026-12-01T00:00:00Z'), make('c', 'bad'), make('d', now.toISOString(), 'unseen'), make('e', now.toISOString(), 'paused')];
  assert.equal(forecastDueLoad(cards, 14, now).reduce((n, d) => n + d.count, 0), 1);
  assert.deepEqual(forecastDueLoad(cards, 0, now), []);
  assert.equal(isDue(cards[3], now), false);
});
test('review and undo atomically restore an originally absent card', async () => {
  await clearUserData();
  const event = review();
  assert.equal(event.before, null);
  await commitReview(event);
  assert.deepEqual(await getOne('cards', 'apple'), event.after);
  await commitReview({ ...event, eventId: 'undo', eventType: 'undo', targetEventId: event.eventId });
  assert.equal(await getOne('cards', 'apple'), undefined);
  assert.equal((await getAll('events')).length, 2);
});
test('duplicate event abort rolls back the corresponding card update', async () => {
  await clearUserData();
  const event = review();
  await commitReview(event);
  const next = review(event.after);
  next.eventId = event.eventId;
  await assert.rejects(commitReview(next));
  assert.deepEqual(await getOne('cards', 'apple'), event.after);
  assert.equal((await getAll('events')).length, 1);
});
test('two tabs cannot overwrite each other from the same stale card', async () => {
  await clearUserData();
  const results = await Promise.allSettled([commitReview(review()), commitReview(review())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await getAll('events')).length, 1);
});
test('putOne rejects a transaction that aborts after its request succeeds', async () => {
  await clearUserData();
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(putOne('cards', newStoredCard('apple', now))); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.equal(await getOne('cards', 'apple'), undefined);
});
test('backup validation rejects bad dates, duplicate ids and invalid settings before replacing data', async () => {
  await clearUserData();
  await putOne('cards', newStoredCard('apple', now));
  await putOne('settings', defaultSettings);
  const backup = await exportBackup();
  const invalid = structuredClone(backup);
  invalid.cards[0].due = 'not-a-date';
  await assert.rejects(restoreBackup(invalid));
  assert.deepEqual(await exportBackup().then(b => b.cards), backup.cards);
  assert.throws(() => validateBackup({ ...backup, cards: [backup.cards[0], backup.cards[0]] }));
  assert.throws(() => validateBackup({ ...backup, settings: [{ ...defaultSettings, selectedBooks: null }] }));
  assert.throws(() => validateBackup({ ...backup, events: [null] }));
  assert.throws(() => validateBackup({ ...backup, settings: [{ ...defaultSettings, desiredRetention: 1 }] }));
});
test('valid backup round trips and legacy schema migrates', async () => {
  await clearUserData();
  await commitReview(review());
  await putOne('settings', defaultSettings);
  const backup = await exportBackup();
  await clearUserData();
  await restoreBackup({ ...backup, schemaVersion: '1.0.0' });
  assert.deepEqual((await exportBackup()).cards, backup.cards);
  assert.equal((await getAll('events')).length, 1);
  assert.equal((await loadSettings()).desiredRetention, 0.9);
});
test('chunked UTF-8 requests are bounded by bytes and cancelled before parsing', async () => {
  let cancelled = false;
  const request = new Request('https://app.test/api', { method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half', body: new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('中'.repeat(10))); }, cancel() { cancelled = true; } }) });
  await assert.rejects(readJsonObject(request, 20), error => error.status === 413);
  assert.equal(cancelled, true);
});
test('JSON null, arrays, wrong media types and cross-site mutations are rejected', async () => {
  for (const body of ['null', '[]', '1', '{']) {
    await assert.rejects(readJsonObject(new Request('https://app.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 4096), error => error.status === 400);
  }
  await assert.rejects(readJsonObject(new Request('https://app.test', { method: 'POST', body: '{}' }), 4096), error => error.status === 415);
  assert.equal(sameOriginRequest(new Request('https://app.test', { headers: { origin: 'https://evil.test' } })), false);
  assert.equal(sameOriginRequest(new Request('https://app.test', { headers: { 'sec-fetch-site': 'cross-site' } })), false);
});
test('trailing-dot, single-label, numeric and IPv6 local targets are blocked', () => {
  for (const host of ['localhost.', 'service.internal.', 'private.local.', 'intranet', '127.1', '2130706433', '[::7f00:1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]']) assert.throws(() => normalizeBaseUrl(`https://${host}/v1`), host);
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
});


test('metadata writes preserve a concurrently reviewed card instead of replacing its schedule', async () => {
  await clearUserData();
  const stale = newStoredCard('apple', now);
  const event = review();
  await commitReview(event);
  const updated = await updateCardMetadata(stale, { note: 'keep this', toggleFavorite: true });
  assert.deepEqual(updated.fsrs, event.after.fsrs);
  assert.equal(updated.favorite, true);
  assert.equal(updated.note, 'keep this');
});

test('CSV and TSV neutralize formulas and keep one row per record', () => {
  assert.equal(delimitedCell('=1+1', 'csv'), '"\'=1+1"');
  assert.equal(delimitedCell('a\tb\nc', 'tsv'), 'a b c');
  assert.equal(delimitedCell('苹果', 'csv'), '"苹果"');
});
