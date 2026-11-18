import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { benchmarkBaseline } from './benchmark-baseline.mjs';
import { readJsonObject } from '../lib/http.ts';

// Same valid multilingual body, fragmented and bulk delivery. Includes Request,
// ReadableStream and JSON parsing overhead. No network, database or paid API.
const note = '学习词迹 and review '.repeat(8192);
const bytes = new TextEncoder().encode(JSON.stringify({ note }));
async function measure(read, chunkSize) {
  let offset = 0;
  const request = new Request('https://app.test/api/sync', {
    method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const next = Math.min(bytes.length, offset + chunkSize);
        controller.enqueue(bytes.subarray(offset, next));
        offset = next;
      },
    }),
  });
  assert.equal((await read(request, bytes.length)).note, note);
}
const baseline = benchmarkBaseline('request');
const transpiled = ts.transpileModule(await baseline.source('lib/http.ts'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText;
const previous = (await import('data:text/javascript;base64,' + Buffer.from(transpiled).toString('base64'))).readJsonObject;
const results = [];
for (const chunkBytes of [128, 16384]) {
  const versions = [['before', previous], ['after', readJsonObject]];
  const samples = { before: [], after: [] };
  for (let run = -2; run < 15; run++) {
    versions.reverse();
    for (const [name, read] of versions) {
      const start = performance.now();
      for (let i = 0; i < 8; i++) await measure(read, chunkBytes);
      if (run >= 0) samples[name].push((performance.now() - start) / 8);
    }
  }
  const timings = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
    values.sort((a, b) => a - b);
    return [name, { medianMs: values[7], p90Ms: values[13] }];
  }));
  results.push({ chunkBytes, chunks: Math.ceil(bytes.length / chunkBytes), ...timings });
}
console.log(JSON.stringify({ baseline: baseline.revision, node: process.version, bytes: bytes.length, warmupsPerVersion: 16, batches: 15, requestsPerBatch: 8, results }, null, 2));
