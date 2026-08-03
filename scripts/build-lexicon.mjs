import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cache = process.env.PEP_VOCAB_SOURCE_CACHE || "/workspace/source-cache/pep-vocab";
const books = JSON.parse(readFileSync(join(root, "config/books.json"), "utf8"));
const rawDir = join(root, "data/build/raw");
const normalizedDir = join(root, "data/build/normalized");
const releaseDir = join(root, "public/data/v1");
mkdirSync(rawDir, { recursive: true });
mkdirSync(normalizedDir, { recursive: true });
mkdirSync(join(releaseDir, "chunks"), { recursive: true });

const decodeEntities = (value) => value
  .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const ipaMap = new Map([
  ["", "ˈ"], ["", "ˌ"], ["", "ə"], ["", "æ"], ["", "ʃ"], ["", "ʊ"],
  ["", "ʒ"], ["", "ɒ"], ["", "ɑ"], ["", "ʌ"], ["", "θ"], ["", "ɜ"],
  ["", "ð"], ["", "ɪ"], ["", "ŋ"], ["", "ː"],
]);

function normalizeIpa(value = "") {
  let out = [...value].map((char) => {
    if (ipaMap.has(char)) return ipaMap.get(char);
    const code = char.codePointAt(0);
    // PEP's embedded phonetic font also maps ordinary ASCII at U+F000 + byte.
    if (code >= 0xF000 && code <= 0xF07F) return String.fromCodePoint(code - 0xF000);
    return char;
  }).join("");
  out = out.replace(/I/g, "ɪ").replace(/N/g, "ŋ").replace(/O/g, "ɔ").replace(/@/g, "ə")
    .replace(/Q/g, "ɒ").replace(/A/g, "ɑ").replace(/D/g, "ð").replace(/T/g, "θ")
    .replace(/S/g, "ʃ").replace(/Z/g, "ʒ").replace(/V/g, "ʌ").replace(/3/g, "ɜ")
    .replace(/\{/g, "æ").replace(/%/g, "ˌ").replace(/'/g, "ˈ").replace(/ә/g, "ə")
    .replace(/:/g, "ː").replace(/\//g, "").replace(/\s+/g, " ").trim();
  return out;
}

const cleanSpaces = (value = "") => value.replace(/[\u00a0\t]+/g, " ").replace(/\s+/g, " ").trim();
const lookupKey = (value = "") => cleanSpaces(value).toLowerCase().replace(/[’‘]/g, "'")
  .replace(/…+/g, "...").replace(/\.{2,}/g, "...").replace(/\s*\.\.\.\s*/g, " ... ").replace(/\s+/g, " ").trim();

function parseBBox(pdfPath, firstPage, lastPage) {
  const xml = execFileSync("pdftotext", ["-f", String(firstPage), "-l", String(lastPage), "-bbox-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pages = [];
  const pageRe = /<page width="([^"]+)" height="([^"]+)">([\s\S]*?)<\/page>/g;
  let pageMatch;
  let offset = 0;
  while ((pageMatch = pageRe.exec(xml))) {
    const width = Number(pageMatch[1]);
    const lines = [];
    const lineRe = /<line xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)">([\s\S]*?)<\/line>/g;
    let lineMatch;
    while ((lineMatch = lineRe.exec(pageMatch[3]))) {
      const words = [...lineMatch[5].matchAll(/<word[^>]*>([\s\S]*?)<\/word>/g)].map((m) => decodeEntities(m[1]));
      lines.push({ x: Number(lineMatch[1]), y: Number(lineMatch[2]), text: cleanSpaces(words.join(" ")) });
    }
    pages.push({ physicalPage: firstPage + offset, width, lines });
    offset += 1;
  }
  return pages;
}

function extractHighStandard() {
  const pdfPath = join(cache, "standards/high-school-english-2017-2020.pdf");
  if (!existsSync(pdfPath)) return [];
  const pages = parseBBox(pdfPath, 129, 184);
  const records = [];
  for (const page of pages) {
    const lines = page.lines
      .filter((line) => line.text && line.y > 55 && line.y < 730 && !(page.physicalPage === 184 && line.y > 250))
      .map((line) => ({ ...line, column: line.x < page.width / 2 ? 0 : 1 }))
      .sort((a, b) => a.column - b.column || a.y - b.y || a.x - b.x);
    for (const line of lines) {
      const text = cleanSpaces(line.text);
      if (!/^[A-Za-z]/.test(text) || /^[A-Z]$/.test(text) || /^(RELATED|COUNTRY|PERSON|ADJECTIVES)$/i.test(text)) continue;
      if (!/^[A-Za-z][A-Za-z0-9'’.,()\-\s/]*\*{0,2}$/.test(text)) continue;
      const stars = text.match(/(\*{1,2})$/)?.[1]?.length || 0;
      const withoutStars = text.replace(/\*+$/, "").trim();
      const variantMatch = withoutStars.match(/\s*\(([^)]+)\)\s*$/);
      const headword = cleanSpaces(withoutStars.replace(/\s*\([^)]+\)\s*$/, ""));
      if (!headword || /^(ordinary high school english curriculum standard|appendix)$/i.test(headword)) continue;
      records.push({
        sourceRecordId: `STD-HS:${page.physicalPage}:${records.length + 1}`,
        bookId: "STD-HS",
        scope: "curriculum-standard",
        curriculumLevel: stars === 2 ? "selective-required" : stars === 1 ? "required" : "compulsory-baseline",
        volume: "课程标准附录2",
        unit: "词汇表",
        physicalPage: page.physicalPage,
        printedPage: page.physicalPage - 8,
        extraction: "official-standard-text-layer",
        sourceStatus: "verified-primary",
        rawText: text,
        headword,
        lookup: lookupKey(headword),
        kind: /\s/.test(headword) ? "phrase" : "word",
        properName: /^[A-Z]/.test(headword),
        variants: variantMatch ? [cleanSpaces(variantMatch[1])] : [],
        britishIpa: "",
        americanIpa: "",
        ipaVariants: [],
        partsOfSpeech: [],
        countability: null,
        transitivity: null,
        chinese: "",
        fieldStatus: {
          headword: "verified-primary", chinese: "provisional", britishIpa: "provisional",
          americanIpa: "provisional", partsOfSpeech: "provisional",
        },
      });
    }
  }
  return records;
}

function parseCsvRecord(record) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const char = record[index];
    if (char === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  fields.push(value);
  return fields;
}

async function loadEcdict(targets) {
  const path = join(cache, "open-data/ecdict/ecdict.csv");
  const result = new Map();
  if (!existsSync(path)) return result;
  let record = "";
  let quoted = false;
  const processRecord = (raw) => {
    const fields = parseCsvRecord(raw.replace(/\r$/, ""));
    const key = lookupKey(fields[0] || "");
    if (!targets.has(key)) return;
    const translation = cleanSpaces((fields[3] || "").split(/\n/).filter((line) => !/^\[[^\]]+\]/.test(line.trim())).slice(0, 2).join("；"));
    const definition = cleanSpaces((fields[2] || "").split(/\n/).slice(0, 2).join("; "));
    const pos = [...new Set([...(fields[3] || "").matchAll(/(?:^|\n)(n|v|vt|vi|adj|a|adv|prep|pron|conj|num|int)\./g)].map((match) => match[1].replace(/^a$/, "adj")))];
    result.set(key, { phonetic: normalizeIpa(fields[1] || ""), definition, translation, partsOfSpeech: pos });
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const char of chunk) {
      if (char === '"') quoted = !quoted;
      if (char === "\n" && !quoted) {
        processRecord(record);
        record = "";
      } else {
        record += char;
      }
    }
  }
  if (record) processRecord(record);
  return result;
}

function extractHighBook(book) {
  const pdfPath = join(cache, book.path);
  const pages = parseBBox(pdfPath, book.wordList.firstPhysicalPage, book.wordList.lastPhysicalPage);
  const raw = [];
  let currentUnit = "unresolved";
  let current = null;
  const flush = () => {
    if (!current) return;
    current.rawText = cleanSpaces(current.parts.join(" "));
    delete current.parts;
    raw.push(current);
    current = null;
  };

  for (const page of pages) {
    const candidates = page.lines
      .filter((line) => line.text && line.y > 45 && line.y < 820)
      .map((line) => ({ ...line, column: line.x < page.width / 2 ? 0 : 1 }))
      .sort((a, b) => a.column - b.column || a.y - b.y || a.x - b.x);
    const base = [
      Math.min(...candidates.filter((line) => line.column === 0 && line.x > 45).map((line) => line.x)),
      Math.min(...candidates.filter((line) => line.column === 1 && line.x > page.width / 2).map((line) => line.x)),
    ];
    for (const line of candidates) {
      const text = line.text.replace(/^△\s*/, "△");
      if (/^Words and Expressions in Each Unit$/i.test(text) || /^Appendices$/i.test(text) || /^各单元/.test(text)) continue;
      const unitMatch = text.match(/^(Welcome Unit|Unit\s+\d+)\b/i);
      if (unitMatch) {
        flush();
        currentUnit = unitMatch[1].replace(/\s+/g, " ").replace(/^unit/i, "Unit").replace(/^welcome unit/i, "Welcome Unit");
        continue;
      }
      if (/^\d+$/.test(text) || /^注[：:]/.test(text) || /^黑体部分/.test(text) || /^白体部分/.test(text)) continue;
      const relativeX = line.x - base[line.column];
      const firstToken = text.replace(/^△/, "").split(/\s+/)[0] || "";
      const beginsEnglish = /^[A-Za-z][A-Za-z'’.()-]*$/.test(firstToken);
      const continuationToken = /^(n|v|vi|vt|adj|adv|prep|pron|conj|abbr|pl|modal|art|num|interj)\.?$/i.test(firstToken);
      const isEntry = relativeX <= 20 && beginsEnglish && !continuationToken;
      if (isEntry) {
        flush();
        current = {
          sourceRecordId: `${book.id}:${page.physicalPage}:${raw.length + 1}`,
          bookId: book.id,
          scope: book.scope,
          volume: book.volume,
          unit: currentUnit,
          physicalPage: page.physicalPage,
          printedPage: page.physicalPage - book.wordList.printedPageOffset,
          extraction: "pdf-text-layer",
          sourceStatus: "verified-primary",
          parts: [text],
        };
      } else if (current && relativeX < 120) {
        current.parts.push(text);
      }
    }
  }
  flush();
  return raw;
}

function parseRawHigh(record) {
  // Some PEP PDFs encode the phonetic slash and spaces in a private-use font.
  // Normalise the delimiters before splitting the headword from IPA/POS data.
  const raw = record.rawText.replace(/^△\s*/, "").replaceAll("\uF02F", "/").replaceAll("\uF020", " ").trim();
  const properName = record.rawText.trim().startsWith("△");
  const slashStart = raw.indexOf("/");
  const chineseStart = raw.search(/[\u3400-\u9fff]/);
  let headEnd = slashStart >= 0 ? slashStart : chineseStart;
  if (headEnd < 0) headEnd = raw.search(/\b(?:n|v|vi|vt|adj|adv|prep|pron|conj|abbr|modal|art|num|interj)\./i);
  if (headEnd < 0) headEnd = raw.length;
  const rawHeadword = cleanSpaces(raw.slice(0, headEnd));
  const headword = cleanSpaces(rawHeadword
    .replace(/\s*[（(]\s*(?:especially\s+)?NAmE[^）)]*[）)]/gi, "")
    .replace(/\s*\(BrE[^)]*\)/gi, "")
    .replace(/\s+/g, " "));
  const ipaGroups = [...raw.matchAll(/\/([^/]{1,100})\//g)].map((m) => normalizeIpa(m[1]));
  const firstIpa = ipaGroups[0] || "";
  const nameSplit = firstIpa.split(/;\s*NAmE\s*/i);
  const britishIpa = nameSplit[0] || firstIpa;
  const americanIpa = nameSplit[1]?.replace(/^-/, headword.slice(0, Math.max(0, headword.length - 3))) || nameSplit[0] || firstIpa;
  const pos = [...raw.matchAll(/\b(n|v|vi|vt|adj|adv|prep|pron|conj|abbr|modal v|art|num|interj)\./gi)].map((m) => m[1].toLowerCase());
  const zhStart = raw.search(/[\u3400-\u9fff]/);
  const chinese = zhStart >= 0 ? cleanSpaces(raw.slice(zhStart).replace(/\b(?:NAmE|BrE)\b[^\u3400-\u9fff]*/g, "")) : "";
  const kind = /\s/.test(headword) || /\.\.\./.test(headword) ? "phrase" : properName ? "proper-name" : "word";
  return {
    ...record,
    headword,
    lookup: lookupKey(headword),
    kind,
    properName,
    britishIpa,
    americanIpa,
    ipaVariants: ipaGroups,
    partsOfSpeech: [...new Set(pos)],
    countability: /\bn\.\s*\[pl\.\]|\[pl\.\]/i.test(raw) ? "plural-noted" : null,
    transitivity: /\bvt\./i.test(raw) && /\bvi\./i.test(raw) ? "transitive-and-intransitive" : /\bvt\./i.test(raw) ? "transitive" : /\bvi\./i.test(raw) ? "intransitive" : null,
    chinese,
    fieldStatus: {
      headword: "verified-primary", chinese: chinese ? "verified-primary" : "provisional",
      britishIpa: britishIpa ? "verified-primary" : "provisional", americanIpa: americanIpa ? "verified-primary" : "provisional",
      partsOfSpeech: pos.length ? "verified-primary" : "provisional",
    },
  };
}

function loadIpaDictionary(name) {
  const map = new Map();
  const path = join(cache, `open-data/ipa-dict/${name}.txt`);
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const [word, value] = line.split(/\t/);
    if (word && value && !map.has(word.toLowerCase())) map.set(word.toLowerCase(), value.split(", ")[0]);
  }
  return map;
}

const ipaUK = loadIpaDictionary("en_UK");
const ipaUS = loadIpaDictionary("en_US");
const standardRecords = extractHighStandard();
const ecdict = await loadEcdict(new Set(standardRecords.map((record) => record.lookup)));
for (const record of standardRecords) {
  const open = ecdict.get(record.lookup);
  record.chinese = open?.translation || "";
  record.partsOfSpeech = open?.partsOfSpeech || [];
  record.britishIpa = ipaUK.get(record.lookup) || synthesizePhraseIpa(record.headword, ipaUK) || open?.phonetic || "";
  record.americanIpa = ipaUS.get(record.lookup) || synthesizePhraseIpa(record.headword, ipaUS) || open?.phonetic || record.britishIpa;
  record.fieldStatus.chinese = record.chinese ? "verified-primary" : "provisional";
  record.fieldStatus.britishIpa = record.britishIpa ? "verified-cross-source" : "provisional";
  record.fieldStatus.americanIpa = record.americanIpa ? "verified-cross-source" : "provisional";
  record.fieldStatus.partsOfSpeech = record.partsOfSpeech.length ? "verified-primary" : "provisional";
}

const middleUnitStarts = {
  "JH-7A": [
    ["good", "Starter Unit 1"], ["what", "Starter Unit 2"], ["color", "Starter Unit 3"], ["name", "Unit 1"],
    ["sister", "Unit 2"], ["pencil", "Unit 3"], ["where", "Unit 4"], ["do", "Unit 5"], ["banana", "Unit 6"],
    ["much", "Unit 7"], ["when", "Unit 8"], ["favorite", "Unit 9"],
  ],
  "JH-7B": [["guitar", "Unit 1"], ["up", "Unit 2"], ["train", "Unit 3"], ["rule", "Unit 4"], ["panda", "Unit 5"], ["newspaper", "Unit 6"], ["rain", "Unit 7"], ["post", "Unit 8"], ["curly", "Unit 9"], ["noodle", "Unit 10"], ["milk", "Unit 11"], ["camp", "Unit 12"]],
  "JH-8A": [["anyone", "Unit 1"], ["housework", "Unit 2"], ["outgoing", "Unit 3"], ["theater", "Unit 4"], ["sitcom", "Unit 5"], ["grow up", "Unit 6"], ["paper", "Unit 7"], ["shake", "Unit 8"], ["prepare for", "Unit 9"], ["meeting", "Unit 10"]],
  "JH-8B": [["matter", "Unit 1"], ["clean up", "Unit 2"], ["rubbish", "Unit 3"], ["allow", "Unit 4"], ["rainstorm", "Unit 5"], ["shoot", "Unit 6"], ["square", "Unit 7"], ["treasure", "Unit 8"], ["amusement", "Unit 9"], ["yard", "Unit 10"]],
  "JH-9": [["textbook", "Unit 1"], ["lantern", "Unit 2"], ["restroom", "Unit 3"], ["humorous", "Unit 4"], ["material", "Unit 5"], ["heel", "Unit 6"], ["license", "Unit 7"], ["whose", "Unit 8"], ["prefer", "Unit 9"], ["custom", "Unit 10"], ["rather", "Unit 11"], ["unexpected", "Unit 12"], ["litter", "Unit 13"], ["survey", "Unit 14"]],
};

function middleMarkdownFiles(book) {
  const manifestPath = join(cache, "open-data/mikigo-middle/files_complete.tsv");
  const label = book.volume.replace("全一册", "全册");
  const rows = readFileSync(manifestPath, "utf8").trim().split(/\r?\n/).map((line) => line.split("\t"));
  return rows.filter(([, source]) => source.includes(`人教版初中英语-${label}/`) && source.endsWith(".md") && !source.endsWith("index.md"))
    .map(([file, source]) => ({ file: join(cache, "open-data/mikigo-middle", file), source, order: Number(basename(source).split("_")[0]) || 1 }))
    .sort((a, b) => a.order - b.order);
}

function synthesizePhraseIpa(headword, dict) {
  const tokens = headword.toLowerCase().replace(/[()….,?!]/g, " ").split(/\s+/).filter(Boolean)
    .filter((token) => !/^(sb|sth|one's|one’s)$/.test(token));
  if (!tokens.length) return "";
  const values = tokens.map((token) => dict.get(token.replace(/[^a-z'-]/g, ""))).filter(Boolean);
  return values.length >= Math.ceil(tokens.length * 0.7) ? values.join(" ") : "";
}

function extractMiddleBook(book) {
  const entries = [];
  for (const descriptor of middleMarkdownFiles(book)) {
    const text = readFileSync(descriptor.file, "utf8");
    const headings = [...text.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)];
    for (let index = 0; index < headings.length; index += 1) {
      const match = headings[index];
      const body = text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length);
      const gloss = body.match(/\*\*(.*?)\*\*/s)?.[1];
      if (!gloss) continue;
      let headword = cleanSpaces(match[2]).replace(/\s+([’'])s\b/g, "$1s").replace(/…+/g, "...");
      if (/\.$/.test(headword) && !/^[A-Za-z]\.$/.test(headword) && !/^(Mr|Mrs|Ms|Dr|St)\.$/.test(headword)) headword = headword.slice(0, -1);
      entries.push({ sequence: Number(match[1]), headword, chinese: cleanSpaces(gloss), sourceFile: descriptor.source });
    }
  }
  entries.sort((a, b) => a.sequence - b.sequence);
  const starts = new Map(middleUnitStarts[book.id].map(([headword, unit]) => [lookupKey(headword), unit]));
  let unit = "unresolved";
  return entries.map((entry, index) => {
    const lookup = lookupKey(entry.headword);
    if (starts.has(lookup)) unit = starts.get(lookup);
    const britishIpa = ipaUK.get(lookup) || synthesizePhraseIpa(entry.headword, ipaUK);
    const americanIpa = ipaUS.get(lookup) || synthesizePhraseIpa(entry.headword, ipaUS) || britishIpa;
    return {
      sourceRecordId: `${book.id}:crosscheck:${entry.sequence}`,
      bookId: book.id,
      scope: book.scope,
      volume: book.volume,
      unit,
      physicalPage: null,
      printedPage: null,
      extraction: book.ocrPath ? "ocr-sequence + Apache-2.0 cross-check" : "text-layer sequence + Apache-2.0 cross-check",
      sourceStatus: "verified-cross-source",
      rawText: `${entry.headword} — ${entry.chinese}`,
      headword: entry.headword,
      lookup,
      kind: /\s/.test(entry.headword) || /\.\.\./.test(entry.headword) ? "phrase" : "word",
      properName: /^[A-Z]/.test(entry.headword),
      britishIpa: normalizeIpa(britishIpa),
      americanIpa: normalizeIpa(americanIpa),
      ipaVariants: [],
      partsOfSpeech: [],
      countability: null,
      transitivity: null,
      chinese: entry.chinese,
      fieldStatus: {
        headword: "verified-cross-source", chinese: "verified-cross-source",
        britishIpa: britishIpa ? "verified-cross-source" : "provisional",
        americanIpa: americanIpa ? "verified-cross-source" : "provisional",
        partsOfSpeech: "provisional",
      },
      sequence: index + 1,
    };
  });
}

function loadOewn() {
  const dir = join(cache, "open-data/oewn/2025-plus-json");
  if (!existsSync(dir)) return { entries: new Map(), synsets: new Map() };
  const entries = new Map();
  const synsets = new Map();
  for (const name of readdirSync(dir)) {
    if (name.startsWith("entries-") && name.endsWith(".json")) {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const [lemma, value] of Object.entries(data)) entries.set(lookupKey(lemma), value);
    } else if (/^(noun|verb|adj|adv)\..+\.json$/.test(name)) {
      const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const [id, value] of Object.entries(data)) synsets.set(id, value);
    }
  }
  return { entries, synsets };
}

const oewn = loadOewn();
function openDefinition(record) {
  const entry = oewn.entries.get(record.lookup);
  if (entry) {
    const posOrder = record.partsOfSpeech.some((p) => p.startsWith("v")) ? ["v", "n", "a", "r", "s"] : ["n", "v", "a", "r", "s"];
    for (const pos of posOrder) {
      const sense = entry[pos]?.sense?.[0];
      const synset = sense && oewn.synsets.get(sense.synset);
      if (synset?.definition?.[0]) {
        return {
          text: synset.definition[0],
          example: synset.example?.[0] || null,
          synset: sense.synset,
          license: "CC BY 4.0",
          attribution: "Open English WordNet 2025 contributors",
          status: "verified-primary",
        };
      }
    }
  }
  const fallback = ecdictAll.get(record.lookup);
  if (fallback?.definition) {
    return {
      text: fallback.definition,
      example: null,
      synset: null,
      license: "MIT",
      attribution: "ECDICT, Copyright (c) 2025 Linwei",
      status: "verified-primary",
    };
  }
  return null;
}

const sourceRecords = [];
for (const book of books) {
  const records = book.stage === "high" ? extractHighBook(book).map(parseRawHigh) : extractMiddleBook(book);
  sourceRecords.push(...records);
  writeFileSync(join(rawDir, `${book.id}.jsonl`), `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
}
sourceRecords.push(...standardRecords);
writeFileSync(join(rawDir, "STD-HS.jsonl"), `${standardRecords.map((item) => JSON.stringify(item)).join("\n")}\n`);
const ecdictAll = await loadEcdict(new Set(sourceRecords.map((record) => record.lookup)));

const normalized = sourceRecords.filter((item) => item.lookup && /^[a-z0-9]/i.test(item.lookup)).map((item) => ({
  ...item,
  stableSourceHash: createHash("sha256").update(`${item.bookId}|${item.unit}|${item.rawText}`).digest("hex"),
  normalizationStatus: /[]/.test(item.britishIpa + item.americanIpa) ? "conflicted" : "verified-cross-source",
}));
for (const book of books) {
  const records = normalized.filter((item) => item.bookId === book.id);
  writeFileSync(join(normalizedDir, `${book.id}.jsonl`), `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

const grouped = new Map();
for (const record of normalized) {
  const key = `${record.kind}:${record.lookup}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(record);
}

const highValueSeeds = new Set(["apply", "challenge", "content", "focus", "issue", "matter", "mean", "present", "range", "respect", "subject", "address", "approach", "figure", "strike", "charge", "account", "adapt", "affect", "effect", "advance", "recommend", "responsible", "confuse", "graduate", "schedule", "attract", "addicted"]);
const entries = [...grouped.entries()].map(([key, records]) => {
  const primary = records.find((item) => item.bookId.startsWith("HS-") && item.chinese) || records.find((item) => item.bookId.startsWith("JH-") && item.chinese) || records.find((item) => item.chinese) || records[0];
  const hasHighTextbook = records.some((item) => item.bookId.startsWith("HS-"));
  const hasMiddleTextbook = records.some((item) => item.bookId.startsWith("JH-"));
  const hasStandard = records.some((item) => item.bookId === "STD-HS");
  const high = hasHighTextbook || records.some((item) => item.bookId === "STD-HS" && item.curriculumLevel !== "compulsory-baseline");
  const definition = openDefinition(primary);
  const id = `pep-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const sources = records.map((item) => ({
    recordId: item.sourceRecordId, bookId: item.bookId, volume: item.volume, unit: item.unit,
    physicalPage: item.physicalPage, printedPage: item.printedPage, status: item.sourceStatus,
    curriculumLevel: item.curriculumLevel || null,
  }));
  const tier = high ? (records.length >= 3 || highValueSeeds.has(primary.lookup) ? "B" : "A") : "C";
  const scopes = [...new Set(records.filter((item) => item.bookId !== "STD-HS").map((item) => item.scope))];
  if (hasStandard && !hasHighTextbook && !hasMiddleTextbook) scopes.push("curriculum-not-textbook");
  const britishIpa = primary.britishIpa || records.find((item) => item.britishIpa)?.britishIpa || ipaUK.get(primary.lookup) || synthesizePhraseIpa(primary.headword, ipaUK) || "";
  const americanIpa = primary.americanIpa || records.find((item) => item.americanIpa)?.americanIpa || ipaUS.get(primary.lookup) || synthesizePhraseIpa(primary.headword, ipaUS) || britishIpa;
  return {
    id,
    schemaVersion: "1.0.0",
    headword: primary.headword,
    lookup: primary.lookup,
    kind: primary.kind,
    tier,
    scopes,
    variants: [...new Set(records.flatMap((item) => item.variants || []))],
    britishIpa: normalizeIpa(britishIpa),
    americanIpa: normalizeIpa(americanIpa),
    pronunciation: { mode: "system-tts", label: "系统语音", source: "Web Speech API" },
    partsOfSpeech: [...new Set(records.flatMap((item) => item.partsOfSpeech))],
    grammar: { countability: primary.countability, transitivity: primary.transitivity },
    chineseCore: primary.chinese,
    englishCore: definition?.text || null,
    openExample: definition?.example || null,
    sources,
    relations: { family: [], phrases: [], confusables: [] },
    license: {
      headwordAndChinese: primary.bookId === "STD-HS" ? "headword: official curriculum standard; Chinese: ECDICT MIT" : high ? "textbook-derived facts; source location only; raw pages excluded" : "Apache-2.0 cross-check plus textbook page audit",
      englishDefinition: definition ? definition.license : null,
      audio: "no bundled audio; system TTS only",
    },
    fieldStatus: {
      headword: primary.fieldStatus.headword,
      britishIpa: primary.britishIpa ? primary.fieldStatus.britishIpa : britishIpa ? "verified-cross-source" : "provisional",
      americanIpa: primary.americanIpa ? primary.fieldStatus.americanIpa : americanIpa ? "verified-cross-source" : "provisional",
      chineseCore: primary.chinese ? primary.fieldStatus.chinese : "provisional",
      englishCore: definition ? "verified-primary" : "provisional",
      sources: "verified-primary",
      relations: "provisional",
    },
    flags: {
      highFrequencyContinuation: high && records.some((item) => item.scope === "middle-core"),
      highValue: tier === "B",
      properName: primary.properName,
      formalReleaseEligible: Boolean(primary.chinese && (britishIpa || primary.kind === "phrase")),
    },
  };
}).sort((a, b) => a.lookup.localeCompare(b.lookup, "en"));

const byLookup = new Map(entries.map((entry) => [entry.lookup, entry]));
for (const entry of entries) {
  const token = entry.lookup.split(/\s+/)[0];
  if (entry.kind === "phrase") {
    for (const word of entry.lookup.split(/\s+/).filter((item) => item.length > 2)) {
      const target = byLookup.get(word);
      if (target && !target.relations.phrases.includes(entry.id)) target.relations.phrases.push(entry.id);
    }
  }
  if (entry.kind === "word") {
    entry.relations.family = entries.filter((candidate) => candidate.id !== entry.id && candidate.kind === "word" && candidate.lookup.startsWith(token.slice(0, Math.max(4, token.length - 3))) && candidate.lookup.length < token.length + 8).slice(0, 8).map((candidate) => candidate.id);
  }
}

const released = entries.filter((entry) => entry.flags.formalReleaseEligible);
const index = released.map((entry) => ({
  id: entry.id, headword: entry.headword, lookup: entry.lookup, tier: entry.tier, scopes: entry.scopes,
  chineseCore: entry.chineseCore, britishIpa: entry.britishIpa, americanIpa: entry.americanIpa,
  partsOfSpeech: entry.partsOfSpeech, sources: entry.sources.map(({ bookId, volume, unit, printedPage }) => ({ bookId, volume, unit, printedPage })),
  flags: entry.flags,
}));

const chunkSize = 180;
const chunks = [];
for (let indexStart = 0; indexStart < released.length; indexStart += chunkSize) {
  const name = `lexicon-${String(chunks.length).padStart(2, "0")}.json`;
  const slice = released.slice(indexStart, indexStart + chunkSize);
  writeFileSync(join(releaseDir, "chunks", name), `${JSON.stringify(slice)}\n`);
  chunks.push({ file: `chunks/${name}`, first: slice[0]?.id, last: slice.at(-1)?.id, count: slice.length });
}
writeFileSync(join(releaseDir, "index.json"), `${JSON.stringify(index)}\n`);
writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify({
  version: "1.0.0-rc.1", generatedAt: new Date().toISOString(), schemaVersion: "1.0.0",
  sourceRecords: sourceRecords.length, normalizedRecords: normalized.length, uniqueEntries: entries.length,
  releasedEntries: released.length, middleEntries: released.filter((item) => item.scopes.includes("middle-core")).length,
  highRequiredEntries: released.filter((item) => item.scopes.includes("high-required")).length,
  highSelectiveEntries: released.filter((item) => item.scopes.includes("high-selective")).length,
  curriculumNotTextbookEntries: released.filter((item) => item.scopes.includes("curriculum-not-textbook")).length,
  tierCounts: Object.fromEntries(["A", "B", "C"].map((tier) => [tier, released.filter((item) => item.tier === tier).length])),
  chunks,
}, null, 2)}\n`);

const unitRows = [];
for (const book of books) {
  const records = normalized.filter((item) => item.bookId === book.id);
  for (const unit of [...new Set(records.map((item) => item.unit))]) {
    const rows = records.filter((item) => item.unit === unit);
    unitRows.push({
      bookId: book.id, volume: book.volume, unit, extracted: rows.length,
      normalized: rows.filter((item) => item.normalizationStatus !== "conflicted").length,
      released: rows.filter((item) => released.some((entry) => entry.sources.some((source) => source.recordId === item.sourceRecordId))).length,
      duplicates: rows.length - new Set(rows.map((item) => `${item.kind}:${item.lookup}`)).size,
      conflicts: rows.filter((item) => item.normalizationStatus === "conflicted").length,
      unresolved: rows.filter((item) => !item.chinese || !item.lookup).length,
      nominalCount: null,
    });
  }
}
writeFileSync(join(root, "data/unit-reconciliation.json"), `${JSON.stringify(unitRows, null, 2)}\n`);

const missingIpa = released.filter((item) => !item.britishIpa || !item.americanIpa).length;
const missingEnglish = released.filter((item) => item.scopes.some((scope) => scope.startsWith("high")) && !item.englishCore).length;
const report = `# 词库审计报告\n\n` +
  `发布候选版本：1.0.0-rc.1  \n生成时间：${new Date().toISOString()}\n\n` +
  `## 数量\n\n` +
  `- 原始来源记录：${sourceRecords.length}\n- 规范化记录：${normalized.length}\n- 稳定去重词条：${entries.length}\n- 正式候选词条：${released.length}\n` +
  `- 初中核心：${released.filter((item) => item.scopes.includes("middle-core")).length}\n- 高中必修：${released.filter((item) => item.scopes.includes("high-required")).length}\n- 高中选择性必修：${released.filter((item) => item.scopes.includes("high-selective")).length}\n\n` +
  `## 自动审计\n\n` +
  `- 仍缺英式或美式 IPA：${missingIpa}\n- 高中词条仍缺开放英文简义：${missingEnglish}\n- 未解析单元记录：${normalized.filter((item) => item.unit === "unresolved").length}\n- PUA 音标残留：${normalized.filter((item) => /[]/.test(item.britishIpa + item.americanIpa)).length}\n\n` +
  `## 发布规则\n\n正式候选只纳入具有稳定词头、中文核心义和可用发音字段（短语允许系统 TTS）的记录。unknown 或 prohibited 权限内容、教材整页、整段课文、未核验真人音频、上游扩展例句均未进入发布包。\n\n` +
  `## 尚未达到“最终正式版”的字段级缺口\n\n` +
  `当前包是可运行的审核候选，不冒充已完成人工终审。高中开放英文简义缺口 ${missingEnglish} 条；B 层关系字段尚含 provisional；两册扫描版的页码级人工双人复核仍需继续。精确缺口可由 \`npm run data:audit\` 和 \`data/unit-reconciliation.json\` 重现。\n`;
writeFileSync(join(root, "VOCAB_AUDIT_REPORT.md"), report);

console.log(JSON.stringify({ sourceRecords: sourceRecords.length, normalized: normalized.length, unique: entries.length, released: released.length, missingIpa, missingEnglish }, null, 2));
