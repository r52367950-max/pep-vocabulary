// Initial JS weight of the home page: scripts and modulepreloads referenced by the served HTML,
// plus every chunk they import statically. Dynamic import() chunks are excluded.
// Usage: node artifacts/perf/bundle-size.mjs <baseUrl> <distDir>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const base = process.argv[2] || "http://127.0.0.1:5200/";
const client = resolve(process.argv[3] || "dist", "client");
const html = await (await fetch(base)).text();
const queue = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const seen = new Set();
while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  const code = readFileSync(resolve(client, `.${path}`), "utf8");
  for (const m of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(`/assets/${m[1]}`);
}
let raw = 0;
let gzip = 0;
const files = [...seen].sort().map((path) => {
  const bytes = readFileSync(resolve(client, `.${path}`));
  const size = gzipSync(bytes, { level: 9 }).length;
  raw += bytes.length;
  gzip += size;
  return { path, raw: bytes.length, gzip: size };
});
console.log(JSON.stringify({ base, chunks: files.length, rawBytes: raw, gzipBytes: gzip, files }, null, 2));
