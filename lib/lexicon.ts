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
  /** A few source rows carry { source, text } instead of a sentence; readers must check for a string. */
  openExample: string | { source: string; text: string } | null;
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

// Older releases converted NAmE (a regional label) as though it were IPA.
// Repair the display boundary without rewriting source evidence or inventing
// a complete pronunciation from a textbook's abbreviated form.
export function normalizePronunciations<T extends LexiconIndexEntry>(entry: T): T {
  const marker = /;\s*(?:NAmE|ŋɑmE)\s*/i;
  if (!marker.test(entry.britishIpa) && !marker.test(entry.americanIpa)) return entry;
  const british = entry.britishIpa.split(marker);
  const american = entry.americanIpa.split(marker);
  const candidate = (american[1] || british[1] || entry.americanIpa).trim();
  const americanIpa = /^-|-$/.test(candidate) ? "" : candidate;
  const detail = entry as T & { fieldStatus?: Record<string, string> };
  return { ...entry, britishIpa: british[0].trim(), americanIpa,
    ...(detail.fieldStatus && { fieldStatus: { ...detail.fieldStatus, ...(americanIpa ? {} : { americanIpa: "provisional" }) } }),
  };
}

const CLOSERS: Record<string, string> = { "）": "（", ")": "(" };
/**
 * 144 release rows lost the opening bracket of a leading note during extraction
 * ("源自拉丁语）上午"). Restore it for display when the note starts with real text;
 * anything more broken is left exactly as published.
 */
export function repairMeaning(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "（" || c === "(") depth++;
    else if (c in CLOSERS) {
      if (depth > 0) { depth--; continue; }
      return /^[\u4e00-\u9fffA-Za-z]/.test(text) ? CLOSERS[c] + text : text;
    }
  }
  return text;
}
/** The display-boundary repairs applied to every entry as it loads. */
export function normalizeEntry<T extends LexiconIndexEntry>(entry: T): T {
  const fixed = normalizePronunciations(entry);
  if (typeof fixed.chineseCore !== "string") return fixed;
  const chineseCore = repairMeaning(fixed.chineseCore);
  return chineseCore === fixed.chineseCore ? fixed : { ...fixed, chineseCore };
}

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
    return { index: index.map(normalizeEntry), manifest };
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
        rows.forEach((row) => detailCache.set(row.id, normalizeEntry(row)));
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

/** Speaks with a British voice when the device has one, matching the British IPA shown and the dictation voice. */
export function speakSystem(text: string, locale = "en-GB") {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang.toLowerCase() === locale.toLowerCase()) || voices.find((v) => /^en[-_]/i.test(v.lang));
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || locale;
  utterance.rate = 0.84;
  window.speechSynthesis.speak(utterance);
  return true;
}
