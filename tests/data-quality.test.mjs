import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const books = json("config/books.json");
const sources = json("source_manifest.json");
const manifest = json("public/data/v1/manifest.json");
const reconciliation = json("data/unit-reconciliation.json");
const entries = manifest.chunks.flatMap((chunk) => json(`public/data/v1/${chunk.file}`));

test("all twelve target textbooks have source and unit evidence", () => {
  assert.equal(books.length, 12);
  const ids = new Set(sources.entries.map((entry) => entry.id));
  for (const book of books) {
    assert.ok(ids.has(book.id), `source manifest missing ${book.id}`);
    assert.ok(reconciliation.some((row) => row.bookId === book.id), `reconciliation missing ${book.id}`);
  }
});

test("release records have stable unique IDs and traceable required fields", () => {
  assert.equal(entries.length, manifest.releasedEntries);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.match(entry.id, /^pep-[a-f0-9]{16}$/);
    assert.ok(entry.headword);
    assert.ok(entry.chineseCore);
    assert.ok(entry.scopes.length);
    assert.ok(entry.sources.length);
  }
});

test("release contains no private-use glyphs or unsafe rights labels", () => {
  for (const entry of entries) {
    assert.doesNotMatch(`${entry.headword}${entry.britishIpa}${entry.americanIpa}`, /[\uE000-\uF8FF]/);
    assert.doesNotMatch(`${entry.britishIpa}${entry.americanIpa}`, /[{}%@/]/);
    assert.doesNotMatch(JSON.stringify(entry.license), /unknown|prohibited/i);
  }
});

test("middle and high scopes remain independently filterable", () => {
  assert.ok(entries.some((entry) => entry.scopes.includes("middle-core")));
  assert.ok(entries.some((entry) => entry.scopes.includes("high-required")));
  assert.ok(entries.some((entry) => entry.scopes.includes("high-selective")));
  assert.ok(entries.some((entry) => entry.scopes.includes("curriculum-not-textbook")));
});

test("official high-school curriculum extraction is deterministic", () => {
  const rows = readFileSync(join(root, "data/build/raw/STD-HS.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2997);
  assert.deepEqual([...new Set(rows.map((row) => row.curriculumLevel))].sort(), ["compulsory-baseline", "required", "selective-required"]);
  assert.ok(rows.every((row) => row.sourceStatus === "verified-primary"));
});
