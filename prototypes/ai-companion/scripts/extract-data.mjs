// Extracts the prototype's sample data from the released product data.
// Run from the repository root:
//   node --import ./tests/register.mjs prototypes/ai-companion/scripts/extract-data.mjs
// Output: prototypes/ai-companion/src/data/sample.json (committed; regenerate after data releases).
import { readFile, writeFile } from "node:fs/promises";
import { decodeLexiconIndex } from "../../../lib/lexicon-index-codec.mjs";
import { englishTokens, lemmaCandidates } from "../src/lexicon-match.ts";

const root = new URL("../../../", import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const ARTICLE_ID = "noaa-mangroves";
/** Words used by the sample plan, in the order the plan offers them. */
const PRACTICE = [
  ["HS-R1", "Unit 4", ["evacuate", "emergency", "electricity", "drought", "disaster", "landslide", "helicopter", "destroy", "damage", "effort", "breathe", "context"]],
  ["HS-R1", "Welcome Unit", ["concentrate", "awkward", "curious", "anxious", "impression", "confident", "organise", "explore"]],
];

const manifest = await read("public/data/v1/manifest.json");
const entries = decodeLexiconIndex(await read("public/data/v1/index.json"));
const article = await read(`public/readings/v1/articles/${ARTICLE_ID}.json`);

const byHeadword = new Map();
for (const entry of entries) {
  const key = entry.headword.toLowerCase();
  if (!byHeadword.has(key)) byHeadword.set(key, entry);
}
const pick = (entry) => ({
  id: entry.id,
  headword: entry.headword,
  chineseCore: entry.chineseCore,
  ipa: entry.americanIpa || entry.britishIpa || "",
  sources: entry.sources.map(({ bookId, volume, unit }) => ({ bookId, volume, unit })),
});

const practice = [];
for (const [bookId, unit, words] of PRACTICE) {
  for (const word of words) {
    const entry = entries.find((item) => item.headword === word && item.sources.some((source) => source.bookId === bookId && source.unit === unit));
    if (!entry) throw new Error(`Practice word not found in ${bookId} ${unit}: ${word}`);
    practice.push(pick(entry));
  }
}

const paragraphs = article.paragraphs.map((paragraph, index) => {
  const sentences = paragraph.en.split(/(?<=[.!?])\s+(?=[A-Z(“"])/);
  if (sentences.join(" ") !== paragraph.en) throw new Error(`Sentence split changed paragraph ${index}`);
  return { text: paragraph.en, sentences };
});

const articleWords = new Map();
for (const paragraph of paragraphs) {
  for (const token of englishTokens(paragraph.text)) {
    for (const candidate of lemmaCandidates(token)) {
      const entry = byHeadword.get(candidate);
      if (entry && !entry.headword.includes(" ") && entry.headword.length > 2) { articleWords.set(entry.id, pick(entry)); break; }
    }
  }
}

const lexicon = new Map();
for (const entry of [...practice, ...articleWords.values()]) lexicon.set(entry.id, entry);

const output = {
  generatedFrom: {
    lexiconVersion: manifest.version,
    lexiconSchema: manifest.schemaVersion,
    reading: `public/readings/v1/articles/${ARTICLE_ID}.json`,
  },
  article: {
    id: article.id,
    title: article.title,
    titleZh: article.titleZh,
    author: article.author,
    sourceUrl: article.sourceUrl,
    rights: article.rights,
    difficulty: article.difficulty,
    form: article.form,
    background: article.background,
    paragraphs,
  },
  practiceIds: practice.map((entry) => entry.id),
  lexicon: [...lexicon.values()].sort((a, b) => a.headword.localeCompare(b.headword)),
};

await writeFile(new URL("../src/data/sample.json", import.meta.url), `${JSON.stringify(output, null, 1)}\n`);
console.log(`practice ${practice.length}, article words ${articleWords.size}, lexicon ${output.lexicon.length}`);
