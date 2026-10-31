import { resolve } from "node:path";
import { validateLexiconRelease } from "./lexicon-release.mjs";

const directory = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, "../public/data/v1");
const { manifest } = validateLexiconRelease(directory);
console.log(`Validated lexicon release: ${manifest.chunks.length} declared chunks, ${manifest.releasedEntries} entries; exact file set and data fields match.`);
