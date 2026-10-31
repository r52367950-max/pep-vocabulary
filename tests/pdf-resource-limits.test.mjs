import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { configurePdfResourceBudget, pdfResourceBudget, checkedPdfAllocation } from '../public/vendor/pdfjs-5.6.205/resource-budget.mjs';
import { PdfTextBudget, readBoundedPdfText } from '../lib/pdf-import.ts';

// Text extraction needs no canvas; keep the optional Node canvas package out of
// this test while exercising the shipped PDF.js parser, not a mock decoder.
globalThis.DOMMatrix ??= class DOMMatrix {};
const pdfjs = await import('../public/vendor/pdfjs-5.6.205/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../public/vendor/pdfjs-5.6.205/pdf.worker.mjs', import.meta.url).href;

function textPdf(contents, filter = 'FlateDecode') {
  const bodies = contents.map(text => (filter === 'BrotliDecode' ? brotliCompressSync : deflateSync)(Buffer.from(text)));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents [${bodies.map((_, i) => `${i + 5} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...bodies.map(bytes => Buffer.concat([Buffer.from(`<< /Length ${bytes.length} /Filter /${filter} >>\nstream\n`), bytes, Buffer.from('\nendstream')]))
  ];
  const chunks = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(objects[i]), Buffer.from('\nendobj\n'));
  }
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

async function extract(bytes, options = {}) {
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, stopAtErrors: true, ...options });
  try {
    const doc = await task.promise;
    const content = await (await doc.getPage(1)).getTextContent();
    await doc.checkResourceBudget();
    return content;
  } finally { await task.destroy(); }
}

test('shipped parser rejects a small compressed stream before decoded growth exceeds its budget', async () => {
  const pdf = textPdf(['BT /F1 12 Tf 72 720 Td (Alpha learns English.) Tj ET\n'.repeat(600)]);
  assert.ok(pdf.length < 2000);
  await assert.rejects(extract(pdf, { maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 8192 }), /PDF resource limit/);
});

test('decoded budget is cumulative across individually valid content streams', async () => {
  const text = 'BT /F1 12 Tf 72 720 Td (Alpha learns English.) Tj ET\n'.repeat(30);
  await assert.rejects(extract(textPdf([text, text, text]), { maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 4096 }), /PDF resource limit/);
});

test('ordinary text PDF remains readable with parser budgets', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../public/qa-fixtures/reading.pdf', import.meta.url)));
  const content = await extract(bytes, { maxDecodedStreamBytes: 64 * 1024 * 1024, maxDecodedDocumentBytes: 256 * 1024 * 1024 });
  assert.ok(content.items.some(item => typeof item.str === 'string' && /reader|Reading|reading/.test(item.str)));
});

test('synchronous Brotli fallback also stops at the decoded budget', async () => {
  const text = 'BT /F1 12 Tf 72 720 Td (Alpha learns English.) Tj ET\n'.repeat(2000);
  await assert.rejects(extract(textPdf([text], 'BrotliDecode'), { maxDecodedStreamBytes: 32 * 1024, maxDecodedDocumentBytes: 256 * 1024 }), /PDF resource limit/);
});

const vendor = await readFile(new URL('../public/vendor/pdfjs-5.6.205/pdf.worker.mjs', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = vendor.indexOf(start), to = vendor.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return vendor.slice(from, to);
}
class ByteStream {
  constructor(bytes, start = 0) { this.bytes = bytes; this.pos = start; this.isAsync = false; }
  getByte() { return this.bytes[this.pos++] ?? -1; }
  getBytes(length) { const from = this.pos; this.pos = length ? Math.min(from + length, this.bytes.length) : this.bytes.length; return this.bytes.subarray(from, this.pos); }
  reset() { this.pos = 0; }
}
// Execute the exact shipped decoder classes to reach the image fast-path choice.
// Node getTextContent only reaches their synchronous parse paths.
let nativeDecoderStarted = false;
const FlateStream = vm.runInNewContext(`${sourceBetween('const emptyBuffer =', 'class StreamsSequenceStream')}
${sourceBetween('const codeLenCodeMap =', ';// ./src/core/jbig2_stream.js')}
FlateStream`, { BaseStream: class {}, Stream: ByteStream, FormatError: class extends Error {}, DecompressionStream: class { constructor() { nativeDecoderStarted = true; throw new Error('native decoder must not start'); } }, pdfResourceBudget });

test('budgeted Flate avoids eager native expansion and resource failure stays terminal', async () => {
  configurePdfResourceBudget({ maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 8192 });
  nativeDecoderStarted = false;
  const decoder = new FlateStream(new ByteStream(deflateSync(Buffer.alloc(16 * 1024, 65))));
  await assert.rejects(decoder.getImageData(16 * 1024), /PDF resource limit/);
  assert.equal(nativeDecoderStarted, false);
  assert.throws(() => decoder.getBytes(), /PDF resource limit/);
});

test('Flate image control keeps the decoded bytes unchanged through guarded fallback', async () => {
  configurePdfResourceBudget({ maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 8192 });
  const expected = Buffer.from('A reader learns English by reading a small ordinary PDF.');
  const decoder = new FlateStream(new ByteStream(deflateSync(expected)));
  assert.deepEqual(Buffer.from(await decoder.getImageData(expected.length)), expected);
});

test('CCITT fallback checks a requested direct buffer before constructing its decoder', () => {
  configurePdfResourceBudget({ maxDecodedStreamBytes: 1024, maxDecodedDocumentBytes: 2048 });
  let started = false;
  class Dict { static empty = { get: () => null }; }
  const CCITTFaxStream = vm.runInNewContext(`${sourceBetween('const emptyBuffer =', 'class StreamsSequenceStream')}
${sourceBetween('class CCITTFaxStream', ';// ./src/core/flate_stream.js')}
CCITTFaxStream`, { BaseStream: class {}, Stream: ByteStream, Dict, pdfResourceBudget, CCITTFaxDecoder: class { constructor() { started = true; } } });
  const decoder = new CCITTFaxStream(new ByteStream(new Uint8Array([0])), 1);
  assert.throws(() => decoder.decodeImageFallback(new Uint8Array([0]), 4096), /PDF resource limit/);
  assert.equal(started, false);
});

test('JPEG coefficient buffers are checked before allocation using codestream dimensions', () => {
  configurePdfResourceBudget({ maxDecodedStreamBytes: 1024, maxDecodedDocumentBytes: 2048 });
  const prepareComponents = vm.runInNewContext(`${sourceBetween('function prepareComponents(frame)', 'function readDataBlock(')}prepareComponents`, { pdfResourceBudget, checkedPdfAllocation });
  const frame = { samplesPerLine: 64, scanLines: 64, maxH: 1, maxV: 1, components: [{ h: 1, v: 1 }] };
  assert.throws(() => prepareComponents(frame), /PDF resource limit/);
  assert.equal(frame.components[0].blockData, undefined);
});

test('OpenJPEG JS fallback checks its heap before allocation and still supports ordinary allocation', async () => {
  const { default: OpenJPEG } = await import('../public/vendor/pdfjs-5.6.205/wasm/openjpeg_nowasm_fallback.js');
  configurePdfResourceBudget({ maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 8192 });
  await assert.rejects(OpenJPEG(), /PDF resource limit/);
  configurePdfResourceBudget({ maxDecodedStreamBytes: 64 * 1024 * 1024, maxDecodedDocumentBytes: 256 * 1024 * 1024 });
  const codec = await OpenJPEG();
  const pointer = codec._malloc(32);
  assert.ok(pointer > 0);
  codec._free(pointer);
});

test('native JPEG frames count against the cumulative budget before decoding', () => {
  const method = vm.runInNewContext(`({${sourceBetween('  static canUseImageDecoder(data, colorTransform = -1)', '  parse(data, {').replace('static ', '')}}).canUseImageDecoder`, { pdfResourceBudget, checkedPdfAllocation, readUint16: (bytes, offset) => bytes[offset] << 8 | bytes[offset + 1] });
  const budget = configurePdfResourceBudget({ maxDecodedStreamBytes: 4096, maxDecodedDocumentBytes: 1024 });
  const header = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 0, 16, 0, 16, 3]);
  assert.ok(method(header));
  assert.equal(budget.allocated, 1024);
  assert.throws(() => method(header), /PDF resource limit/);
});

test('asynchronous image failure remains visible after operator-list completion', async () => {
  const budget = configurePdfResourceBudget({ maxDecodedStreamBytes: 1024, maxDecodedDocumentBytes: 4096 });
  let sent;
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const method = vm.runInNewContext(`({${sourceBetween('  async buildPaintImageXObject({', '  handleSMask(')}}).buildPaintImageXObject`, {
    PDFImage: { buildImage: async () => ({ createImageData: async () => { await new Promise(resolve => setTimeout(resolve, 5)); checkedPdfAllocation(2048); return {}; } }) },
    OPS: { paintImageXObject: 1 }, warn: () => {}, assert: () => {}, pdfResourceBudget
  });
  const owner = { options: { maxImageSize: 40_000_000, ignoreErrors: false, isOffscreenCanvasSupported: false }, idFactory: { createObjId: () => 'small-budget-test' }, globalImageCache: {}, _sendImgData: (_id, image) => { sent = image; finish(); } };
  const dict = { get: key => ({ W: 1, Width: 1, H: 1, Height: 1 }[key]), has: () => false };
  try {
    await method.call(owner, { image: { dict }, operatorList: { addDependency() {}, addImageOps() {} } });
    budget.check(); // Operator-list completion alone is deliberately too early.
    await assert.rejects(() => budget.waitForPending(), /PDF resource limit/);
    assert.equal(sent, null); // The third-party fallback cannot erase the latch.
  } finally { await completed; }
});

function chunkPage(chunks, onCancel = () => {}) {
  return { streamTextContent: () => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); }, cancel: onCancel }) };
}
test('text chunks stop before item, character, style or word accumulation exceeds limits', async () => {
  const cases = [
    { items: Array.from({ length: 24_001 }, () => ({ str: '' })) },
    { items: [{ str: 'x'.repeat(120_001) }] },
    { items: [], styles: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`font-${i}`, {}])) },
    { items: [{ str: 'word '.repeat(6001) }] }
  ];
  for (const chunk of cases) {
    let cancelled = false;
    await assert.rejects(readBoundedPdfText(chunkPage([chunk], () => { cancelled = true; }), new PdfTextBudget(), new AbortController().signal), /文字过多/);
    assert.equal(cancelled, true);
  }
});

test('text resource limits apply across pages', async () => {
  const budget = new PdfTextBudget();
  const page = { streamTextContent: () => new ReadableStream({ start(c) { c.enqueue({ items: [{ str: 'word '.repeat(3500) }] }); c.close(); } }) };
  await readBoundedPdfText(page, budget, new AbortController().signal);
  await assert.rejects(readBoundedPdfText(page, budget, new AbortController().signal), /文字过多/);
});

test('cancelling a pending text read settles promptly and cancels the source', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const operation = readBoundedPdfText(chunkPage([], () => { cancelled = true; }), new PdfTextBudget(), controller.signal);
  controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('ordinary streamed text and layout attributes are preserved', async () => {
  const item = { str: 'A reader learns English.', transform: [12, 0, 0, 12, 72, 720], width: 130, height: 12, hasEOL: true };
  const page = { streamTextContent: () => new ReadableStream({ start(c) { c.enqueue({ items: [item], styles: { f1: {} } }); c.close(); } }) };
  assert.deepEqual(await readBoundedPdfText(page, new PdfTextBudget(), new AbortController().signal), [item]);
});
