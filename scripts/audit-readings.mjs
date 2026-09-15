import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validLibraryArticle, lengthBand } from '../lib/reading-library.ts';

const catalog = JSON.parse(readFileSync('public/readings/v1/index.json', 'utf8'));
const seen = new Map();
const errors = [];
const added = catalog.filter(a => a.addedIn === '2.1.0');
const distribution = { category: {}, difficulty: {}, length: {} };
const increment = (object, key) => { object[key] = (object[key] || 0) + 1; };
for (const meta of catalog) {
  const article = JSON.parse(readFileSync(`public/readings/v1/articles/${meta.id}.json`, 'utf8'));
  if (!validLibraryArticle(article, meta.id)) errors.push(`${meta.id}: invalid article`);
  for (const [key, value] of Object.entries(meta)) if (JSON.stringify(article[key]) !== JSON.stringify(value)) errors.push(`${meta.id}: catalog mismatch ${key}`);
  const body = article.paragraphs.map(p => p.en).join('\n\n');
  const hash = createHash('sha256').update(body.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
  if (seen.has(hash)) errors.push(`${meta.id}: duplicate of ${seen.get(hash)}`);
  seen.set(hash, meta.id);
  if (/\uFFFD|\[Illustration|\[Picture|\[Footnote|START OF THE PROJECT|END OF THE PROJECT|<script|<iframe/i.test(body)) errors.push(`${meta.id}: extraction debris`);
  for (const size of [480, 960]) if (!existsSync(`public/images/reading-${meta.category}-${size}.webp`)) errors.push(`${meta.id}: cover missing`);
  if (meta.addedIn === '2.1.0') {
    if (!meta.backgroundEn || !meta.background || !meta.rights.basis || !meta.sourceUrl) errors.push(`${meta.id}: required provenance/introduction missing`);
    increment(distribution.category, meta.category); increment(distribution.difficulty, meta.difficulty);
    increment(distribution.length, ['unused', '<250', '250–499', '500–899', '900+'][lengthBand(meta.wordCount)]);
  }
}
if (new Set(catalog.map(a => a.id)).size !== catalog.length) errors.push('Duplicate IDs');
if (added.length < 50) errors.push(`Only ${added.length} additions; need at least 50`);
if (Object.keys(distribution.length).length !== 4) errors.push('A length band is empty');
const report = { total: catalog.length, originalRetained: catalog.length - added.length, netNew: added.length, distribution, minWords: Math.min(...added.map(a => a.wordCount)), maxWords: Math.max(...added.map(a => a.wordCount)), errors };
writeFileSync('artifacts/round3/reading-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
