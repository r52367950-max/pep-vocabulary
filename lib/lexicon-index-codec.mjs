/**
 * Row encoding for `public/data/v1/index.json`.
 *
 * Every client parses the index on start-up, so entries are stored as rows
 * instead of repeating eleven property names 4,681 times. Book volumes are
 * shared through a table and the four flags are one bit field. Decoding
 * returns exactly the projection the release builder writes.
 *
 * The decoder also accepts the earlier array of entry objects: a page that
 * loads new code while an older service worker still controls it is served
 * the previous release's cached index until that worker is replaced.
 *
 * Plain ESM so the browser bundle, the Worker and Node release scripts share it.
 */

export const LEXICON_INDEX_FORMAT = "pep-lexicon-index/2";

const FLAG_BITS = /** @type {const} */ ([
  ["highFrequencyContinuation", 1],
  ["highValue", 2],
  ["properName", 4],
  ["formalReleaseEligible", 8],
]);

/**
 * @typedef {{ bookId: string; volume: string; unit: string; printedPage: number | null; sequence?: number }} IndexSource
 * @typedef {{
 *   id: string; headword: string; lookup: string; tier: "A" | "B" | "C"; scopes: string[];
 *   chineseCore: string; britishIpa: string; americanIpa: string; partsOfSpeech: string[];
 *   sources: IndexSource[];
 *   flags: { highFrequencyContinuation: boolean; highValue: boolean; properName: boolean; formalReleaseEligible: boolean };
 * }} IndexEntry
 * @typedef {[string, string, string | null, string, string[], string, string, string, string[], [number, string, number | null][], number]} IndexRow
 * @typedef {{ format: typeof LEXICON_INDEX_FORMAT; books: [string, string][]; rows: IndexRow[]; sourceOrders?: (number | null)[][] }} EncodedLexiconIndex
 */

/**
 * @param {IndexEntry[]} entries
 * @returns {EncodedLexiconIndex}
 */
export function encodeLexiconIndex(entries) {
  /** @type {Map<string, number>} */
  const bookPositions = new Map();
  /** @type {[string, string][]} */
  const books = [];
  const rows = entries.map((entry) => {
    const sources = entry.sources.map(({ bookId, volume, unit, printedPage }) => {
      const key = JSON.stringify([bookId, volume]);
      let position = bookPositions.get(key);
      if (position === undefined) {
        position = books.push([bookId, volume]) - 1;
        bookPositions.set(key, position);
      }
      return /** @type {[number, string, number | null]} */ ([position, unit, printedPage ?? null]);
    });
    const flags = FLAG_BITS.reduce((bits, [name, bit]) => (entry.flags[name] ? bits | bit : bits), 0);
    return /** @type {IndexRow} */ ([
      entry.id, entry.headword, entry.lookup === entry.headword ? null : entry.lookup, entry.tier, entry.scopes,
      entry.chineseCore, entry.britishIpa, entry.americanIpa, entry.partsOfSpeech, sources, flags,
    ]);
  });
  // An optional parallel column keeps /2 rows readable by previously cached clients.
  const sourceOrders = entries.map(entry => entry.sources.map(source => source.sequence ?? null));
  return { format: LEXICON_INDEX_FORMAT, books, rows, ...(sourceOrders.some(row => row.some(value => value !== null)) ? { sourceOrders } : {}) };
}

const invalid = () => new Error("Invalid lexicon index");
/** @param {unknown} value */
const text = (value) => {
  if (typeof value !== "string") throw invalid();
  return value;
};
/** @param {unknown} value */
const texts = (value) => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw invalid();
  return /** @type {string[]} */ (value);
};

/**
 * @param {unknown} value
 * @returns {IndexEntry[]}
 */
export function decodeLexiconIndex(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") throw invalid();
  const { format, books, rows, sourceOrders } = /** @type {{ format?: unknown; books?: unknown; rows?: unknown; sourceOrders?: unknown }} */ (value);
  if (format !== LEXICON_INDEX_FORMAT || !Array.isArray(books) || !Array.isArray(rows)) throw invalid();
  if (sourceOrders !== undefined && (!Array.isArray(sourceOrders) || sourceOrders.length !== rows.length)) throw invalid();
  const volumes = books.map((book) => {
    if (!Array.isArray(book) || book.length !== 2) throw invalid();
    return [text(book[0]), text(book[1])];
  });
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 11 || !Array.isArray(row[9]) || !Number.isInteger(row[10])) throw invalid();
    const headword = text(row[1]);
    const orders = Array.isArray(sourceOrders) ? sourceOrders[index] : undefined;
    if (sourceOrders !== undefined && (!Array.isArray(orders) || orders.length !== row[9].length || orders.some(order => order !== null && (!Number.isSafeInteger(order) || order < 1)))) throw invalid();
    return {
      id: text(row[0]), headword, lookup: row[2] === null ? headword : text(row[2]),
      tier: /** @type {"A" | "B" | "C"} */ (text(row[3])), scopes: texts(row[4]), chineseCore: text(row[5]),
      britishIpa: text(row[6]), americanIpa: text(row[7]), partsOfSpeech: texts(row[8]),
      sources: row[9].map((source, sourceIndex) => {
        if (!Array.isArray(source) || source.length !== 3 || !(source[2] === null || Number.isInteger(source[2]))) throw invalid();
        const book = volumes[source[0]];
        if (!book) throw invalid();
        const sequence = orders?.[sourceIndex];
        return { bookId: book[0], volume: book[1], unit: text(source[1]), printedPage: source[2], ...(sequence != null ? { sequence } : {}) };
      }),
      flags: {
        highFrequencyContinuation: (row[10] & 1) !== 0,
        highValue: (row[10] & 2) !== 0,
        properName: (row[10] & 4) !== 0,
        formalReleaseEligible: (row[10] & 8) !== 0,
      },
    };
  });
}
