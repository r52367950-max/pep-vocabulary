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

let lexiconPromise: Promise<{ index: LexiconIndexEntry[]; manifest: LexiconManifest }> | null = null;
const detailCache = new Map<string, LexiconDetail>();
const chunkPromises = new Map<number, Promise<void>>();
const chunkById = new Map<string, number>();

export function loadLexicon() {
  if (lexiconPromise) return lexiconPromise;
  lexiconPromise = (async () => {
    const [indexResponse, manifestResponse] = await Promise.all([
      fetch("/data/v1/index.json"), fetch("/data/v1/manifest.json"),
    ]);
    if (!indexResponse.ok || !manifestResponse.ok) throw new Error("词库索引暂时无法读取");
    const index = await indexResponse.json() as LexiconIndexEntry[];
    const manifest = await manifestResponse.json() as LexiconManifest;
    if (!Array.isArray(index) || !Array.isArray(manifest.chunks)) throw new Error("词库格式无效");
    let position = 0;
    chunkById.clear();
    manifest.chunks.forEach((descriptor, chunk) => {
      if (!Number.isInteger(descriptor.count) || descriptor.count < 1 || !/^chunks\/[a-zA-Z0-9_-]+\.json$/.test(descriptor.file)) throw new Error("词库分片描述无效");
      for (let offset = 0; offset < descriptor.count; offset++) {
        const row = index[position++];
        if (!row || chunkById.has(row.id)) throw new Error("词库索引与分片不一致");
        chunkById.set(row.id, chunk);
      }
    });
    if (position !== index.length) throw new Error("词库索引与分片数量不一致");
    return { index, manifest };
  })().catch((error) => { lexiconPromise = null; chunkById.clear(); throw error; });
  return lexiconPromise;
}

export async function loadDetails(ids: string[]) {
  const { manifest } = await loadLexicon();
  const needed = new Set(ids.filter((id) => !detailCache.has(id)).map((id) => chunkById.get(id)).filter((chunk) => chunk !== undefined));
  await Promise.all([...needed].map((chunk) => {
    if (!chunkPromises.has(chunk)) {
      const descriptor = manifest.chunks[chunk];
      const promise = (async () => {
        const response = await fetch(`/data/v1/${descriptor.file}`);
        if (!response.ok) throw new Error("词条详情分片暂时无法读取");
        const rows = await response.json() as LexiconDetail[];
        if (!Array.isArray(rows) || rows.length !== descriptor.count || new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => chunkById.get(row.id) !== chunk)) throw new Error("词条详情分片与索引不一致");
        rows.forEach((row) => detailCache.set(row.id, row));
      })().catch((error) => { chunkPromises.delete(chunk); throw error; });
      chunkPromises.set(chunk, promise);
    }
    return chunkPromises.get(chunk)!;
  }));
  return ids.map((id) => detailCache.get(id)).filter((row): row is LexiconDetail => Boolean(row));
}

export function matchesLexiconQuery(entry: LexiconIndexEntry, query: string) {
  const normalized = query.normalize("NFKC").trim().toLowerCase();
  const prefix = normalized.replace(/[^a-z]/g, "");
  return !normalized || `${entry.headword} ${entry.lookup} ${entry.chineseCore}`.toLowerCase().includes(normalized) ||
    (Boolean(prefix) && entry.headword.toLowerCase().startsWith(prefix));
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
