// Offline attachment decode microbenchmark; no network or model requests.
// Run: node --import ./tests/register.mjs scripts/benchmark-attachments.mjs
import { decodeText } from '../components/studio/companion/sources.ts';

// Reviewed decodeText implementation from d148c35, retained here as a fixed baseline.
function baseline(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false }; }
  if (/\u0000/.test(text)) return { ok: false };
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > Math.max(8, text.length / 50)) return { ok: false };
  const chars = [...text].length;
  const truncated = chars > 12000;
  return { ok: true, text: truncated ? [...text].slice(0, 12000).join('') : text, chars, truncated };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const cases = [];
for (const [name, source] of [['2 MiB ASCII', 'word '.repeat(419430)], ['1.8 MiB mixed Unicode', '学习 😀 review\n'.repeat(100000)]]) {
  const bytes = new TextEncoder().encode(source);
  for (let run = 0; run < 4; run++) { baseline(bytes); decodeText(bytes); }
  const timings = { before: [], after: [] };
  for (let run = 0; run < 15; run++) {
    for (const label of run % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now();
      (label === 'before' ? baseline : decodeText)(bytes);
      timings[label].push(performance.now() - start);
    }
  }
  const before = median(timings.before), after = median(timings.after);
  cases.push({ name, bytes: bytes.length, beforeMedianMs: before, afterMedianMs: after, speedup: before / after, samples: 15 });
}
console.log(JSON.stringify({ baseline: 'd148c35', node: process.version, measuredAt: new Date().toISOString(), scope: 'Node UTF-8 attachment decoding only; excludes browser I/O, document extraction and model latency', cases }, null, 2));
