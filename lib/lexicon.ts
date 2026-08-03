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
const detailCache = new Map<string, LexiconDetail>();
const chunkCache = new Set<number>();

export async function loadLexicon() {
  if (indexCache && manifestCache) return { index: indexCache, manifest: manifestCache };
  const [indexResponse, manifestResponse] = await Promise.all([
    fetch("/data/v1/index.json"),
    fetch("/data/v1/manifest.json"),
  ]);
  if (!indexResponse.ok || !manifestResponse.ok) throw new Error("词库索引暂时无法读取");
  indexCache = (await indexResponse.json()) as LexiconIndexEntry[];
  manifestCache = (await manifestResponse.json()) as LexiconManifest;
  return { index: indexCache, manifest: manifestCache };
}

export async function loadDetails(ids: string[]) {
  const { index, manifest } = await loadLexicon();
  const neededChunks = new Set<number>();
  for (const id of ids) {
    if (detailCache.has(id)) continue;
    const position = index.findIndex((entry) => entry.id === id);
    if (position >= 0) neededChunks.add(Math.floor(position / 180));
  }
  await Promise.all([...neededChunks].map(async (chunkIndex) => {
    if (chunkCache.has(chunkIndex)) return;
    const descriptor = manifest.chunks[chunkIndex];
    if (!descriptor) return;
    const response = await fetch(`/data/v1/${descriptor.file}`);
    if (!response.ok) throw new Error("词条详情分片暂时无法读取");
    const rows = (await response.json()) as LexiconDetail[];
    rows.forEach((row) => detailCache.set(row.id, row));
    chunkCache.add(chunkIndex);
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
