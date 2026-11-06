"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Cloud,
  Download,
  HardDrive,
  Upload,
  WifiOff,
} from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { prepareOfflineLexicon } from "@/lib/offline";
import {
  markBackupExported,
  requestPersistentStorage,
  storageStatus,
  type StorageStatus,
} from "@/lib/persistence";
import {
  exportBackup,
  replaceMergedBackup,
  restoreBackup,
  readCloudLink,
  saveCloudLink,
  USER_DATA_SCHEMA_VERSION,
} from "@/lib/storage";
import { SESSION_KEY } from "@/lib/session";
import { assertSyncPayloadFits } from "@/lib/sync-limits";
import { mergeBackups, type MergeSummary } from "@/lib/sync-merge";

const megabytes = (bytes: number) => (bytes / 1_048_576).toLocaleString("zh-CN", { maximumFractionDigits: bytes < 10_485_760 ? 1 : 0 });
const LINK_KEY = "pep-vocab-cloud-link-v2";
type CloudState = {
  identity: string;
  state: { payload: string; revision: number } | null;
  error?: string;
};
class RevisionConflict extends Error {}
const MERGE_EXPLANATION =
  "两边的作答都会保留；同一个词在两台设备上都复习过时，以云端记录为准重新安排本机这几次作答的复习时间。笔记、收藏和设置采用较晚修改的一侧。";
function mergeMessage(summary: MergeSummary) {
  const parts = [`本机 ${summary.localAnswers} 次作答`, `云端 ${summary.cloudAnswers} 次作答`];
  const rescheduled = summary.rescheduledWords ? `；${summary.rescheduledWords} 个两边都复习过的词已按云端记录重排复习时间` : "";
  return `已合并并上传：${parts.join("、")}${rescheduled}。`;
}
export default function DataTools({
  data,
  onBack,
  onReplaced,
}: {
  data: Vocabulary;
  onBack: () => void;
  onReplaced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      data.notify(
        error instanceof Error ? error.message : "操作未完成，请重试。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void storageStatus().then((status) => active && setStorage(status));
    return () => {
      active = false;
    };
  }, []);
  const protect = async () => {
    await requestPersistentStorage();
    setStorage(await storageStatus());
  };
  const backup = async () => {
    const payload = await exportBackup(data.generation);
    const url = URL.createObjectURL(
      // Whitespace can push a recoverable backup past the file import limit.
      new Blob([JSON.stringify(payload)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `词迹备份-${new Date().toLocaleDateString("sv-SE")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    markBackupExported();
  };
  const replaced = async () => {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("pep-vocab-sync-revision");
    onReplaced();
    await data.reload();
  };
  const importFile = (file: File) =>
    run(async () => {
      if (file.size > 25_000_000)
        throw new Error("备份超过 25 MB，请选择词迹导出的 JSON 文件。");
      const payload: unknown = JSON.parse(await file.text());
      if (
        !window.confirm(
          "恢复会替换本机学习记录。请先保存当前备份，再确认恢复。",
        )
      )
        return;
      await restoreBackup(payload, data.generation);
      localStorage.removeItem(LINK_KEY);
      await replaced();
      data.notify("备份已验证并恢复。");
    });
  const readCloud = async (metadataOnly = false): Promise<CloudState> => {
    const response = await fetch(metadataOnly ? "/api/sync?metadata=1" : "/api/sync", {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      // A rate-limited read explains how long to wait.
      const limited = response.status === 429
        ? ((await response.json().catch(() => null)) as { error?: string } | null)?.error
        : undefined;
      throw new Error(
        response.status === 401
          ? "云端同步需要在已登录的站点中使用。本地学习不受影响。"
          : limited || "无法读取云端备份，请稍后重试。",
      );
    }
    const result = (await response.json()) as CloudState;
    if (typeof result.identity !== "string")
      throw new Error("云端版本需要更新，暂不能安全同步。");
    return result;
  };
  const upload = async (payload: unknown, identity: string, baseRevision: number) => {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vocab-action": "sync",
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        schemaVersion: USER_DATA_SCHEMA_VERSION,
        expectedIdentity: identity,
        baseRevision,
        clientUpdatedAt: new Date().toISOString(),
        payload,
      }),
    });
    const result = (await response.json()) as {
      revision?: number;
      identity?: string;
      error?: string;
      code?: string;
    };
    if (response.status === 409 && result.code === "revision-conflict") throw new RevisionConflict();
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "账号或云端数据已改变。本机记录仍然保留；请先备份，再处理云端版本。"
          : result.error || "上传未完成。",
      );
    if (!Number.isSafeInteger(result.revision) || result.identity !== identity)
      throw new Error("云端响应无法确认，请重新检查备份状态。");
    return result.revision!;
  };
  // The merged snapshot is uploaded first; local data is replaced only after the
  // cloud accepts it and only if nothing was saved on this device meanwhile.
  const mergeAndUpload = async (identity: string) => {
    const cloud = await readCloud();
    if (cloud.identity !== identity || !cloud.state)
      throw new Error("云端账号或数据已改变，本机记录没有变化。请重试。");
    const local = await exportBackup(data.generation);
    const { payload, summary } = mergeBackups(local, JSON.parse(cloud.state.payload));
    assertSyncPayloadFits(JSON.stringify(payload));
    let revision: number;
    try {
      revision = await upload(payload, identity, cloud.state.revision);
    } catch (error) {
      if (error instanceof RevisionConflict)
        throw new Error("合并时云端又有新的上传，本机记录没有变化。请再上传一次。");
      throw error;
    }
    const generation = await replaceMergedBackup(payload, local, data.generation);
    await saveCloudLink({ identity, revision }, generation);
    await replaced();
    data.notify(mergeMessage(summary));
  };
  const sync = (direction: "push" | "pull") =>
    run(async () => {
      const remote = await readCloud(direction === "push");
      if (direction === "pull") {
        if (!remote.state)
          throw new Error("云端还没有备份。可以先从这台设备上传。");
        if (
          !window.confirm(
            "将用当前登录账号的云端备份替换本机学习记录。请先导出本机备份。继续恢复？",
          )
        )
          return;
        const generation = await restoreBackup(JSON.parse(remote.state.payload), data.generation);
        await saveCloudLink({ identity: remote.identity, revision: remote.state.revision }, generation);
        await replaced();
        data.notify("已恢复当前账号的云端备份。");
        return;
      }
      let link = await readCloudLink(data.generation);
      const linked = link?.identity === remote.identity;
      if (remote.state && (!linked || remote.state.revision !== link!.revision)) {
        const question = linked
          ? `云端有其他设备上传的新记录。合并两边的学习记录后再上传？${MERGE_EXPLANATION}`
          : `这个账号的云端已有学习记录，本机尚未关联。确认本机记录属于你，并合并两边后上传？${MERGE_EXPLANATION}`;
        if (window.confirm(question)) await mergeAndUpload(remote.identity);
        return;
      }
      if (!linked) {
        if (
          !window.confirm(
            "将本机的学习记录关联并上传到当前登录账号？请确认这些记录属于你。",
          )
        )
          return;
        link = { identity: remote.identity, revision: 0 };
      }
      const payload = await exportBackup(data.generation);
      assertSyncPayloadFits(JSON.stringify(payload));
      let revision: number;
      try {
        revision = await upload(payload, remote.identity, link!.revision);
      } catch (error) {
        if (!(error instanceof RevisionConflict)) throw error;
        if (window.confirm(`上传时云端刚好有其他设备的新记录。合并两边的学习记录后再上传？${MERGE_EXPLANATION}`))
          await mergeAndUpload(remote.identity);
        return;
      }
      await saveCloudLink({ identity: remote.identity, revision }, data.generation);
      data.notify("学习记录已备份到当前账号。");
    });
  return (
    <div className="data-view">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true" />
        返回设置
      </button>
      <div className="page-heading">
        <div>
          <p>学习记录由你保管</p>
          <h3>数据与备份</h3>
        </div>
      </div>
      <div className="data-cards">
        <section>
          <HardDrive size={25} aria-hidden="true" />
          <h2>本机学习记录</h2>
          <p>
            含单词记忆状态、完整作答、收藏、笔记和偏好。学习备份不包含模型密钥或个人文章。个人文章请在阅读器中单独导出。
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => run(backup)}
            >
              <Download size={17} aria-hidden="true" />
              导出 JSON 备份
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload size={17} aria-hidden="true" />
              恢复备份
            </button>
          </div>
          {storage && storage.persisted !== null && (
            <small>
              {storage.persisted
                ? "本机数据已受浏览器保护，不会被自动清理"
                : "浏览器可能在空间不足时清理本机数据，建议定期导出备份"}
              {storage.usage !== null && storage.quota !== null && ` · 已用 ${megabytes(storage.usage)} / ${megabytes(storage.quota)} MB`}
              {!storage.persisted && (
                <>
                  {" "}
                  <button className="text-button" disabled={busy} onClick={() => void protect()}>
                    申请保护
                  </button>
                </>
              )}
            </small>
          )}
          <input
            ref={input}
            hidden
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </section>
        <section>
          <Cloud size={25} aria-hidden="true" />
          <h2>私有云端备份</h2>
          <p>
            手动上传或恢复。云端有其他设备的新记录时，可以合并两边的作答后上传，不会覆盖任何一方；首次连接会确认账号关联。
          </p>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy || !data.online}
              onClick={() => sync("push")}
            >
              <Upload size={17} aria-hidden="true" />
              上传本机备份
            </button>
            <button
              className="secondary"
              disabled={busy || !data.online}
              onClick={() => sync("pull")}
            >
              <Download size={17} aria-hidden="true" />
              从云端恢复
            </button>
          </div>
        </section>
        <section>
          <WifiOff size={25} aria-hidden="true" />
          <h2>准备离线学习</h2>
          <p>
            下载全部词条详情。阅读、复习和拼写可在断网时使用；听写取决于设备的离线英语语音。
          </p>
          <button
            className="secondary"
            disabled={busy || !data.online}
            onClick={() =>
              run(async () => {
                await prepareOfflineLexicon();
                data.notify("全部词条已准备好，可在离线时继续使用。");
              })
            }
          >
            {busy ? "正在处理…" : "下载离线词库"}
          </button>
          <small>
            词库 {data.manifest?.version} ·{" "}
            {data.index.length.toLocaleString("zh-CN")} 条
          </small>
        </section>
      </div>
    </div>
  );
}
