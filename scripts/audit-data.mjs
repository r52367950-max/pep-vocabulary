import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const books = readJson("config/books.json");
const sourceManifest = readJson("source_manifest.json");
const releaseManifest = readJson("public/data/v1/manifest.json");
const reconciliation = readJson("data/unit-reconciliation.json");
const entries = releaseManifest.chunks.flatMap((chunk) => readJson(`public/data/v1/${chunk.file}`));
const standard = readFileSync(join(root, "data/build/raw/STD-HS.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

const errors = [];
const warnings = [];
const ids = new Set();
for (const entry of entries) {
  if (!entry.id || !entry.headword || !entry.chineseCore || !entry.scopes?.length || !entry.sources?.length) errors.push(`required-field:${entry.id || entry.headword || "unknown"}`);
  if (ids.has(entry.id)) errors.push(`duplicate-id:${entry.id}`);
  ids.add(entry.id);
  if (/[\uE000-\uF8FF]/.test(`${entry.headword}${entry.britishIpa}${entry.americanIpa}`)) errors.push(`private-use-character:${entry.id}`);
  if (/[{}%@/]/.test(`${entry.britishIpa}${entry.americanIpa}`)) errors.push(`malformed-ipa:${entry.id}`);
  const rights = JSON.stringify(entry.license).toLowerCase();
  if (rights.includes("unknown") || rights.includes("prohibited")) errors.push(`unsafe-rights:${entry.id}`);
}

const sourceBookIds = new Set(sourceManifest.entries.filter((entry) => entry.id.startsWith("HS-") || entry.id.startsWith("JH-")).map((entry) => entry.id));
for (const book of books) {
  if (!sourceBookIds.has(book.id)) errors.push(`missing-source:${book.id}`);
  if (!reconciliation.some((row) => row.bookId === book.id && row.unit !== "unresolved")) errors.push(`missing-reconciliation:${book.id}`);
}

const missingEnglish = entries.filter((entry) => entry.scopes.some((scope) => scope.startsWith("high")) && !entry.englishCore).map((entry) => entry.id);
const missingIpa = entries.filter((entry) => !entry.britishIpa || !entry.americanIpa).map((entry) => entry.id);
const unresolvedRows = reconciliation.filter((row) => row.unresolved > 0);
if (missingEnglish.length) warnings.push(`${missingEnglish.length} high-scope entries lack an open English definition`);
if (missingIpa.length) warnings.push(`${missingIpa.length} entries rely on system TTS without complete IPA`);
if (unresolvedRows.length) warnings.push(`${unresolvedRows.length} unit rows contain field-level unresolved records`);
if (standard.length !== 2997) errors.push(`curriculum-headword-count:${standard.length}`);

const summary = {
  auditedAt: new Date().toISOString(),
  status: errors.length ? "failed" : warnings.length ? "release-candidate-with-declared-gaps" : "passed",
  counts: {
    targetTextbooks: books.length,
    sourceManifestEntries: sourceManifest.entries.length,
    curriculumHeadwordRows: standard.length,
    releasedEntries: entries.length,
    missingEnglishDefinitions: missingEnglish.length,
    missingCompleteIpa: missingIpa.length,
    unitRowsWithUnresolvedFields: unresolvedRows.length,
  },
  errors,
  warnings,
  gapSamples: {
    missingEnglishDefinitions: entries.filter((entry) => missingEnglish.includes(entry.id)).slice(0, 50).map(({ id, headword, sources }) => ({ id, headword, sources })),
    incompleteIpa: entries.filter((entry) => missingIpa.includes(entry.id)).slice(0, 50).map(({ id, headword, sources }) => ({ id, headword, sources })),
    unresolvedUnitRows: unresolvedRows,
  },
};
writeFileSync(join(root, "data/audit-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.counts, null, 2));
console.log(`audit status: ${summary.status}`);
if (errors.length) process.exitCode = 1;
