import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import {
  clearUserData, DataReplacedError, deleteWriting, exportBackup,
  listWritings, loadLearningState, restoreBackup, saveWriting,
} from "../lib/storage.ts";
import { newWriting } from "../lib/writing.ts";
import { refreshLearningContext, setTemporaryMode } from "../lib/learning-context-client.ts";
import { captureWritingContext, writeWritingInContext, writingContextCurrent } from "../lib/writing-context.ts";

test("unchanged AI context cannot authorize queued writing changes after backup restoration", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    accountScope: "writing-merge-account", revision: 1, enabled: false,
    notes: [], recentTopics: [], contextVersion: "writing-merge-context",
  });
  t.after(() => { globalThis.fetch = originalFetch; setTemporaryMode(false); });
  await clearUserData();
  setTemporaryMode(false);
  await refreshLearningContext();
  const { generation } = await loadLearningState();
  const saved = newWriting("free", [], "Keep the restored draft.");
  await saveWriting(saved, null, generation);
  const context = captureWritingContext();
  const edited = structuredClone(saved);
  edited.versions[0].text = "A stale editor must not replace the restored draft.";
  const backup = await exportBackup(generation);
  let resume;
  const queue = new Promise((resolve) => { resume = resolve; });
  const pending = queue.then(() => writeWritingInContext(context, () => saveWriting(edited, saved, generation)));
  const rejected = assert.rejects(pending, DataReplacedError);
  await restoreBackup(backup, generation);
  assert.equal(writingContextCurrent(context), true, "AI account and privacy context did not change");
  resume();
  await rejected;
  await assert.rejects(writeWritingInContext(context, () => saveWriting(newWriting("free", []), null, generation)), DataReplacedError);
  await assert.rejects(deleteWriting(saved.id, generation), DataReplacedError);
  assert.deepEqual(await listWritings(), [saved]);

  setTemporaryMode(true);
  await refreshLearningContext();
  let writes = 0;
  assert.equal(await writeWritingInContext(captureWritingContext(), async () => {
    writes++;
    await saveWriting(edited, saved, generation);
  }), false);
  assert.equal(writes, 0, "temporary writing never reaches persistent storage, even after a restore");
  assert.deepEqual(await listWritings(), [saved]);
});
