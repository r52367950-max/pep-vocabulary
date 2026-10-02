import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lexiconIndexEntry, publishLexiconRelease, validateLexiconRelease } from "../scripts/lexicon-release.mjs";

const entry = (id, word = "word") => ({ id: `pep-${id.repeat(16)}`, headword: word, lookup: word, tier: "C", chineseCore: "词", britishIpa: "wɜːd", americanIpa: "wɜːrd", partsOfSpeech: ["n"], scopes: ["middle-core"], sources: [{ bookId: "JH-7A", volume: "七年级上册", unit: "Unit 1", printedPage: 1, physicalPage: 24 }], flags: { highFrequencyContinuation: false, highValue: false, properName: false, formalReleaseEligible: true }, license: { headwordAndChinese: "Apache-2.0" } });
function fixture(directory, groups = [[entry("a")]]) {
  mkdirSync(join(directory, "chunks"), { recursive: true });
  const chunks = groups.map((items, position) => {
    const file = `chunks/lexicon-${String(position).padStart(2, "0")}.json`;
    writeFileSync(join(directory, file), JSON.stringify(items));
    return { file, count: items.length, first: items[0].id, last: items.at(-1).id };
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ releasedEntries: groups.flat().length, chunks }));
  writeFileSync(join(directory, "index.json"), JSON.stringify(groups.flat().map(lexiconIndexEntry)));
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "lexicon-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "release");
  const stage = join(root, "stage");
  return { root, target, stage };
}

test("release validation covers the complete physical tree, including undeclared stale chunks", (t) => {
  const { target } = setup(t);
  fixture(target);
  assert.equal(validateLexiconRelease(target).entries.length, 1);
  writeFileSync(join(target, "chunks/lexicon-27.json"), JSON.stringify([entry("b")]));
  assert.throws(() => validateLexiconRelease(target), /Undeclared release file/);
});

test("release validation rejects missing files, duplicate/path-escaping declarations and symlinks", (t) => {
  const { target, root } = setup(t);
  fixture(target);
  const path = join(target, "manifest.json");
  const manifest = JSON.parse(readFileSync(path));
  for (const file of ["../private.json", "/private.json", "chunks/../index.json"]) {
    writeFileSync(path, JSON.stringify({ ...manifest, chunks: [{ ...manifest.chunks[0], file }] }));
    assert.throws(() => validateLexiconRelease(target), /Invalid or duplicate/);
  }
  writeFileSync(path, JSON.stringify({ ...manifest, chunks: [...manifest.chunks, manifest.chunks[0]] }));
  assert.throws(() => validateLexiconRelease(target), /Invalid or duplicate/);
  writeFileSync(path, JSON.stringify(manifest));
  rmSync(join(target, manifest.chunks[0].file));
  assert.throws(() => validateLexiconRelease(target), /Missing release file/);
  writeFileSync(join(root, "outside.json"), JSON.stringify([entry("a")]));
  symlinkSync(join(root, "outside.json"), join(target, manifest.chunks[0].file));
  assert.throws(() => validateLexiconRelease(target), /symlink/);
});

test("release validation checks chunk counts, index and every published phonetic/rights field", (t) => {
  const { target } = setup(t);
  fixture(target);
  const file = join(target, "chunks/lexicon-00.json");
  writeFileSync(file, JSON.stringify([entry("a"), entry("b")]));
  assert.throws(() => validateLexiconRelease(target), /metadata mismatch/);
  const invalid = entry("a");
  invalid.britishIpa = "\uE000";
  writeFileSync(file, JSON.stringify([invalid]));
  assert.throws(() => validateLexiconRelease(target), /phonetic/);
  invalid.britishIpa = "wɜːd";
  invalid.license.headwordAndChinese = "prohibited";
  writeFileSync(file, JSON.stringify([invalid]));
  assert.throws(() => validateLexiconRelease(target), /rights/);
  writeFileSync(file, JSON.stringify([entry("a")]));
  writeFileSync(join(target, "index.json"), JSON.stringify([entry("b")]));
  assert.throws(() => validateLexiconRelease(target), /Index mismatch/);
});

test("a smaller successful staged release removes old declared chunks and retains stable entry bytes", (t) => {
  const { target, stage } = setup(t);
  const retained = entry("a");
  fixture(target, [[retained], [entry("b")]]);
  fixture(stage, [[retained]]);
  publishLexiconRelease(stage, target);
  assert.deepEqual(validateLexiconRelease(target).entries, [retained]);
  assert.equal(existsSync(join(target, "chunks/lexicon-01.json")), false);
  assert.equal(existsSync(stage), false);
});

test("invalid staged content never modifies the prior release", (t) => {
  const { target, stage } = setup(t);
  fixture(target);
  fixture(stage, [[entry("b")]]);
  writeFileSync(join(stage, "extra.json"), "{}");
  const before = readFileSync(join(target, "manifest.json"));
  assert.throws(() => publishLexiconRelease(stage, target), /Undeclared/);
  assert.deepEqual(readFileSync(join(target, "manifest.json")), before);
  assert.equal(validateLexiconRelease(target).entries[0].id, entry("a").id);
});

test("failed directory exchange rolls back the complete prior release", (t) => {
  const { target, stage } = setup(t);
  fixture(target, [[entry("a")], [entry("b")]]);
  fixture(stage, [[entry("c")]]);
  let moves = 0;
  assert.throws(() => publishLexiconRelease(stage, target, { move: (from, to) => {
    if (++moves === 2) throw new Error("simulated disk failure");
    renameSync(from, to);
  } }), /simulated disk failure/);
  assert.deepEqual(validateLexiconRelease(target).entries, [entry("a"), entry("b")]);
  assert.equal(existsSync(stage), true);
});

test("unknown files in the existing tree are refused rather than silently deleted", (t) => {
  const { target, stage } = setup(t);
  fixture(target);
  fixture(stage);
  writeFileSync(join(target, "private.txt"), "operator content");
  assert.throws(() => publishLexiconRelease(stage, target), /Undeclared/);
  assert.equal(readFileSync(join(target, "private.txt"), "utf8"), "operator content");
});

test("a later evidence-file write failure restores both the release and build records", (t) => {
  const { root, target, stage } = setup(t);
  fixture(target, [[entry("a")], [entry("b")]]);
  fixture(stage, [[entry("c")]]);
  const records = join(root, "records.jsonl");
  writeFileSync(records, "prior verified records");
  let moves = 0;
  assert.throws(() => publishLexiconRelease(stage, target, {
    additionalOutputs: [[records, "new verified records"]],
    move: (from, to) => {
      if (++moves === 4) throw new Error("simulated evidence failure");
      renameSync(from, to);
    },
  }), /simulated evidence failure/);
  assert.deepEqual(validateLexiconRelease(target).entries, [entry("a"), entry("b")]);
  assert.equal(readFileSync(records, "utf8"), "prior verified records");
});

test("a successful release and generated evidence are exchanged together", (t) => {
  const { root, target, stage } = setup(t);
  fixture(target, [[entry("a")], [entry("b")]]);
  fixture(stage, [[entry("a")]]);
  const records = join(root, "records.jsonl");
  writeFileSync(records, "prior records");
  const added = join(root, "new-audit.json");
  publishLexiconRelease(stage, target, { additionalOutputs: [[records, "verified records"], [added, "verified audit"]] });
  assert.deepEqual(validateLexiconRelease(target).entries, [entry("a")]);
  assert.equal(readFileSync(records, "utf8"), "verified records");
  assert.equal(readFileSync(added, "utf8"), "verified audit");
});

test("every field of the index must match the audited chunk projection", (t) => {
  const { target } = setup(t);
  fixture(target);
  const file = join(target, "index.json");
  const original = JSON.parse(readFileSync(file));
  const mutations = [
    (row) => { row.tier = "A"; },
    (row) => { row.scopes = ["high-required"]; },
    (row) => { row.chineseCore = "不同的意思"; },
    (row) => { row.britishIpa = "\uE000"; },
    (row) => { row.americanIpa = "different"; },
    (row) => { row.partsOfSpeech = ["v"]; },
    (row) => { row.sources[0].bookId = "HS-R1"; },
    (row) => { row.sources[0].volume = "另一本"; },
    (row) => { row.sources[0].unit = "Unit 2"; },
    (row) => { row.sources[0].printedPage = 2; },
    (row) => { row.flags.formalReleaseEligible = false; },
    (row) => { delete row.chineseCore; },
  ];
  for (const mutate of mutations) {
    const modified = structuredClone(original);
    mutate(modified[0]);
    writeFileSync(file, JSON.stringify(modified));
    assert.throws(() => validateLexiconRelease(target), /Index mismatch/);
  }
  // Key-order changes retain the same data and remain compatible.
  writeFileSync(file, JSON.stringify(original.map((row) => Object.fromEntries(Object.entries(row).reverse()))));
  assert.equal(validateLexiconRelease(target).entries[0].id, entry("a").id);
});

test("the actual committed release has all 4681 index projections intact", () => {
  const { manifest, entries } = validateLexiconRelease(new URL("../public/data/v1/", import.meta.url).pathname);
  assert.equal(entries.length, 4681);
  assert.equal(manifest.chunks.length, 27);
});
