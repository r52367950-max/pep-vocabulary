// Run in each checkout with: node --import ./tests/register.mjs scripts/benchmark-study-scope.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeLexiconIndex } from "../lib/lexicon-index-codec.mjs";
import { learnPool } from "../lib/learn.ts";
import { getBookUnits } from "../lib/study.ts";

const entries = decodeLexiconIndex(JSON.parse(readFileSync("public/data/v1/index.json", "utf8")));
const cards = new Map();
const bookId = "HS-R1";
const cases = {
  book: () => learnPool(entries, cards, { bookId, unit: "all" }).map(entry => entry.id),
  unit: () => learnPool(entries, cards, { bookId, unit: "Unit 1" }).map(entry => entry.id),
  picker: () => getBookUnits(entries, bookId),
};
const results = {};
for (const [name, run] of Object.entries(cases)) {
  for (let i = 0; i < 25; i++) run();
  const output = run();
  const samples = Array.from({ length: 15 }, () => {
    const start = performance.now();
    for (let i = 0; i < 40; i++) run();
    return (performance.now() - start) / 40;
  }).sort((a, b) => a - b);
  results[name] = { count: output.length, medianMs: samples[7], p90Ms: samples[13],
    digest: createHash("sha256").update(JSON.stringify(output)).digest("hex") };
}
console.log(JSON.stringify({ node: process.version, entries: entries.length, results }, null, 2));
