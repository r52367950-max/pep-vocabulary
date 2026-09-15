"use client";

import { useRef, useState } from "react";
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
  exportBackup,
  restoreBackup,
  USER_DATA_SCHEMA_VERSION,
} from "@/lib/storage";
import { SESSION_KEY } from "@/lib/session";

const LINK_KEY = "pep-vocab-cloud-link-v2";
type CloudLink = { identity: string; revision: number };
type CloudState = {
  identity: string;
  state: { payload: string; revision: number } | null;
  error?: string;
};
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
  const backup = async () => {
    const payload = await exportBackup();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `词迹备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      await restoreBackup(payload);
      localStorage.removeItem(LINK_KEY);
      await replaced();
      data.notify("备份已验证并恢复。");
    });
  const readCloud = async (): Promise<CloudState> => {
    const response = await fetch("/api/sync", {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "云端同步需要在已登录的站点中使用。本地学习不受影响。"
          : "无法读取云端备份，请稍后重试。",
      );
    const result = (await response.json()) as CloudState;
    if (typeof result.identity !== "string")
      throw new Error("云端版本需要更新，暂不能安全同步。");
    return result;
  };
  const sync = (direction: "push" | "pull") =>
    run(async () => {
      const remote = await readCloud();
      if (direction === "pull") {
        if (!remote.state)
          throw new Error("云端还没有备份。可以先从这台设备上传。");
        if (
          !window.confirm(
            "将用当前登录账号的云端备份替换本机学习记录。请先导出本机备份。继续恢复？",
          )
        )
          return;
        await restoreBackup(JSON.parse(remote.state.payload));
        localStorage.setItem(
          LINK_KEY,
          JSON.stringify({
            identity: remote.identity,
            revision: remote.state.revision,
          }),
        );
        await replaced();
        data.notify("已恢复当前账号的云端备份。");
        return;
      }
      let link: CloudLink | null = null;
      try {
        link = JSON.parse(localStorage.getItem(LINK_KEY) || "null");
      } catch {
        /* Invalid binding must be re-established. */
      }
      if (link?.identity !== remote.identity) {
        if (remote.state)
          throw new Error(
            "当前设备尚未关联这个云端账号。请先导出本机备份，再选择从云端恢复，避免覆盖已有记录。",
          );
        if (
          !window.confirm(
            "将本机的学习记录关联并上传到当前登录账号？请确认这些记录属于你。",
          )
        )
          return;
        link = { identity: remote.identity, revision: 0 };
      }
      const payload = await exportBackup();
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vocab-action": "sync",
        },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          schemaVersion: USER_DATA_SCHEMA_VERSION,
          expectedIdentity: remote.identity,
          baseRevision: link.revision,
          clientUpdatedAt: new Date().toISOString(),
          payload,
        }),
      });
      const result = (await response.json()) as {
        revision?: number;
        identity?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "账号或云端数据已改变。本机记录仍然保留；请先备份，再处理云端版本。"
            : result.error || "上传未完成。",
        );
      if (
        !Number.isSafeInteger(result.revision) ||
        result.identity !== remote.identity
      )
        throw new Error("云端响应无法确认，请重新检查备份状态。");
      localStorage.setItem(
        LINK_KEY,
        JSON.stringify({
          identity: result.identity,
          revision: result.revision,
        }),
      );
      data.notify("学习记录已备份到当前账号。");
    });
  return (
    <div className="data-view">
      <button className="text-button" onClick={onBack}>
        <ArrowLeft size={17} />
        返回设置
      </button>
      <div className="page-heading">
        <div>
          <p>学习记录由你保管</p>
          <h1>数据与备份</h1>
        </div>
      </div>
      <div className="data-cards">
        <section>
          <HardDrive size={25} />
          <h2>本机学习记录</h2>
          <p>
            含单词记忆状态、完整作答、收藏、笔记和偏好。备份不包含模型密钥。
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => run(backup)}
            >
              <Download size={17} />
              导出 JSON 备份
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload size={17} />
              恢复备份
            </button>
          </div>
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
          <Cloud size={25} />
          <h2>私有云端备份</h2>
          <p>
            手动上传或恢复。检测到其他设备的更新时，会阻止覆盖；首次连接会确认账号关联。
          </p>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busy || !data.online}
              onClick={() => sync("push")}
            >
              <Upload size={17} />
              上传本机备份
            </button>
            <button
              className="secondary"
              disabled={busy || !data.online}
              onClick={() => sync("pull")}
            >
              <Download size={17} />
              从云端恢复
            </button>
          </div>
        </section>
        <section>
          <WifiOff size={25} />
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
