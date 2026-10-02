import { Inflate } from "fflate";

export const MAX_DOCX_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_DOCX_DOCUMENT_BYTES = 2_000_000;
export const MAX_DOCX_ENTRIES = 4096;
const DOCUMENT_NAME = new TextEncoder().encode("word/document.xml");
const INVALID_DOCX = "Word 文档格式损坏，或压缩结构不受支持。";

function invalid(): never { throw new Error(INVALID_DOCX); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
type DocumentEntry = { offset: number; size: number; originalSize: number; crc: number; method: number };

/** Inspect untrusted ZIP metadata before any entry iteration or decompression. */
export function inspectDocxArchive(bytes: Uint8Array): DocumentEntry {
  if (bytes.length < 22 || bytes.length > MAX_DOCX_ARCHIVE_BYTES) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset: number, length: number, end = bytes.length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > end || length > end - offset) invalid();
  };
  const u16 = (offset: number) => { range(offset, 2); return view.getUint16(offset, true); };
  const u32 = (offset: number) => { range(offset, 4); return view.getUint32(offset, true); };
  const u64 = (offset: number) => {
    const low = u32(offset), high = u32(offset + 4);
    const result = low + high * 4294967296;
    if (!Number.isSafeInteger(result)) invalid();
    return result;
  };
  let end = bytes.length - 22;
  const first = Math.max(0, end - 65535);
  for (; end >= first; end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < first || u16(end + 4) || u16(end + 6)) invalid();
  const shortDiskCount = u16(end + 8), shortCount = u16(end + 10);
  const shortSize = u32(end + 12), shortOffset = u32(end + 16);
  let count = shortCount, size = shortSize, offset = shortOffset, boundary = end;
  const needsZip64 = shortDiskCount === 65535 || shortCount === 65535 || shortSize === 0xffffffff || shortOffset === 0xffffffff;
  const locator = end - 20;
  const ordinaryDirectoryEnd = shortOffset + shortSize;
  // A complete ordinary ZIP digital signature can contain arbitrary payload,
  // including locator bytes at end - 20. Establish its span before interpreting
  // those bytes as ZIP64 metadata. Sentinels still require a real ZIP64 locator.
  const hasOrdinarySignature = !needsZip64 && ordinaryDirectoryEnd + 6 <= end &&
    u32(ordinaryDirectoryEnd) === 0x05054b50 && ordinaryDirectoryEnd + 6 + u16(ordinaryDirectoryEnd + 4) === end;
  const hasZip64 = locator >= 0 && u32(locator) === 0x07064b50 &&
    (needsZip64 || ordinaryDirectoryEnd !== end && !hasOrdinarySignature);
  if (needsZip64 && !hasZip64) invalid();
  if (hasZip64) {
    if (u32(locator + 4) !== 0 || u32(locator + 16) !== 1) invalid();
    const record = u64(locator + 8);
    range(record, 56, locator);
    if (u32(record) !== 0x06064b50) invalid();
    const recordSize = u64(record + 4);
    if (recordSize < 44) invalid();
    range(record, 12 + recordSize, locator);
    if (record + 12 + recordSize !== locator || u32(record + 16) || u32(record + 20)) invalid();
    count = u64(record + 32); size = u64(record + 40); offset = u64(record + 48); boundary = record;
    if (u64(record + 24) !== count || shortDiskCount !== 65535 && shortDiskCount !== count || shortCount !== 65535 && shortCount !== count || shortSize !== 0xffffffff && shortSize !== size || shortOffset !== 0xffffffff && shortOffset !== offset) invalid();
  } else if (shortDiskCount !== count) invalid();
  if (!count || count > MAX_DOCX_ENTRIES || count > Math.floor(size / 46)) invalid();
  range(offset, size, boundary);
  const directoryStart = offset, directoryEnd = offset + size;
  const digitalSignatureEnd = (start: number, limit: number) => {
    range(start, 6, limit);
    if (u32(start) !== 0x05054b50) invalid();
    const length = 6 + u16(start + 4);
    range(start, length, limit);
    if (start + length !== limit) invalid();
    return limit;
  };
  // Apart from an optional ZIP digital signature, the directory is contiguous
  // with its end records. Package signatures inside DOCX are ordinary entries.
  if (directoryEnd !== boundary) digitalSignatureEnd(directoryEnd, boundary);
  let document: DocumentEntry | undefined;
  const localSpans: { start: number; end: number }[] = [];
  const seenLocalOffsets = new Set<number>();

  const extraFields = (start: number, length: number) => {
    range(start, length);
    const limit = start + length;
    let zip64: { start: number; end: number } | undefined;
    while (start < limit) {
      range(start, 4, limit);
      const type = u16(start), fieldLength = u16(start + 2);
      range(start + 4, fieldLength, limit);
      if (type === 1) {
        if (zip64) invalid();
        zip64 = { start: start + 4, end: start + 4 + fieldLength };
      }
      start += 4 + fieldLength;
    }
    return zip64;
  };
  const sizesFromExtra = (start: number, length: number, original: number, compressed: number, local?: number, disk?: number) => {
    const extra = extraFields(start, length);
    let cursor = extra?.start ?? 0;
    const read64 = () => { if (!extra) invalid(); range(cursor, 8, extra.end); const result = u64(cursor); cursor += 8; return result; };
    if (original === 0xffffffff) original = read64();
    if (compressed === 0xffffffff) compressed = read64();
    if (local === 0xffffffff) local = read64();
    if (disk === 65535) { if (!extra) invalid(); range(cursor, 4, extra.end); disk = u32(cursor); }
    return { original, compressed, local, disk };
  };
  const descriptorEnd = (start: number, crc: number, compressed: number, original: number) => {
    for (const prefix of [0, 4]) {
      if (prefix && (start + 4 > directoryStart || u32(start) !== 0x08074b50)) continue;
      const data = start + prefix;
      if (data + 12 <= directoryStart && u32(data) === crc && u32(data + 4) === compressed && u32(data + 8) === original) return data + 12;
      if (data + 20 <= directoryStart && u32(data) === crc && u64(data + 4) === compressed && u64(data + 12) === original) return data + 20;
    }
    invalid();
  };

  for (let index = 0; index < count; index++) {
    range(offset, 46, directoryEnd);
    if (u32(offset) !== 0x02014b50) invalid();
    const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16);
    const nameLength = u16(offset + 28), extraLength = u16(offset + 30), commentLength = u16(offset + 32);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    range(offset, entryLength, directoryEnd);
    if (!nameLength) invalid();
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const metadata = sizesFromExtra(offset + 46 + nameLength, extraLength, u32(offset + 24), u32(offset + 20), u32(offset + 42), u16(offset + 34));
    if (metadata.disk !== 0 || metadata.local === undefined) invalid();
    const local = metadata.local;
    if (seenLocalOffsets.has(local)) invalid();
    seenLocalOffsets.add(local);
    range(local, 30, directoryStart);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) invalid();
    const localNameLength = u16(local + 26), localExtraLength = u16(local + 28);
    const data = local + 30 + localNameLength + localExtraLength;
    range(local, data - local, directoryStart);
    if (!sameBytes(name, bytes.subarray(local + 30, local + 30 + localNameLength))) invalid();
    const localMetadata = sizesFromExtra(local + 30 + localNameLength, localExtraLength, u32(local + 22), u32(local + 18));
    const localCrc = u32(local + 14);
    if (flags & 8) {
      if (localCrc !== 0 && localCrc !== crc || localMetadata.original !== 0 && localMetadata.original !== metadata.original || localMetadata.compressed !== 0 && localMetadata.compressed !== metadata.compressed) invalid();
    } else if (localCrc !== crc || localMetadata.original !== metadata.original || localMetadata.compressed !== metadata.compressed) invalid();
    range(data, metadata.compressed, directoryStart);
    const dataEnd = data + metadata.compressed;
    localSpans.push({ start: local, end: flags & 8 ? descriptorEnd(dataEnd, crc, metadata.compressed, metadata.original) : dataEnd });
    if (sameBytes(name, DOCUMENT_NAME)) {
      if (document || flags & 0x41 || method !== 0 && method !== 8) invalid();
      if (metadata.original > MAX_DOCX_DOCUMENT_BYTES) throw new Error("文档文字过多，请选取需要的部分后重试。");
      if (method === 0 && metadata.original !== metadata.compressed) invalid();
      document = { offset: data, size: metadata.compressed, originalSize: metadata.original, crc, method };
    }
    offset += entryLength;
  }
  if (offset !== directoryEnd) {
    if (directoryEnd !== boundary) invalid();
    offset = digitalSignatureEnd(offset, directoryEnd);
  }
  if (!document) invalid();
  localSpans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localSpans.length; index++) if (localSpans[index - 1].end > localSpans[index].start) invalid();
  return document;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

/** Run in a terminable Worker; compressed chunks also bound temporary output. */
export function readDocxDocument(archive: Uint8Array): Uint8Array {
  const entry = inspectDocxArchive(archive);
  const output = new Uint8Array(entry.originalSize);
  let written = 0, crc = 0xffffffff;
  const consume = (chunk: Uint8Array) => {
    if (chunk.length > MAX_DOCX_DOCUMENT_BYTES - written || chunk.length > output.length - written) invalid();
    output.set(chunk, written); written += chunk.length;
    for (const value of chunk) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ crc >>> 8;
  };
  const compressed = archive.subarray(entry.offset, entry.offset + entry.size);
  if (entry.method === 0) consume(compressed);
  else {
    const inflate = new Inflate(consume);
    for (let offset = 0; offset < compressed.length; offset += 1024) inflate.push(compressed.subarray(offset, offset + 1024), offset + 1024 >= compressed.length);
    if (!compressed.length) invalid();
  }
  if (written !== output.length || (crc ^ 0xffffffff) >>> 0 !== entry.crc) invalid();
  return output;
}
