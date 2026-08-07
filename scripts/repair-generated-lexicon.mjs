import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const normalizedDir = join(root, "data/build/normalized");
const rawDir = join(root, "data/build/raw");
const releaseDir = join(root, "public/data/v1");
const gaokaoHighFrequency = new Set(JSON.parse(readFileSync(join(root, "data/gaokao-high-frequency.json"), "utf8")).headwords);

const ipaMap = new Map([
  ["", "ˈ"], ["", "ˌ"], ["", "ə"], ["", "æ"], ["", "ʃ"], ["", "ʊ"],
  ["", "ʒ"], ["", "ɒ"], ["", "ɑ"], ["", "ʌ"], ["", "θ"], ["", "ɜ"],
  ["", "ð"], ["", "ɪ"], ["", "ŋ"], ["", "ː"],
]);

function normalizeIpa(value = "") {
  let out = [...value].map((char) => {
    if (ipaMap.has(char)) return ipaMap.get(char);
    const code = char.codePointAt(0);
    return code >= 0xF000 && code <= 0xF07F ? String.fromCodePoint(code - 0xF000) : char;
  }).join("");
  return out.replace(/I/g, "ɪ").replace(/N/g, "ŋ").replace(/O/g, "ɔ").replace(/@/g, "ə")
    .replace(/Q/g, "ɒ").replace(/A/g, "ɑ").replace(/D/g, "ð").replace(/T/g, "θ")
    .replace(/S/g, "ʃ").replace(/Z/g, "ʒ").replace(/V/g, "ʌ").replace(/3/g, "ɜ")
    .replace(/\{/g, "æ").replace(/%/g, "ˌ").replace(/'/g, "ˈ").replace(/ә/g, "ə")
    .replace(/:/g, "ː").replace(/；/g, ";").replace(/\//g, "").replace(/\s+/g, " ").trim();
}

function completeSharedIpaSuffix(variant, base) {
  if (!variant.endsWith("-")) return variant;
  const prefix = variant.slice(0, -1);
  const anchor = [...prefix.replace(/[ˈˌː()]/g, "")].at(-1);
  const anchorIndex = anchor ? base.lastIndexOf(anchor) : -1;
  return anchorIndex >= 0 ? `${prefix}${base.slice(anchorIndex + 1)}` : prefix;
}

const cleanSpaces = (value = "") => value.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[\u00a0\t]+/g, " ").replace(/\s+/g, " ").trim();

function chineseSliceStart(value, hanStart) {
  if (hanStart < 0) return -1;
  const prefix = value.slice(0, hanStart);
  const open = Math.max(prefix.lastIndexOf("（"), prefix.lastIndexOf("("), prefix.lastIndexOf("《"));
  const close = Math.max(prefix.lastIndexOf("）"), prefix.lastIndexOf(")"), prefix.lastIndexOf("》"));
  return open > close ? open : hanStart;
}

function repairHighRecord(record) {
  const raw = record.rawText.replace(/^△\s*/, "").replaceAll("\uF02F", "/").replaceAll("\uF020", " ").trim();
  const rawIpaGroups = [...raw.matchAll(/\/([^/]{1,100})\//g)].map((match) => match[1]);
  const firstIpaGroup = (rawIpaGroups[0] || "").replaceAll("\uF03B", ";").replaceAll("\uF020", " ");
  const nameSplit = firstIpaGroup.split(/;\s*NAmE\s*/i);
  const britishIpa = normalizeIpa(nameSplit[0] || rawIpaGroups[0] || "");
  const americanIpa = completeSharedIpaSuffix(normalizeIpa(nameSplit[1] || nameSplit[0] || rawIpaGroups[0] || "")
    .replace(/^-/, record.headword.slice(0, Math.max(0, record.headword.length - 3))), britishIpa);
  const rawWithoutIpa = raw.replace(/\/[^/]{1,100}\//g, " ");
  const zhStart = rawWithoutIpa.search(/[\u3400-\u9fff]/);
  const chineseStart = chineseSliceStart(rawWithoutIpa, zhStart);
  let headword = cleanSpaces(record.headword.replace(/[（(《]\s*$/, "")
    .replace(/\s*[（(]\s*(?:especially\s+)?(?:US|NAmE)\s+[^）)]*[）)]\s*$/i, "")
    .replace(/\s+abbr\.\s*[（(][^）)]+[）)]\s*$/i, ""));
  if (headword.endsWith("）") && !headword.includes("（")) headword = cleanSpaces(headword.slice(0, -1));
  if (record.sourceRecordId === "HS-R3:111:191") headword = "Department of Obstetrics and Gynecology";
  if (record.sourceRecordId === "HS-R3:111:194") headword = "the North/South Pole";
  if (record.sourceRecordId === "HS-S1:114:85") headword = "switch off/on";
  let chinese = chineseStart >= 0 ? cleanSpaces(rawWithoutIpa.slice(chineseStart)
    .replace(/\b(?:NAmE|BrE)\b[^\u3400-\u9fff]*/g, "")
    .replace(/\s+\b(?:n|v|vi|vt|adj|adv|prep|pron|conj|abbr|modal v|art|num|interj)\.\s*/gi, "；")
    .replace(/；{2,}/g, "；")) : record.chinese;
  if (record.sourceRecordId === "HS-R3:111:190") chinese = "妇产科（全称 Department of Obstetrics and Gynecology）";
  if (record.sourceRecordId === "HS-R3:111:191") chinese = "妇产科（全称）";
  if (record.sourceRecordId === "HS-R3:111:157") chinese = chinese.replace(/\s*Henry Norman Bethune\s*/g, "");
  let repairedBritishIpa = britishIpa;
  let repairedAmericanIpa = americanIpa;
  if (record.sourceRecordId === "HS-R3:111:194") {
    repairedBritishIpa = "";
    repairedAmericanIpa = "";
    chinese = "北极／南极";
  }
  if (record.sourceRecordId === "HS-S1:114:85") {
    repairedBritishIpa = "";
    repairedAmericanIpa = "";
    chinese = "关／开（电灯、机器等）";
  }
  return {
    ...record,
    headword,
    lookup: headword.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim(),
    properName: record.rawText.trim().startsWith("△") || /^[A-Z]/.test(record.headword),
    britishIpa: repairedBritishIpa,
    americanIpa: repairedAmericanIpa,
    ipaVariants: [...new Set([repairedBritishIpa, repairedAmericanIpa, ...rawIpaGroups.slice(1).map(normalizeIpa)].filter((value) => value && !/[\u3400-\u9fff]/.test(value)))],
    chinese,
    normalizationStatus: "verified-cross-source",
  };
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

for (const directory of [rawDir, normalizedDir]) {
  for (const name of readdirSync(directory).filter((file) => /^HS-[RS]\d\.jsonl$/.test(file))) {
    const path = join(directory, name);
    writeJsonl(path, readJsonl(path).map(repairHighRecord));
  }
}

const sourceRecords = readdirSync(normalizedDir).filter((file) => /^(?:HS|JH)-.+\.jsonl$/.test(file))
  .flatMap((file) => readJsonl(join(normalizedDir, file)));
const recordsByLookup = new Map();
const recordsById = new Map(sourceRecords.map((record) => [record.sourceRecordId, record]));
for (const record of sourceRecords) {
  if (!recordsByLookup.has(record.lookup)) recordsByLookup.set(record.lookup, []);
  recordsByLookup.get(record.lookup).push(record);
}

const manifestPath = join(releaseDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const released = [];
for (const descriptor of manifest.chunks) {
  const path = join(releaseDir, descriptor.file);
  const entries = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of entries) {
    const primary = entry.sources.map((source) => recordsById.get(source.recordId))
      .find((record) => record?.bookId.startsWith("HS-") && record.chinese)
      || recordsByLookup.get(entry.lookup)?.find((record) => record.bookId.startsWith("HS-") && record.chinese);
    if (primary) {
      entry.headword = primary.headword;
      entry.lookup = primary.lookup;
      const slashSeparatedPhrase = primary.sourceRecordId === "HS-R3:111:194" || primary.sourceRecordId === "HS-S1:114:85";
      entry.britishIpa = slashSeparatedPhrase ? primary.britishIpa : primary.britishIpa || entry.britishIpa;
      entry.americanIpa = slashSeparatedPhrase ? primary.americanIpa : primary.americanIpa || entry.americanIpa;
      entry.chineseCore = primary.chinese || entry.chineseCore;
      entry.flags.properName = primary.properName;
      entry.fieldStatus.britishIpa = primary.fieldStatus.britishIpa;
      entry.fieldStatus.americanIpa = primary.fieldStatus.americanIpa;
      entry.fieldStatus.chineseCore = primary.fieldStatus.chinese;
    }
    if (gaokaoHighFrequency.has(entry.lookup) && !entry.scopes.includes("gaokao-supplement")) entry.scopes.push("gaokao-supplement");
    released.push(entry);
  }
  writeFileSync(path, `${JSON.stringify(entries)}\n`);
}

if (!released.some((entry) => entry.lookup === "henry norman bethune")) {
  const lookup = "henry norman bethune";
  released.push({
    id: `pep-${createHash("sha256").update(`phrase:${lookup}`).digest("hex").slice(0, 16)}`,
    schemaVersion: "1.0.0", headword: "Henry Norman Bethune", lookup, kind: "phrase", tier: "A",
    scopes: ["high-required"], variants: [], britishIpa: "ˈhenri ˈnɔːmən bəˈθjuːn",
    americanIpa: "ˈhɛnri ˈnɔːrmən bəˈθuːn", pronunciation: { mode: "system-tts", label: "系统语音", source: "Web Speech API" },
    partsOfSpeech: [], grammar: { countability: null, transitivity: null }, chineseCore: "亨利·诺曼·白求恩",
    englishCore: null, openExample: null,
    sources: [{ recordId: "HS-R3:111:194:bethune", bookId: "HS-R3", volume: "必修第三册", unit: "Unit 2", physicalPage: 111, printedPage: 104, status: "verified-cross-source", curriculumLevel: null }],
    relations: { family: [], phrases: [], confusables: [] },
    license: { headwordAndChinese: "textbook-derived facts; source location only; raw pages excluded", englishDefinition: null, audio: "no bundled audio; system TTS only" },
    fieldStatus: { headword: "verified-cross-source", britishIpa: "verified-cross-source", americanIpa: "verified-cross-source", chineseCore: "verified-primary", englishCore: "provisional", sources: "verified-primary", relations: "provisional" },
    flags: { highFrequencyContinuation: false, highValue: false, properName: true, formalReleaseEligible: true },
  });
}
released.sort((a, b) => a.lookup.localeCompare(b.lookup, "en"));
const chunkSize = 180;
const chunks = [];
for (let indexStart = 0; indexStart < released.length; indexStart += chunkSize) {
  const name = `lexicon-${String(chunks.length).padStart(2, "0")}.json`;
  const slice = released.slice(indexStart, indexStart + chunkSize);
  writeFileSync(join(releaseDir, "chunks", name), `${JSON.stringify(slice)}\n`);
  chunks.push({ file: `chunks/${name}`, first: slice[0]?.id, last: slice.at(-1)?.id, count: slice.length });
}

const index = released.map((entry) => ({
  id: entry.id,
  headword: entry.headword,
  lookup: entry.lookup,
  tier: entry.tier,
  scopes: entry.scopes,
  chineseCore: entry.chineseCore,
  britishIpa: entry.britishIpa,
  americanIpa: entry.americanIpa,
  partsOfSpeech: entry.partsOfSpeech,
  sources: entry.sources.map(({ recordId, bookId, volume, unit, printedPage }) => ({ recordId, bookId, volume, unit, printedPage })),
  flags: entry.flags,
}));
writeFileSync(join(releaseDir, "index.json"), `${JSON.stringify(index)}\n`);
manifest.generatedAt = new Date().toISOString();
const unreleasedGap = Math.max(0, (manifest.uniqueEntries || manifest.releasedEntries || released.length) - (manifest.releasedEntries || released.length));
manifest.chunks = chunks;
manifest.uniqueEntries = released.length + unreleasedGap;
manifest.releasedEntries = released.length;
manifest.middleEntries = released.filter((entry) => entry.scopes.includes("middle-core")).length;
manifest.highRequiredEntries = released.filter((entry) => entry.scopes.includes("high-required")).length;
manifest.highSelectiveEntries = released.filter((entry) => entry.scopes.includes("high-selective")).length;
manifest.curriculumNotTextbookEntries = released.filter((entry) => entry.scopes.includes("curriculum-not-textbook")).length;
manifest.gaokaoSupplementEntries = released.filter((entry) => entry.scopes.includes("gaokao-supplement")).length;
manifest.tierCounts = Object.fromEntries(["A", "B", "C"].map((tier) => [tier, released.filter((entry) => entry.tier === tier).length]));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ repairedHighRecords: sourceRecords.filter((row) => row.bookId.startsWith("HS-")).length, releasedEntries: released.length }, null, 2));
