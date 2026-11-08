import assert from "node:assert/strict";
import test from "node:test";
import { loadLexicon, loadDetails } from "../lib/lexicon.ts";

test("stalled index headers, bodies and detail chunks time out and can be retried", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entry = { id: "apple", headword: "apple", chineseCore: "苹果", britishIpa: "", americanIpa: "" };
  const manifest = { chunks: [{ file: "chunks/one.json", count: 1 }] };
  let mode = "headers";
  let activeSignal;
  let reads = 0;
  const stall = signal => new Promise((_resolve, reject) => {
    activeSignal = signal;
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    if (url.endsWith("manifest.json")) return Response.json(manifest);
    if (url.endsWith("index.json")) {
      reads++;
      if (mode === "headers") return stall(signal);
      if (mode === "body") return { ok: true, json: () => stall(signal) };
      return Response.json([entry]);
    }
    if (mode === "chunk") return { ok: true, json: () => stall(signal) };
    return Response.json([entry]);
  });
  for (const nextMode of ["headers", "body"]) {
    mode = nextMode;
    const pending = assert.rejects(loadLexicon(), /词库读取超时/);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(30_000);
    await pending;
    assert.equal(activeSignal.aborted, true);
  }
  mode = "success";
  assert.equal((await loadLexicon()).index[0].id, "apple");
  assert.equal(reads, 3, "timed-out initial loads are not permanently cached");
  mode = "chunk";
  const pending = assert.rejects(loadDetails(["apple"]), /词库读取超时/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30_000);
  await pending;
  mode = "success";
  assert.equal((await loadDetails(["apple"]))[0].id, "apple");
});
