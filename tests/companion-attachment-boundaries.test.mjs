import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeText, readAttachment, statusLabel, LIMITS } from '../components/studio/companion/sources.ts';
import { parseChatRequest } from '../lib/assistant/chat-core.ts';

const decode = text => decodeText(new TextEncoder().encode(text));

test('large UTF-8 attachments fit the endpoint cap and keep Unicode characters intact', () => {
  for (const source of ['a'.repeat(2 * 1024 * 1024), '😀'.repeat(9000), 'a'.repeat(11999) + '😀end', 'a'.repeat(11998) + '😀end']) {
    const result = decode(source);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= LIMITS.readChars);
    assert.equal(result.text.isWellFormed(), true);
    assert.equal(result.chars, Array.from(result.text).length);
    assert.equal(source.startsWith(result.text), true);
    const parsed = parseChatRequest({ messages: [{ role: 'user', text: 'Read this.' }], files: [{ name: 'notes.txt', text: result.text }] });
    assert.equal(parsed.files[0].text, result.text);
  }
});

test('short and exact-boundary text remains unchanged and reports actual loaded characters', () => {
  for (const source of ['学习 review 😀', 'a'.repeat(12000), '😀'.repeat(6000)]) {
    const result = decode(source);
    assert.equal(result.text, source);
    assert.equal(result.truncated, false);
    assert.equal(result.chars, Array.from(source).length);
  }
  assert.equal(statusLabel({ status: 'read', truncated: true, chars: 6000 }), '已读取前 6,000 字');
});

test('real text-file reader returns bounded content and respects cancellation', async () => {
  const file = new File(['😀'.repeat(8000)], 'notes.txt', { type: 'text/plain' });
  const result = await readAttachment(file, 'text', new AbortController().signal);
  assert.equal(result.text.length, 12000);
  assert.equal(result.chars, 6000);
  assert.equal(result.truncated, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readAttachment(file, 'text', controller.signal), { name: 'AbortError' });
  assert.equal(decodeText(new Uint8Array([0xff])).ok, false);
  assert.equal(decode('binary\0content').ok, false);
});
