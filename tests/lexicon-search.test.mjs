import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import { rankWeakMemory, searchLexicon } from "../lib/lexicon-search.ts";

const root = resolve(import.meta.dirname, "..");
const index = JSON.parse(readFileSync(join(root, "public/data/v1/index.json"), "utf8"));
const emptyCards = new Map();

test("natural-language group searches return complete scoped batches", () => {
  const middle = searchLexicon(index, "初中单词", emptyCards);
  assert.equal(middle.length, index.filter((entry) => entry.scopes.includes("middle-core")).length);
  assert.ok(middle.every((entry) => entry.scopes.includes("middle-core")));

  const unit = searchLexicon(index, "必修一 Unit 3", emptyCards);
  assert.ok(unit.length > 40);
  assert.ok(unit.every((entry) => entry.sources.some((source) => source.bookId === "HS-R1" && source.unit === "Unit 3")));

  const gaokao = searchLexicon(index, "高考高频词", emptyCards);
  assert.ok(gaokao.length >= 200);
  assert.ok(gaokao.every((entry) => entry.scopes.includes("gaokao-supplement")));
});

test("weak-memory ranking is capped at the requested top 100", () => {
  const cards = new Map(index.slice(0, 140).map((entry, position) => [entry.id, {
    id: entry.id,
    status: position % 3 === 0 ? "weak" : "learning",
    lastReviewed: "2026-08-01T00:00:00.000Z",
    due: "2026-08-02T00:00:00.000Z",
    skills: { meaning: .2, listening: .3, spelling: .25, context: .4, collocation: .35, output: .3 },
    fsrs: { difficulty: 6, stability: 1 },
  }]));
  const ranked = rankWeakMemory(index, cards, [], 100);
  assert.equal(ranked.length, 100);
  assert.equal(new Set(ranked.map((entry) => entry.id)).size, 100);
});
