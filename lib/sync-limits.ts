// Cloudflare D1 caps each string/BLOB/table row at 2,000,000 bytes. The payload
// leaves room for identity, revision, timestamps and SQLite record overhead.
// https://developers.cloudflare.com/d1/platform/limits/ (checked 2026-10-31)
export const MAX_SYNC_PAYLOAD_BYTES = 1_900_000;
export const MAX_SYNC_REQUEST_BYTES = MAX_SYNC_PAYLOAD_BYTES + 4096;
export const SYNC_TOO_LARGE_MESSAGE = "云端备份最多支持 1.9 MB（1,900,000 字节）。本机学习记录仍然保留；请使用“导出学习备份”保存 JSON 文件。";

export function assertSyncPayloadFits(serializedPayload: string) {
  if (new TextEncoder().encode(serializedPayload).byteLength > MAX_SYNC_PAYLOAD_BYTES) throw new Error(SYNC_TOO_LARGE_MESSAGE);
}
