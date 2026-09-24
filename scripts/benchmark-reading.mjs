import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Compare exact production artifacts. This is a byte-budget measurement, not
// Lighthouse or a claim about device/network latency. No browser emulation.
const roots = [process.argv[2], process.argv[3] || '.'];
if (!roots[0]) throw new Error('Pass the previous production checkout and current checkout.');
function measure(root) {
  const client = resolve(root, 'dist/client');
  const manifest = JSON.parse(readFileSync(join(client, '.vite/manifest.json'), 'utf8'));
  const visited = new Set(), initial = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key); const entry = manifest[key]; initial.add(entry.file);
    for (const path of entry.css || []) initial.add(path);
    for (const dependency of entry.imports || []) visit(dependency);
  }
  for (const key in manifest) if (manifest[key].isEntry || ['components/vocab-app.tsx', 'components/studio/error-boundary.tsx'].includes(key) || key.endsWith('/layout-segment-context.js')) visit(key);
  // vinext emits layout CSS from the server environment. Only manifest-linked
  // assets belong to this build; old hashed files are not initial requests.
  const serverManifest = JSON.parse(readFileSync(resolve(root, 'dist/server/.vite/manifest.json'), 'utf8'));
  const layoutCss = new Set(Object.values(serverManifest).flatMap(entry => entry.css || []));
  for (const path of layoutCss) initial.add(path);
  const assets = new Set([...Object.values(manifest).flatMap(entry => [entry.file, ...(entry.css || [])]), ...layoutCss]);
  const bytes = paths => paths.map(path => { const buffer = readFileSync(join(client, path)); return { path, bytes: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length }; });
  const total = rows => ({ bytes: rows.reduce((sum, row) => sum + row.bytes, 0), gzip: rows.reduce((sum, row) => sum + row.gzip, 0) });
  const initialFiles = bytes([...initial].sort());
  const all = bytes([...assets].filter(path => /\.(js|css)$/.test(path)));
  return { initialCode: total(initialFiles), initialFiles, allClientCode: total(all), lexiconIndex: total(bytes(['data/v1/index.json'])) };
}
const before = measure(roots[0]), after = measure(roots[1]);
const catalog = JSON.parse(readFileSync('public/readings/v1/index.json', 'utf8'));
const articleSizes = catalog.map(a => statSync(`public/readings/v1/articles/${a.id}.json`).size).sort((a,b)=>a-b);
const covers = { generatedAtRuntime: true, source: 'lib/art', bytes: ['lib/art/core.ts', 'lib/art/scenes.ts', 'lib/art/index.ts'].reduce((sum, path) => sum + statSync(path).size, 0) };
const report = { conditions: 'Production Vite manifests; static entry + initial React client boundary + CSS; gzip level 9. Shared lexicon index reported separately. No CPU/network throttle, no Lighthouse score, no physical iPad timing.', before, after, initialGzipChange: after.initialCode.gzip-before.initialCode.gzip, readings: { total: catalog.length, catalogBytes: statSync('public/readings/v1/index.json').size, allBodiesBytes: articleSizes.reduce((a,b)=>a+b,0), minBodyBytes: articleSizes[0], medianBodyBytes: articleSizes[Math.floor(articleSizes.length/2)], maxBodyBytes: articleSizes.at(-1), bodiesLoadedOnDemand: true, memoryBodyCacheLimit: 8, covers }, import: { loadedOnDemand: true, vendorDirectoryBytes: readdirSync('public/vendor', { recursive:true }).reduce((sum,path)=>{const stat=statSync(`public/vendor/${path}`);return sum+(stat.isFile()?stat.size:0);},0) } };
writeFileSync('artifacts/round3/performance-comparison.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({before:before.initialCode,after:after.initialCode,deltaGzip:report.initialGzipChange,readings:report.readings,import:report.import},null,2));
