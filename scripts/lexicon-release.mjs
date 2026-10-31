import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const chunkPath = /^chunks\/lexicon-\d{2,}\.json$/;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function lexiconIndexEntry(entry) {
  return {
    id: entry.id, headword: entry.headword, lookup: entry.lookup, tier: entry.tier, scopes: entry.scopes,
    chineseCore: entry.chineseCore, britishIpa: entry.britishIpa, americanIpa: entry.americanIpa,
    partsOfSpeech: entry.partsOfSpeech,
    sources: entry.sources.map(({ bookId, volume, unit, printedPage }) => ({ bookId, volume, unit, printedPage })),
    flags: entry.flags,
  };
}

// The release root is generated data, not a source/user-upload directory.
export function validateLexiconRelease(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Release root must be a real directory");
  const files = [];
  function visit(path, prefix = "") {
    for (const name of readdirSync(path)) {
      const relative = `${prefix}${name}`;
      const stat = lstatSync(join(path, name));
      if (stat.isSymbolicLink()) throw new Error(`Release symlink is forbidden: ${relative}`);
      if (stat.isDirectory()) {
        if (relative !== "chunks") throw new Error(`Undeclared release directory: ${relative}`);
        visit(join(path, name), `${relative}/`);
      } else if (stat.isFile()) files.push(relative);
      else throw new Error(`Release file must be regular: ${relative}`);
    }
  }
  visit(directory);
  const manifest = readJson(join(directory, "manifest.json"));
  if (!Array.isArray(manifest.chunks) || !Number.isSafeInteger(manifest.releasedEntries) || manifest.releasedEntries <= 0) throw new Error("Invalid release manifest");
  const expected = new Set(["manifest.json", "index.json"]);
  for (const chunk of manifest.chunks) {
    if (!chunk || typeof chunk.file !== "string" || !chunkPath.test(chunk.file) || expected.has(chunk.file)) throw new Error(`Invalid or duplicate chunk declaration: ${chunk?.file}`);
    if (!Number.isSafeInteger(chunk.count) || chunk.count <= 0) throw new Error(`Invalid chunk count: ${chunk.file}`);
    expected.add(chunk.file);
  }
  const actual = new Set(files);
  for (const file of actual) if (!expected.has(file)) throw new Error(`Undeclared release file: ${file}`);
  for (const file of expected) if (!actual.has(file)) throw new Error(`Missing release file: ${file}`);
  const entries = manifest.chunks.flatMap((chunk) => {
    const values = readJson(join(directory, chunk.file));
    if (!Array.isArray(values) || values.length !== chunk.count || values[0]?.id !== chunk.first || values.at(-1)?.id !== chunk.last) throw new Error(`Chunk metadata mismatch: ${chunk.file}`);
    return values;
  });
  const index = readJson(join(directory, "index.json"));
  if (entries.length !== manifest.releasedEntries || !Array.isArray(index) || index.length !== entries.length) throw new Error("Release entry count mismatch");
  const ids = new Set();
  entries.forEach((entry, position) => {
    if (!entry || !/^pep-[a-f0-9]{16}$/.test(entry.id) || typeof entry.headword !== "string" || !entry.headword || typeof entry.lookup !== "string" || !entry.lookup || typeof entry.chineseCore !== "string" || !entry.chineseCore || !Array.isArray(entry.scopes) || !entry.scopes.length || !Array.isArray(entry.sources) || !entry.sources.length || ids.has(entry.id)) throw new Error(`Invalid or duplicate release entry: ${entry?.id}`);
    if (!["A", "B", "C"].includes(entry.tier) || !entry.scopes.every((scope) => typeof scope === "string" && scope) || typeof entry.britishIpa !== "string" || typeof entry.americanIpa !== "string" || !Array.isArray(entry.partsOfSpeech) || !entry.partsOfSpeech.every((value) => typeof value === "string") || !entry.flags || ["highFrequencyContinuation", "highValue", "properName", "formalReleaseEligible"].some((key) => typeof entry.flags[key] !== "boolean") || !entry.sources.every((source) => source && ["bookId", "volume", "unit"].every((key) => typeof source[key] === "string" && source[key]) && (source.printedPage === null || (Number.isSafeInteger(source.printedPage) && source.printedPage > 0)))) throw new Error(`Invalid index source fields: ${entry.id}`);
    ids.add(entry.id);
    if (/[\uE000-\uF8FF]/.test(`${entry.headword}${entry.britishIpa}${entry.americanIpa}`) || /[{}%@/]/.test(`${entry.britishIpa}${entry.americanIpa}`)) throw new Error(`Invalid phonetic fields: ${entry.id}`);
    if (!entry.license || /unknown|prohibited/i.test(JSON.stringify(entry.license))) throw new Error(`Unsafe release rights: ${entry.id}`);
    // JSON normalizes optional undefined source fields exactly as the builder
    // does; object-key order has no semantic role in a generated release.
    const projection = JSON.parse(JSON.stringify(lexiconIndexEntry(entry)));
    if (!isDeepStrictEqual(index[position], projection)) throw new Error(`Index mismatch: ${entry.id}`);
  });
  return { manifest, index, entries };
}

export function createReleaseStage(target) {
  return mkdtempSync(join(dirname(target), ".lexicon-stage-"));
}

export function publishLexiconRelease(stage, target, { move = renameSync, additionalOutputs = [] } = {}) {
  validateLexiconRelease(stage);
  // Refuse to silently delete unexpected files from an existing release tree.
  let previous = false;
  try { lstatSync(target); previous = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous) validateLexiconRelease(target);
  const backup = mkdtempSync(join(dirname(target), ".lexicon-previous-"));
  const plans = [{ source: stage, target, temporary: backup, saved: join(backup, "release"), previous, installed: false, displaced: false }];
  let recovered = true;
  try {
    // Prepare every generated evidence file before exchanging any live output.
    const targets = new Set([target]);
    for (const [path, text] of additionalOutputs) {
      if (targets.has(path)) throw new Error(`Duplicate generated output: ${path}`);
      targets.add(path);
      let existing = false;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Generated output must be a regular file: ${path}`);
        existing = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = mkdtempSync(join(dirname(path), ".lexicon-output-"));
      const source = join(temporary, "new");
      plans.push({ source, target: path, temporary, saved: join(temporary, "previous"), previous: existing, installed: false, displaced: false });
      writeFileSync(source, text, { flag: "wx" });
    }
    for (const plan of plans) {
      if (plan.previous) { move(plan.target, plan.saved); plan.displaced = true; }
      move(plan.source, plan.target);
      plan.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of plans.toReversed()) {
      try {
        if (plan.installed) rmSync(plan.target, { recursive: true, force: true });
        if (plan.displaced) renameSync(plan.saved, plan.target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      recovered = false;
      throw new AggregateError([error, ...rollbackErrors], `Release exchange and rollback failed; recovery directories: ${plans.map((plan) => plan.temporary).join(", ")}`);
    }
    throw error;
  } finally {
    // If rollback itself fails, preserve previous outputs for manual recovery.
    if (recovered) for (const plan of plans) rmSync(plan.temporary, { recursive: true, force: true });
  }
}
