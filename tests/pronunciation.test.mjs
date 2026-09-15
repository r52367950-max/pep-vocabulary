import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizePronunciations } from "../lib/lexicon.ts";

test("legacy regional labels are separated while abbreviated American IPA remains unverified", () => {
  const original = { britishIpa: "ˈætɪtjuːd; ŋɑmE ˈætɪtuːd", americanIpa: "ˈætɪtjuːd; ŋɑmE ˈætɪtuːd" };
  const fixed = normalizePronunciations(original);
  assert.equal(fixed.britishIpa, "ˈætɪtjuːd");
  assert.equal(fixed.americanIpa, "ˈætɪtuːd");
  assert.match(original.britishIpa, /ŋɑmE/);
  const abbreviated = normalizePronunciations({ britishIpa: "ədˈvɜːtɪsmənt; NAmE ˌædvərˈtaɪz-", americanIpa: "ədˈvɜːtɪsmənt; NAmE ˌædvərˈtaɪz-", fieldStatus: { americanIpa: "verified-primary" } });
  assert.equal(abbreviated.americanIpa, "");
  assert.equal(abbreviated.fieldStatus.americanIpa, "provisional");
  assert.strictEqual(normalizePronunciations(fixed), fixed);
});

test("all released regional-label artifacts are removed at the display boundary without changing IDs", () => {
  const entries = JSON.parse(readFileSync(new URL("../public/data/v1/index.json", import.meta.url), "utf8"));
  const originalIds = entries.map(entry => entry.id);
  const normalized = entries.map(normalizePronunciations);
  assert.deepEqual(normalized.map(entry => entry.id), originalIds);
  assert.ok(normalized.every(entry => !/NAmE|ŋɑmE/.test(entry.britishIpa + entry.americanIpa)));
  const attitude = normalized.find(entry => entry.headword === "attitude");
  assert.equal(attitude.americanIpa, "ˈætɪtuːd");
});
