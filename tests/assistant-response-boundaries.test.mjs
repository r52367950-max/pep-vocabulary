import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { probeConnectionEndpoint, sanitizeModelResult } from '../lib/assistant/core.ts';
import { parseClassification } from '../lib/reading-classification.ts';

const answer = JSON.stringify({ summary: '有效回答', evidenceIds: [] });

test('bounded whitespace-heavy provider JSON cannot monopolize the worker with regex backtracking', async () => {
  // A separate thread deadline also catches a regression that blocks the JS event
  // loop; an in-process test timeout cannot interrupt synchronous backtracking.
  const source = `
      import { parentPort } from 'node:worker_threads';
      import { sanitizeModelResult } from ${JSON.stringify(new URL('../lib/assistant/core.ts', import.meta.url).href)};
      import { parseClassification } from ${JSON.stringify(new URL('../lib/reading-classification.ts', import.meta.url).href)};
      const content = '{"summary":' + ' '.repeat(240_000) + '"answer","evidenceIds":[]}';
      const result = sanitizeModelResult('explain', content, []);
      const classified = parseClassification('{"category":' + ' '.repeat(240_000) + '"essay","difficulty":"B2"}');
      parentPort.postMessage({ summary: result.summary, ...classified });
    `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
  let timer;
  try {
    const output = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Provider JSON processing exceeded its 5 second watchdog')), 5000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Provider JSON worker exited: ${code}`)); });
    });
    assert.deepEqual(output, { summary: 'answer', category: 'essay', difficulty: 'B2' });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test('provider JSON still accepts plain, fenced and explanatory wrappers, with a limit before cleanup', () => {
  for (const content of [answer, `\n${answer}\n`, `\uFEFF\x60\x60\x60json\n${answer}\n\x60\x60\x60`, `\x60\x60\x60\n${answer}\n\x60\x60\x60`, `回答：${answer}`]) {
    assert.equal(sanitizeModelResult('explain', content, []).summary, '有效回答');
  }
  assert.throws(() => sanitizeModelResult('explain', ' '.repeat(300_001) + answer, []), error => error.code === 'model_response_too_large');
  const classification = '{"category":"science","difficulty":"C1"}';
  for (const content of [classification, `\x60\x60\x60JSON\n${classification}\n\x60\x60\x60`]) {
    assert.deepEqual(parseClassification(content), { category: 'science', difficulty: 'C1' });
  }
  assert.throws(() => parseClassification(' '.repeat(300_001) + classification), /过大/);
});

test('cancelled connection probes abort in flight and never try the fallback endpoint', async () => {
  const caller = new AbortController();
  let count = 0;
  let upstreamSignal;
  const pending = probeConnectionEndpoint((_url, init) => {
    count++;
    upstreamSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      caller.abort();
    });
  }, ['https://api.example.test/v1/chat/completions', 'https://api.example.test/chat/completions'], 5000, caller.signal);
  await assert.rejects(pending, error => error.code === 'request_aborted' && error.status === 499);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(count, 1);
  await assert.rejects(probeConnectionEndpoint(async () => { count++; return new Response(); }, ['https://api.example.test'], 5000, caller.signal), error => error.code === 'request_aborted');
  assert.equal(count, 1, 'already-cancelled callers never contact the provider');
});
