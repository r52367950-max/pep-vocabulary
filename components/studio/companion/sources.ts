/**
 * Sources the learner adds to a message. Raw content remains in this tab and is never persisted.
 */
import { CHAT_LIMITS } from "@/lib/assistant/chat-contract";

export type AttachmentKind = "image" | "text" | "document";
export type AttachmentStatus = "reading" | "read" | "attached" | "error";
export type Attachment = {
  id: string; name: string; kind: AttachmentKind; size: number;
  status: AttachmentStatus; chars?: number; truncated?: boolean; error?: string;
  /** Object URL for an image preview in this tab; dropped when saved. */
  previewUrl?: string;
};

export const LIMITS = { count: 4, imageBytes: 10 * 1024 * 1024, textBytes: 2 * 1024 * 1024, documentBytes: 12 * 1024 * 1024, readChars: CHAT_LIMITS.fileChars };

const TEXT_EXT = /\.(txt|md|markdown|csv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
const DOC_EXT = /\.(pdf|docx)$/i;

export type FileCheck = { ok: true; kind: AttachmentKind } | { ok: false; message: string };

export function checkFile(name: string, mime: string, size: number, existing: number): FileCheck {
  if (existing >= LIMITS.count) return { ok: false, message: `每条消息最多 ${LIMITS.count} 个附件。` };
  const kind: AttachmentKind | null = (new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]).has(mime) || IMAGE_EXT.test(name)) ? "image"
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

/** Match the request's UTF-16 limit without cutting a Unicode surrogate pair or expanding the whole file. */
function boundedAttachmentText(source: string) {
  let end = Math.min(source.length, LIMITS.readChars);
  if (end < source.length && source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff && source.charCodeAt(end) >= 0xdc00 && source.charCodeAt(end) <= 0xdfff) end--;
  const text = source.slice(0, end);
  let chars = 0;
  for (let index = 0; index < text.length; index++, chars++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) index++;
  }
  return { ok: true as const, text, chars, truncated: end < source.length };
}

/** Decodes UTF-8 text; refuses binary content and keeps a request-sized prefix. */
export function decodeText(bytes: Uint8Array): { ok: true; text: string; chars: number; truncated: boolean } | { ok: false; message: string } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, message: "请使用 UTF-8 编码的文本。" }; }
  // Regex escapes stay escapes in the bundle, so no raw control or replacement character is emitted.
  if (/\u0000/.test(text)) return { ok: false, message: "文件看起来不是纯文本，无法读取。" };
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > Math.max(8, text.length / 50)) return { ok: false, message: "文件不是 UTF-8 编码的文本，无法读取。" };
  return boundedAttachmentText(text);
}

export function statusLabel(attachment: Pick<Attachment, "kind" | "status" | "chars" | "truncated" | "error">) {
  if (attachment.status === "reading") return "读取中…";
  if (attachment.status === "error") return attachment.error ?? "读取失败";
  if (attachment.status === "read") {
    return attachment.truncated ? `已读取前 ${(attachment.chars ?? LIMITS.readChars).toLocaleString("zh-CN")} 字` : `已读取 ${(attachment.chars ?? 0).toLocaleString("zh-CN")} 字`;
  }
  return "仅附件";
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

/** Reuse bounded local document/OCR import; load decoders only when a file is attached. */
export async function readAttachment(file: File, kind: AttachmentKind, signal: AbortSignal) {
  signal.throwIfAborted();
  if (kind === "text") {
    const decoded = decodeText(new Uint8Array(await file.arrayBuffer()));
    signal.throwIfAborted();
    if (!decoded.ok) throw new Error(decoded.message);
    return decoded;
  }
  const { extractReadingFile } = await import("@/lib/reading-import");
  const text = await extractReadingFile(file, signal, () => undefined);
  signal.throwIfAborted();
  if (!text.trim()) throw new Error("没有提取到文字，请换一份清晰的文件。");
  return boundedAttachmentText(text);
}
