import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, zipSync, strToU8 } from 'fflate';
import { inspectDocxArchive, readDocxDocument, MAX_DOCX_DOCUMENT_BYTES } from '../lib/docx-archive.ts';
import { extractDocxXml, DOCX_WORKER_TIMEOUT_MS } from '../lib/docx-import.ts';

const xml = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A normal document.</w:t></w:r></w:p></w:body></w:document>');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function archiveFixture(entries = [{ name: 'word/document.xml', bytes: xml }], { zip64 = false, zip64Entries = false, descriptor = false, deflate = false, comment = '' } = {}) {
  const localParts = [], directoryParts = [];
  let offset = 0;
  const put64 = (view, at, value) => { view.setUint32(at, value >>> 0, true); view.setUint32(at + 4, Math.floor(value / 4294967296), true); };
  for (const entry of entries) {
    const name = strToU8(entry.name), content = deflate ? deflateSync(entry.bytes) : entry.bytes;
    const originalSize = entry.declaredSize ?? entry.bytes.length, crc = crc32(entry.bytes);
    const flags = 2048 | (descriptor ? 8 : 0), method = deflate ? 8 : 0;
    const localExtraLength = zip64Entries ? 20 : 0;
    const local = new Uint8Array(30 + name.length + localExtraLength + content.length + (descriptor ? zip64Entries ? 24 : 16 : 0));
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, zip64Entries ? 45 : 20, true); view.setUint16(6, flags, true); view.setUint16(8, method, true);
    view.setUint32(14, descriptor ? 0 : crc, true);
    view.setUint32(18, zip64Entries ? 0xffffffff : descriptor ? 0 : content.length, true);
    view.setUint32(22, zip64Entries ? 0xffffffff : descriptor ? 0 : originalSize, true);
    view.setUint16(26, name.length, true); view.setUint16(28, localExtraLength, true); local.set(name, 30);
    if (zip64Entries) { const at = 30 + name.length; view.setUint16(at, 1, true); view.setUint16(at + 2, 16, true); put64(view, at + 4, originalSize); put64(view, at + 12, content.length); }
    const dataAt = 30 + name.length + localExtraLength;
    local.set(content, dataAt);
    if (descriptor) {
      const at = dataAt + content.length; view.setUint32(at, 0x08074b50, true); view.setUint32(at + 4, crc, true);
      if (zip64Entries) { put64(view, at + 8, content.length); put64(view, at + 16, originalSize); }
      else { view.setUint32(at + 8, content.length, true); view.setUint32(at + 12, originalSize, true); }
    }
    localParts.push(local);
    const directory = new Uint8Array(46 + name.length + (zip64Entries ? 28 : 0)), cd = new DataView(directory.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 45, true); cd.setUint16(6, zip64Entries ? 45 : 20, true); cd.setUint16(8, flags, true); cd.setUint16(10, method, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, zip64Entries ? 0xffffffff : content.length, true); cd.setUint32(24, zip64Entries ? 0xffffffff : originalSize, true);
    cd.setUint16(28, name.length, true); cd.setUint16(30, zip64Entries ? 28 : 0, true); cd.setUint32(42, zip64Entries ? 0xffffffff : offset, true); directory.set(name, 46);
    if (zip64Entries) { const at = 46 + name.length; cd.setUint16(at, 1, true); cd.setUint16(at + 2, 24, true); put64(cd, at + 4, originalSize); put64(cd, at + 12, content.length); put64(cd, at + 20, offset); }
    directoryParts.push(directory); offset += local.length;
  }
  const size = directoryParts.reduce((sum, part) => sum + part.length, 0), commentBytes = strToU8(comment);
  const end = new Uint8Array((zip64 ? 76 : 0) + 22 + commentBytes.length), finish = new DataView(end.buffer);
  const normal = zip64 ? 76 : 0;
  if (zip64) {
    finish.setUint32(0, 0x06064b50, true); put64(finish, 4, 44); finish.setUint16(12, 45, true); finish.setUint16(14, 45, true);
    put64(finish, 24, entries.length); put64(finish, 32, entries.length); put64(finish, 40, size); put64(finish, 48, offset);
    finish.setUint32(56, 0x07064b50, true); put64(finish, 64, offset + size); finish.setUint32(72, 1, true);
  }
  finish.setUint32(normal, 0x06054b50, true); finish.setUint16(normal + 8, zip64 ? 65535 : entries.length, true); finish.setUint16(normal + 10, zip64 ? 65535 : entries.length, true);
  finish.setUint32(normal + 12, zip64 ? 0xffffffff : size, true); finish.setUint32(normal + 16, zip64 ? 0xffffffff : offset, true); finish.setUint16(normal + 20, commentBytes.length, true); end.set(commentBytes, normal + 22);
  const parts = [...localParts, ...directoryParts, end], result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { result.set(part, at); at += part.length; }
  return result;
}
function mutate(archive, edit) { const bytes = archive.slice(); edit(new DataView(bytes.buffer), bytes); return bytes; }

// This fixture is never sent to the old parser: its enormous count must be rejected structurally.
test('ZIP64 forged and unsafe entry counts are rejected before decompression', () => {
  const normal = archiveFixture(undefined, { zip64: true });
  assert.deepEqual(readDocxDocument(normal), xml);
  const record = normal.length - 98;
  assert.throws(() => inspectDocxArchive(mutate(normal, view => { view.setUint32(record + 24, 0xffffffff, true); view.setUint32(record + 32, 0xffffffff, true); })), /Word/);
  assert.throws(() => inspectDocxArchive(mutate(normal, view => { view.setUint32(record + 28, 0x200000, true); view.setUint32(record + 36, 0x200000, true); })), /Word/);
});

test('ordinary stored/deflated DOCX with comments and irrelevant entries still extract only the document', () => {
  for (const level of [0, 6]) {
    const archive = zipSync({ 'word/document.xml': xml, 'word/media/image1.png': new Uint8Array(1000), '[Content_Types].xml': strToU8('<Types/>') }, { level, comment: 'ordinary archive comment' });
    assert.deepEqual(readDocxDocument(archive), xml);
  }
});

test('ordinary central-directory comments cannot be mistaken for a ZIP64 locator', () => {
  const comment = String.fromCharCode(0x50, 0x4b, 0x06, 0x07) + '\0'.repeat(16);
  const archive = zipSync({ 'word/document.xml': [xml, { comment }] });
  assert.deepEqual(readDocxDocument(archive), xml);
});

test('optional ZIP digital signatures inside/outside directory size remain compatible', () => {
  const original = archiveFixture(), ordinaryEnd = original.length - 22;
  const signature = new Uint8Array([0x50, 0x4b, 0x05, 0x05, 3, 0, 1, 2, 3]);
  for (const declaredInside of [false, true]) {
    const bytes = new Uint8Array(original.length + signature.length);
    bytes.set(original.subarray(0, ordinaryEnd)); bytes.set(signature, ordinaryEnd); bytes.set(original.subarray(ordinaryEnd), ordinaryEnd + signature.length);
    if (declaredInside) { const view = new DataView(bytes.buffer), end = bytes.length - 22; view.setUint32(end + 12, view.getUint32(end + 12, true) + signature.length, true); }
    assert.deepEqual(readDocxDocument(bytes), xml);
  }
});

test('an ordinary digital-signature payload cannot be mistaken for a ZIP64 locator', () => {
  const original = archiveFixture(), ordinaryEnd = original.length - 22;
  const signature = new Uint8Array(26), payload = new DataView(signature.buffer);
  payload.setUint32(0, 0x05054b50, true); payload.setUint16(4, 20, true);
  payload.setUint32(6, 0x07064b50, true); payload.setUint32(6 + 16, 1, true);
  const bytes = new Uint8Array(original.length + signature.length);
  bytes.set(original.subarray(0, ordinaryEnd)); bytes.set(signature, ordinaryEnd);
  bytes.set(original.subarray(ordinaryEnd), ordinaryEnd + signature.length);
  assert.deepEqual(readDocxDocument(bytes), xml);
  // An incomplete declared signature must not hide an invalid locator.
  assert.throws(() => readDocxDocument(mutate(bytes, view => view.setUint16(ordinaryEnd + 4, 19, true))), /Word/);
});

test('small ZIP64 entry metadata and 32/64-bit data descriptors remain supported', () => {
  for (const zip64Entries of [false, true]) for (const descriptor of [false, true]) for (const deflate of [false, true]) {
    assert.deepEqual(readDocxDocument(archiveFixture(undefined, { zip64: true, zip64Entries, descriptor, deflate, comment: 'valid small ZIP64' })), xml);
  }
});

test('directory span, count, ZIP64 record/locator offsets and disk boundaries are checked', () => {
  const ordinary = archiveFixture(), end = ordinary.length - 22;
  for (const edit of [
    view => view.setUint32(end + 16, ordinary.length + 1, true),
    view => view.setUint32(end + 12, ordinary.length + 1, true),
    view => { view.setUint16(end + 8, 2, true); view.setUint16(end + 10, 2, true); },
    view => view.setUint16(end + 4, 1, true),
  ]) assert.throws(() => inspectDocxArchive(mutate(ordinary, edit)), /Word/);
  const zip64 = archiveFixture(undefined, { zip64: true }), locator = zip64.length - 42, record = zip64.length - 98;
  for (const edit of [
    view => view.setUint32(locator + 8, zip64.length, true),
    view => view.setUint32(locator + 12, 0x200000, true),
    view => view.setUint32(locator + 16, 2, true),
    view => view.setUint32(record + 4, 43, true),
    view => view.setUint32(record + 48, 0xffffffff, true),
  ]) assert.throws(() => inspectDocxArchive(mutate(zip64, edit)), /Word/);
  for (const length of [0, 1, 21]) assert.throws(() => inspectDocxArchive(new Uint8Array(length)), /Word/);
});

test('central/local signatures, local spans, names, extra fields and duplicate document entries are checked', () => {
  const archive = archiveFixture(), cd = new DataView(archive.buffer).getUint32(archive.length - 6, true);
  for (const edit of [
    view => view.setUint32(cd, 0, true),
    view => view.setUint32(0, 0, true),
    view => view.setUint32(cd + 42, cd, true),
    view => view.setUint16(26, 65535, true),
    (_view, bytes) => { bytes[30] ^= 1; },
    view => view.setUint16(cd + 10, 99, true),
  ]) assert.throws(() => inspectDocxArchive(mutate(archive, edit)), /Word/);
  const withExtra = archiveFixture(undefined, { zip64: true, zip64Entries: true });
  assert.throws(() => inspectDocxArchive(mutate(withExtra, view => view.setUint16(30 + 'word/document.xml'.length + 2, 65535, true))), /Word/);
  assert.throws(() => inspectDocxArchive(archiveFixture([{ name: 'word/document.xml', bytes: xml }, { name: 'word/document.xml', bytes: xml }])), /Word/);
});

test('the complete 2 MB document boundary is retained without filtering other entries by their decoded size', () => {
  const document = new Uint8Array(MAX_DOCX_DOCUMENT_BYTES).fill(65);
  assert.deepEqual(readDocxDocument(archiveFixture([{ name: 'word/document.xml', bytes: document }], { deflate: true })), document);
  const unrelated = new Uint8Array(MAX_DOCX_DOCUMENT_BYTES + 1);
  assert.deepEqual(readDocxDocument(archiveFixture([{ name: 'word/document.xml', bytes: xml }, { name: 'word/media/image1.png', bytes: unrelated }], { deflate: true })), xml);
});

test('declared and actual XML sizes plus CRC are checked without truncating data', () => {
  assert.throws(() => readDocxDocument(archiveFixture([{ name: 'word/document.xml', bytes: xml, declaredSize: xml.length - 1 }], { deflate: true })), /Word/);
  assert.throws(() => readDocxDocument(archiveFixture([{ name: 'word/document.xml', bytes: xml, declaredSize: xml.length + 1 }], { deflate: true })), /Word/);
  const oversized = new Uint8Array(MAX_DOCX_DOCUMENT_BYTES + 1).fill(65);
  assert.throws(() => inspectDocxArchive(archiveFixture([{ name: 'word/document.xml', bytes: oversized }], { deflate: true })), /文字过多/);
  assert.throws(() => readDocxDocument(archiveFixture([{ name: 'word/document.xml', bytes: oversized, declaredSize: MAX_DOCX_DOCUMENT_BYTES }], { deflate: true })), /Word/);
  const corrupted = archiveFixture(); corrupted[30 + 'word/document.xml'.length] ^= 1;
  assert.throws(() => readDocxDocument(corrupted), /Word/);
});

function installWorker(t, behavior = () => {}) {
  const previous = globalThis.Worker, workers = [];
  globalThis.Worker = class {
    constructor(url, options) { this.url = url; this.options = options; this.terminations = 0; workers.push(this); }
    postMessage(bytes, transfer) { this.bytes = bytes; this.transfer = transfer; behavior(this); }
    terminate() { this.terminations++; }
  };
  t.after(() => { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; });
  return workers;
}
const file = () => new File([archiveFixture()], 'ordinary.docx');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('worker success transfers input and releases worker/listeners exactly once', async t => {
  const workers = installWorker(t, worker => queueMicrotask(() => worker.onmessage({ data: { xml } })));
  const controller = new AbortController();
  assert.deepEqual(await extractDocxXml(file(), controller.signal), xml);
  assert.equal(workers.length, 1); assert.equal(workers[0].options.type, 'module');
  assert.equal(workers[0].transfer[0], workers[0].bytes.buffer); assert.equal(workers[0].terminations, 1);
  assert.equal(workers[0].onmessage, null); controller.abort(); assert.equal(workers[0].terminations, 1);
});

test('aborting a pending import terminates the worker and rejects promptly', async t => {
  const workers = installWorker(t), controller = new AbortController();
  const pending = extractDocxXml(file(), controller.signal); await nextTurn(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(workers[0].terminations, 1);
  const already = new AbortController(); already.abort();
  await assert.rejects(extractDocxXml(file(), already.signal), { name: 'AbortError' }); assert.equal(workers.length, 1);
});

test('worker parse errors, crashes, message errors and malformed results all release resources', async t => {
  for (const behavior of [
    worker => worker.onmessage({ data: { error: 'malformed document' } }),
    worker => worker.onerror({ preventDefault() {} }),
    worker => worker.onmessageerror(),
    worker => worker.onmessage({ data: { xml: new Uint8Array(MAX_DOCX_DOCUMENT_BYTES + 1) } }),
    () => { throw new Error('cannot post'); },
  ]) {
    const workers = installWorker(t, worker => behavior(worker));
    await assert.rejects(extractDocxXml(file(), new AbortController().signal)); assert.equal(workers[0].terminations, 1);
  }
});

test('worker deadline is independently enforced and terminates a nonresponsive worker', async t => {
  const workers = installWorker(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = extractDocxXml(file(), new AbortController().signal); await nextTurn();
  assert.equal(workers.length, 1); t.mock.timers.tick(DOCX_WORKER_TIMEOUT_MS);
  await assert.rejects(pending, /超时/); assert.equal(workers[0].terminations, 1);
});

test('unsupported Workers never fall back to synchronous UI parsing', async t => {
  const previous = globalThis.Worker; delete globalThis.Worker;
  t.after(() => { if (previous !== undefined) globalThis.Worker = previous; });
  await assert.rejects(extractDocxXml(file(), new AbortController().signal), /粘贴正文/);
});
