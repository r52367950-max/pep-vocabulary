/** Inspect dimensions before asking the browser to allocate decoded pixels. */
export function imageDimensions(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30) return null;
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return [view.getUint32(16), view.getUint32(20)];
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return view.getUint32(14, true) === 12 ? [view.getUint16(18, true), view.getUint16(20, true)] : [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))];
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    if (chunk === 0x5650384c && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)]; }
    if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  return null;
}
const MAX_PHOTO_PIXELS = 25_000_000;
function assertPixelBudget(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || Math.max(width, height) > 8192 || width * height > MAX_PHOTO_PIXELS) throw new Error("图片尺寸过大，请先裁剪到答题区域（最多 2,500 万像素）。");
}
/** Reject animation and oversized dimensions before native decoder allocation. */
export async function inspectPhoto(file: Blob): Promise<[number, number]> {
  if (!file.size || file.size > 30 * 1024 * 1024) throw new Error("请选择 30 MB 以内的非空 JPG、PNG 或 WebP 照片。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimensions = imageDimensions(bytes);
  if (!dimensions) throw new Error("图片格式无法读取，请另存为 JPG、PNG 或 WebP 后重试。");
  assertPixelBudget(...dimensions);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (view.getUint32(0) === 0x89504e47) {
    if (tag(12) !== "IHDR" || view.getUint32(8) !== 13) throw new Error("PNG 格式损坏。");
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), kind = tag(offset + 4);
      if (offset + size + 12 > bytes.length || kind === "acTL" || kind === "fcTL" || kind === "fdAT") throw new Error("请选择完整的静态照片，暂不支持动画图片。");
      offset += size + 12;
      if (kind === "IEND") { end = true; break; }
    }
    if (!end) throw new Error("PNG 格式损坏。");
  } else if (tag(0) === "RIFF" && tag(8) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error("WebP 格式损坏。");
    let images = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = tag(offset), size = view.getUint32(offset + 4, true);
      if (offset + 8 + size + (size % 2) > bytes.length) throw new Error("WebP 格式损坏。");
      if (kind === "ANIM" || kind === "ANMF" || kind === "VP8X" && (bytes[offset + 8] & 2)) throw new Error("请选择静态照片，暂不支持动画图片。");
      if (kind === "VP8 " || kind === "VP8L") {
        if (++images !== 1 || size < (kind === "VP8 " ? 10 : 5)) throw new Error("WebP 格式损坏。");
        const start = offset + 8;
        let coded: [number, number];
        if (kind === "VP8L") {
          if (bytes[start] !== 0x2f) throw new Error("WebP 格式损坏。");
          const bits = view.getUint32(start + 1, true);
          coded = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
        } else {
          if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) throw new Error("WebP 格式损坏。");
          coded = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
        }
        assertPixelBudget(...coded);
        if (coded[0] !== dimensions[0] || coded[1] !== dimensions[1]) throw new Error("WebP 尺寸信息不一致。");
      }
      offset += 8 + size + (size % 2);
    }
    if (images !== 1) throw new Error("WebP 格式损坏。");
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Multi-picture JPEGs carry an MPF directory before their scan data.
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) throw new Error("JPEG 格式损坏。");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) throw new Error("JPEG 格式损坏。");
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) throw new Error("JPEG 格式损坏。");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) throw new Error("JPEG 格式损坏。");
        assertPixelBudget(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      if (marker === 0xe2 && tag(offset + 2) === "MPF\0") throw new Error("请选择单张照片。");
      offset += size;
    }
  } else throw new Error("请使用 JPG、PNG 或 WebP 照片。");
  return dimensions;
}

/** Re-encode locally: discard metadata and enforce both pixel and transport budgets. */
export async function compressDictationPhoto(file: Blob): Promise<Blob> {
  if (file.size > 30 * 1024 * 1024) throw new Error("原图过大，请选择 30 MB 以内的照片。");
  await inspectPhoto(file);
  // Native decoding applies EXIF orientation; scale its oriented dimensions.
  const bitmap = await createImageBitmap(file);
  try {
    assertPixelBudget(bitmap.width, bitmap.height);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height), Math.sqrt(4_000_000 / (bitmap.width * bitmap.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法处理这张照片。");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.88, .75, .6, .45]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= 2_000_000) return blob;
    }
    throw new Error("照片压缩后仍过大，请裁剪到答题区域再试。");
  } finally { bitmap.close(); }
}
