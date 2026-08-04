export type Scope =
  | "middle-core"
  | "high-required"
  | "high-selective"
  | "curriculum-not-textbook"
  | "gaokao-supplement"
  | "common-supplement";

export type SourcePosition = {
  bookId: string;
  volume: string;
  unit: string;
  printedPage: number | null;
  physicalPage?: number | null;
  status?: string;
  curriculumLevel?: string | null;
};

export type LexiconIndexEntry = {
  id: string;
  headword: string;
  lookup: string;
  tier: "A" | "B" | "C";
  scopes: Scope[];
  chineseCore: string;
  britishIpa: string;
  americanIpa: string;
  partsOfSpeech: string[];
  sources: SourcePosition[];
  flags: {
    highFrequencyContinuation: boolean;
    highValue: boolean;
    properName: boolean;
    formalReleaseEligible: boolean;
  };
};

export type LexiconDetail = LexiconIndexEntry & {
  schemaVersion: string;
  kind: "word" | "phrase" | "proper-name";
  variants: string[];
  pronunciation: { mode: string; label: string; source: string };
  grammar: { countability: string | null; transitivity: string | null };
  englishCore: string | null;
  openExample: string | null;
  relations: { family: string[]; phrases: string[]; confusables: string[] };
  license: Record<string, string | null>;
  fieldStatus: Record<string, string>;
};

export type LexiconManifest = {
  version: string;
  generatedAt: string;
  releasedEntries: number;
  middleEntries: number;
  highRequiredEntries: number;
  highSelectiveEntries: number;
  curriculumNotTextbookEntries: number;
  chunks: Array<{ file: string; count: number }>;
};

let indexCache: LexiconIndexEntry[] | null = null;
let manifestCache: LexiconManifest | null = null;
let lexiconPromise: Promise<{ index: LexiconIndexEntry[]; manifest: LexiconManifest }> | null = null;
let indexPositionCache: Map<string, number> | null = null;
const detailCache = new Map<string, LexiconDetail>();
const chunkCache = new Set<number>();
const chunkPromises = new Map<number, Promise<void>>();

export async function loadLexicon() {
  if (indexCache && manifestCache) return { index: indexCache, manifest: manifestCache };
  if (lexiconPromise) return lexiconPromise;
  lexiconPromise = (async () => {
    const [indexResponse, manifestResponse] = await Promise.all([
      fetch("/data/v1/index.json", { cache: "force-cache" }),
      fetch("/data/v1/manifest.json", { cache: "force-cache" }),
    ]);
    if (!indexResponse.ok || !manifestResponse.ok) throw new Error("词库索引暂时无法读取");
    const index = (await indexResponse.json()) as LexiconIndexEntry[];
    const manifest = (await manifestResponse.json()) as LexiconManifest;
    indexCache = index;
    manifestCache = manifest;
    indexPositionCache = new Map(index.map((entry, position) => [entry.id, position]));
    return { index, manifest };
  })().catch((error) => {
    lexiconPromise = null;
    throw error;
  });
  return lexiconPromise;
}

export async function loadDetails(ids: string[]) {
  const { index, manifest } = await loadLexicon();
  const neededChunks = new Set<number>();
  for (const id of ids) {
    if (detailCache.has(id)) continue;
    const position = indexPositionCache?.get(id) ?? index.findIndex((entry) => entry.id === id);
    if (position >= 0) neededChunks.add(Math.floor(position / 180));
  }
  await Promise.all([...neededChunks].map(async (chunkIndex) => {
    if (chunkCache.has(chunkIndex)) return;
    const pending = chunkPromises.get(chunkIndex);
    if (pending) return pending;
    const descriptor = manifest.chunks[chunkIndex];
    if (!descriptor) return;
    const promise = (async () => {
      const response = await fetch(`/data/v1/${descriptor.file}`, { cache: "force-cache" });
      if (!response.ok) throw new Error("词条详情分片暂时无法读取");
      const rows = (await response.json()) as LexiconDetail[];
      rows.forEach((row) => detailCache.set(row.id, row));
      chunkCache.add(chunkIndex);
    })().finally(() => chunkPromises.delete(chunkIndex));
    chunkPromises.set(chunkIndex, promise);
    return promise;
  }));
  return ids.map((id) => detailCache.get(id)).filter(Boolean) as LexiconDetail[];
}

export function speakSystem(text: string, locale = "en-US") {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  utterance.rate = 0.86;
  window.speechSynthesis.speak(utterance);
  return true;
}
