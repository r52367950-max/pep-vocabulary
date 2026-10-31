import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readContainedSource, sourceRelativePath } from "./source-inputs.mjs";

// Inspection only: stdout is a review candidate, never written to the trusted lock.
const [cache, ...names] = process.argv.slice(2);
if (!cache || !names.length) throw new Error("Usage: node scripts/source-pin-candidates.mjs <cache-root> <relative-file> ...");
const files = {};
for (const name of names) {
  sourceRelativePath(name);
  const bytes = readContainedSource(resolve(cache), name);
  files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
console.log(JSON.stringify({ status: "unreviewed-candidate", files }, null, 2));
