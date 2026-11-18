import { decodeLexiconIndex } from "../lexicon-index-codec.mjs";
import type { LexiconIndexEntry } from "../lexicon";
import { AssistantInputError } from "./core";

type AssetReader = { fetch(request: Request): Promise<Response> };

// The binding identifies this deployment's public asset set. Cache completed
// plain data only: Cloudflare streams and in-flight I/O belong to one request.
const indexes = new WeakMap<AssetReader, LexiconIndexEntry[]>();

export async function loadReleaseIndex(assets: AssetReader | undefined, request: Request, errorCode = "unavailable") {
  const fail = () => new AssistantInputError(errorCode, "正式词库暂时无法读取。", 503);
  if (!assets) throw fail();
  const cached = indexes.get(assets);
  if (cached) return cached;
  const response = await assets.fetch(new Request(new URL("/data/v1/index.json", request.url)));
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw fail();
  }
  try {
    const rows = decodeLexiconIndex(await response.json()) as LexiconIndexEntry[];
    indexes.set(assets, rows);
    return rows;
  } catch {
    throw new AssistantInputError(errorCode, "正式词库格式无效。", 503);
  }
}
