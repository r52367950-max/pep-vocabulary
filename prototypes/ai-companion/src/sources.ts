/**
 * Sources the learner adds to a message. Text files are read in this tab; images and PDF/DOCX
 * stay attachments whose content is never inspected, because OCR, vision and document parsing
 * are not connected in the prototype. Contents live in memory only and are never persisted.
 */
export type AttachmentKind = "image" | "text" | "document";
export type AttachmentStatus = "reading" | "read" | "attached" | "error";
export type Attachment = {
  id: string; name: string; kind: AttachmentKind; size: number;
  status: AttachmentStatus; chars?: number; truncated?: boolean; error?: string;
  /** Object URL for an image preview in this tab; dropped when saved. */
  previewUrl?: string;
};

export const LIMITS = { count: 6, imageBytes: 10 * 1024 * 1024, textBytes: 2 * 1024 * 1024, documentBytes: 20 * 1024 * 1024, readChars: 20_000 };

const TEXT_EXT = /\.(txt|md|markdown|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
const DOC_EXT = /\.(pdf|docx)$/i;

export type FileCheck = { ok: true; kind: AttachmentKind } | { ok: false; message: string };

export function checkFile(name: string, mime: string, size: number, existing: number): FileCheck {
  if (existing >= LIMITS.count) return { ok: false, message: `每条消息最多 ${LIMITS.count} 个附件。` };
  const kind: AttachmentKind | null = mime.startsWith("image/") || IMAGE_EXT.test(name) ? "image"
    : TEXT_EXT.test(name) || mime === "text/plain" || mime === "text/markdown" || mime === "text/csv" ? "text"
      : DOC_EXT.test(name) ? "document" : null;
  if (!kind) {
    const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
    return { ok: false, message: `${ext ? `.${ext} ` : ""}文件暂不支持。可以添加图片（PNG、JPG、WebP）、文本（TXT、MD、CSV）或 PDF、DOCX。` };
  }
  const limit = kind === "image" ? LIMITS.imageBytes : kind === "text" ? LIMITS.textBytes : LIMITS.documentBytes;
  if (size > limit) return { ok: false, message: `「${name}」有 ${formatBytes(size)}，超过 ${formatBytes(limit)} 的上限。` };
  if (size === 0) return { ok: false, message: `「${name}」是空文件。` };
  return { ok: true, kind };
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Decodes UTF-8 text; refuses binary content and keeps the first LIMITS.readChars characters. */
export function decodeText(bytes: Uint8Array): { ok: true; text: string; chars: number; truncated: boolean } | { ok: false; message: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Regex escapes stay escapes in the bundle, so no raw control or replacement character is emitted.
  if (/\u0000/.test(text)) return { ok: false, message: "文件看起来不是纯文本，无法读取。" };
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > Math.max(8, text.length / 50)) return { ok: false, message: "文件不是 UTF-8 编码的文本，无法读取。" };
  const chars = [...text].length;
  const truncated = chars > LIMITS.readChars;
  return { ok: true, text: truncated ? [...text].slice(0, LIMITS.readChars).join("") : text, chars, truncated };
}

export function statusLabel(attachment: Pick<Attachment, "kind" | "status" | "chars" | "truncated" | "error">) {
  if (attachment.status === "reading") return "读取中…";
  if (attachment.status === "error") return attachment.error ?? "读取失败";
  if (attachment.status === "read") {
    return attachment.truncated ? `已读取前 ${LIMITS.readChars.toLocaleString("zh-CN")} 字` : `已读取 ${(attachment.chars ?? 0).toLocaleString("zh-CN")} 字`;
  }
  return attachment.kind === "image" ? "仅附件 · 未识别图片内容" : "仅附件 · 未解析文档";
}

export function statusDetail(attachment: Pick<Attachment, "kind" | "status">) {
  if (attachment.status === "read") return "文字已在本机读取，发送时作为这条消息的内容。不会写入浏览器存储。";
  if (attachment.status === "attached" && attachment.kind === "image") return "原型没有接入 OCR 或视觉模型，不会看图片内容；发送后只记录文件名、类型和大小。";
  if (attachment.status === "attached") return "原型没有接入 PDF/DOCX 解析，不会读取其中的文字；发送后只记录文件名、类型和大小。";
  return "";
}

/** In-memory contents keyed by attachment id. Never serialized. */
const contents = new Map<string, string>();
export const attachmentText = {
  get: (id: string) => contents.get(id),
  set: (id: string, text: string) => { contents.set(id, text); },
  drop(attachment: Attachment) {
    contents.delete(attachment.id);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  },
};

/** English words in a learner's text file, for a dictation built from their own list. */
export function wordsFromText(text: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]{1,30}/g)) {
    const word = match[0].replace(/^'+|'+$/g, "");
    const key = word.toLowerCase();
    if (seen.has(key) || word.length < 3) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}
