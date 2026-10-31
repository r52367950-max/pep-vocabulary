import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { newWriting } from "../lib/writing.ts";
import { clearUserData, listWritings, saveWriting } from "../lib/storage.ts";
import { refreshLearningContext, setTemporaryMode } from "../lib/learning-context-client.ts";
import { captureWritingContext, writeWritingInContext, WritingContextChangedError } from "../lib/writing-context.ts";

test("writing persistence respects temporary mode, queued context changes, and account boundaries", async () => {
  const oldFetch = globalThis.fetch;
  let account = "account-a", revision = 1;
  globalThis.fetch = async () => new Response(JSON.stringify({ accountScope: account, revision, enabled: true, notes: [], recentTopics: [] }), { status: 200 });
  try {
    await clearUserData();
    setTemporaryMode(false);
    await refreshLearningContext();
    const normal = newWriting("free", [], "A local draft");
    assert.equal(await writeWritingInContext(captureWritingContext(), () => saveWriting(normal)), true);
    assert.equal((await listWritings()).length, 1);

    setTemporaryMode(true);
    await refreshLearningContext();
    const temporary = newWriting("free", [], "Temporary text");
    const temporaryContext = captureWritingContext();
    assert.equal(await writeWritingInContext(temporaryContext, () => saveWriting(temporary)), false);
    setTemporaryMode(false);
    await refreshLearningContext();
    await assert.rejects(writeWritingInContext(temporaryContext, () => saveWriting(temporary)), WritingContextChangedError);
    assert.deepEqual((await listWritings()).map((row) => row.id), [normal.id]);

    const beforeChange = captureWritingContext();
    let release;
    const queue = new Promise((resolve) => { release = resolve; });
    const delayed = queue.then(() => writeWritingInContext(beforeChange, () => saveWriting(temporary)));
    revision++;
    await refreshLearningContext();
    release();
    await assert.rejects(delayed, WritingContextChangedError);

    const oldAccount = captureWritingContext();
    account = "account-b";
    await refreshLearningContext();
    await assert.rejects(writeWritingInContext(oldAccount, () => saveWriting(temporary)), WritingContextChangedError);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(writeWritingInContext(captureWritingContext(), () => saveWriting(temporary), aborted.signal), WritingContextChangedError);
    assert.deepEqual((await listWritings()).map((row) => row.id), [normal.id]);
  } finally { globalThis.fetch = oldFetch; setTemporaryMode(false); }
});
