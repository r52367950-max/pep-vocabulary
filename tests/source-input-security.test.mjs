import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { containedSourcePath, middleSourceRows, readPinnedSource, snapshotSourceInputs, validateSourceLock } from "../scripts/source-inputs.mjs";

function setup(t) {
  const parent = mkdtempSync(join(tmpdir(), "source-input-test-"));
  const root = join(parent, "cache");
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const lock = { schemaVersion: 1, files: {} };
  const put = (name, value) => {
    const bytes = Buffer.from(value);
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    lock.files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  return { parent, root, lock, put };
}

test("reviewed inputs are copied byte-for-byte and later cache tampering cannot alter the parser snapshot", (t) => {
  const { root, lock, put } = setup(t);
  put("dictionary.txt", "reviewed words");
  const snapshot = snapshotSourceInputs(root, lock, { requireLexiconInputs: false });
  t.after(snapshot.cleanup);
  assert.equal(readFileSync(join(snapshot.root, "dictionary.txt"), "utf8"), "reviewed words");
  writeFileSync(join(root, "dictionary.txt"), "poisoned words");
  assert.equal(readFileSync(join(snapshot.root, "dictionary.txt"), "utf8"), "reviewed words");
  assert.throws(() => readPinnedSource(root, lock, "dictionary.txt"), /digest differs/);
});

test("modified bytes, missing pins and missing required files fail closed without rewriting the lock", (t) => {
  const { root, lock, put } = setup(t);
  put("dictionary.txt", "reviewed");
  const originalLock = structuredClone(lock);
  writeFileSync(join(root, "dictionary.txt"), "changed");
  assert.throws(() => snapshotSourceInputs(root, lock, { requireLexiconInputs: false }), /size differs/);
  put("dictionary.txt", "reviewed");
  assert.throws(() => snapshotSourceInputs(root, lock, { requireLexiconInputs: false, requiredFiles: ["unknown.txt"] }), /No reviewed source pin/);
  assert.deepEqual(lock, originalLock);
  rmSync(join(root, "dictionary.txt"));
  assert.throws(() => snapshotSourceInputs(root, lock, { requireLexiconInputs: false }), /ENOENT/);
});

test("metadata paths reject traversal, absolute paths, Windows drives and backslashes", (t) => {
  const { root, parent, put } = setup(t);
  put("allowed.md", "## 1. word\n**词**");
  writeFileSync(join(parent, "outside.md"), "## 1. secret\n**私人文本**");
  for (const file of ["../outside.md", join(parent, "outside.md"), "folder/../../outside.md", "C:/outside.md", "..\\outside.md", "allowed/../allowed.md"]) {
    assert.throws(() => middleSourceRows(`${file}\t人教版初中英语-七年级上册/01_words.md`), /Unsafe source path/);
    assert.throws(() => containedSourcePath(root, file), /Unsafe source path/);
  }
  assert.deepEqual(middleSourceRows("allowed.md\t人教版初中英语-七年级上册/01_words.md"), [{ file: "open-data/mikigo-middle/allowed.md", source: "人教版初中英语-七年级上册/01_words.md" }]);
});

test("file and directory symlinks cannot escape the authorized source cache", (t) => {
  const { root, parent, lock, put } = setup(t);
  put("inside.txt", "reviewed");
  writeFileSync(join(parent, "outside.txt"), "reviewed");
  symlinkSync(join(parent, "outside.txt"), join(root, "linked.txt"));
  lock.files["linked.txt"] = lock.files["inside.txt"];
  assert.throws(() => readPinnedSource(root, lock, "linked.txt"), /escapes cache/);
  symlinkSync(parent, join(root, "directory-link"));
  assert.throws(() => containedSourcePath(root, "directory-link/outside.txt"), /escapes cache/);
});

test("middle metadata and every consumed OEWN/Markdown file need independently reviewed pins", (t) => {
  const { root, lock, put } = setup(t);
  const metadata = "open-data/mikigo-middle/files_complete.tsv";
  const markdown = "open-data/mikigo-middle/words.md";
  const entries = "open-data/oewn/2025-plus-json/entries-a.json";
  const synsets = "open-data/oewn/2025-plus-json/noun.test.json";
  put(metadata, "words.md\t人教版初中英语-七年级上册/01_words.md");
  put(markdown, "## 1. word\n**词**");
  put(entries, '{"word":{}}');
  put(synsets, '{"word-n":{"definition":["a word"]}}');
  const pin = lock.files[markdown];
  delete lock.files[markdown];
  assert.throws(() => snapshotSourceInputs(root, lock), /No reviewed source pin.*words\.md/);
  lock.files[markdown] = pin;
  writeFileSync(join(root, "open-data/oewn/2025-plus-json/entries-extra.json"), "{}");
  assert.throws(() => snapshotSourceInputs(root, lock), /No reviewed source pin.*entries-extra/);
  rmSync(join(root, "open-data/oewn/2025-plus-json/entries-extra.json"));
  const snapshot = snapshotSourceInputs(root, lock);
  t.after(snapshot.cleanup);
  for (const name of [metadata, markdown, entries, synsets]) assert.deepEqual(readFileSync(join(snapshot.root, name)), readFileSync(join(root, name)));
  assert.deepEqual(readdirSync(join(snapshot.root, "open-data/oewn/2025-plus-json")).sort(), ["entries-a.json", "noun.test.json"]);
});

test("a pinned metadata row still cannot point outside its cache and incomplete dictionaries are rejected", (t) => {
  const { root, lock, put } = setup(t);
  put("open-data/mikigo-middle/files_complete.tsv", "../../outside.md\t人教版初中英语-七年级上册/01_words.md");
  assert.throws(() => snapshotSourceInputs(root, lock), /Unsafe source path/);
  put("open-data/mikigo-middle/files_complete.tsv", "words.md\t人教版初中英语-七年级上册/01_words.md");
  put("open-data/mikigo-middle/words.md", "## 1. word\n**词**");
  put("open-data/oewn/2025-plus-json/entries-a.json", "{}");
  assert.throws(() => snapshotSourceInputs(root, lock), /OEWN parsed source files are missing/);
});

test("the checked-in source lock separates baseline evidence from missing reviewed hashes", () => {
  const baseline = JSON.parse(readFileSync(new URL("../source_manifest.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../config/source-input-lock.json", import.meta.url)));
  validateSourceLock(lock);
  assert.equal(Object.keys(lock.files).length, 18);
  for (const [name, pin] of Object.entries(lock.files)) {
    const observed = baseline.entries.find((entry) => entry.id === pin.sourceId);
    assert.ok(observed.path.endsWith(`/${name}`));
    assert.equal(pin.sha256, observed.sha256);
    assert.equal(pin.bytes, observed.bytes);
  }
  assert.match(lock.basis, /not independent upstream authenticity/);
  assert.ok(lock.pending.some((item) => item.includes("mikigo-middle")));
});

function sourceReadRace(t, root, swap) {
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let reads = 0;
  let swapped = false;
  t.mock.method(fs, "openSync", (path, flags, ...args) => {
    if (!swapped && String(path).startsWith(`${root}/`)) { swapped = true; swap(path, flags); }
    return originalOpen(path, flags, ...args);
  });
  t.mock.method(fs, "readSync", (...args) => { reads += 1; return originalRead(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => reads;
}

test("replacing the file with an external symlink between pathname checks and open reads no bytes", (t) => {
  const { root, parent, lock, put } = setup(t);
  put("words.txt", "reviewed");
  const outside = join(parent, "outside.txt");
  writeFileSync(outside, "reviewed");
  const reads = sourceReadRace(t, root, (path, flags) => {
    assert.ok(flags & fs.constants.O_NOFOLLOW);
    rmSync(path);
    symlinkSync(outside, path);
  });
  assert.throws(() => readPinnedSource(root, lock, "words.txt"), /ELOOP/);
  assert.equal(reads(), 0);
});

test("replacing a directory component with an external same-byte source is rejected on the opened handle", (t) => {
  const { root, parent, lock, put } = setup(t);
  put("nested/words.txt", "reviewed");
  const outside = join(parent, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "words.txt"), "reviewed");
  const reads = sourceReadRace(t, root, () => {
    renameSync(join(root, "nested"), join(root, "original-nested"));
    symlinkSync(outside, join(root, "nested"));
  });
  assert.throws(() => readPinnedSource(root, lock, "nested/words.txt"), /Opened source escapes cache/);
  assert.equal(reads(), 0);
});

test("a larger regular file substituted before open fails the descriptor size check before any read", (t) => {
  const { root, lock, put } = setup(t);
  put("words.txt", "reviewed");
  const reads = sourceReadRace(t, root, (path) => { writeFileSync(path, Buffer.alloc(1024 * 1024)); });
  assert.throws(() => readPinnedSource(root, lock, "words.txt"), /size differs/);
  assert.equal(reads(), 0);
});

test("growth during a descriptor read consumes at most the pinned size plus one-byte probe", (t) => {
  const { root, lock, put } = setup(t);
  put("words.txt", "reviewed");
  const originalRead = fs.readSync;
  let bytesRead = 0;
  let mutated = false;
  t.mock.method(fs, "readSync", (...args) => {
    if (!mutated) { mutated = true; appendFileSync(join(root, "words.txt"), Buffer.alloc(1024 * 1024)); }
    const count = originalRead(...args);
    bytesRead += count;
    return count;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => readPinnedSource(root, lock, "words.txt"), /changed during bounded read/);
  assert.ok(bytesRead <= lock.files["words.txt"].bytes + 1);
});
