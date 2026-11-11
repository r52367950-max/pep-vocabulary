# 开发与验证

## 运行

Node 版本见 `package.json#engines`，依赖以锁文件为准。`npm ci` 后运行 `npm run dev`；默认仅监听本机。可信网络预览可加 `-- --host 0.0.0.0`。构建依赖 Bash 与 GNU `timeout`，Windows 使用 WSL。

| 目的 | 命令 |
| --- | --- |
| 类型 / 静态检查 | `npm run typecheck` / `npm run lint` |
| 回归 | `npm run test:unit`；定向用 `node --import ./tests/register.mjs --test tests/<name>.test.mjs` |
| 构建 / 本地生产预览 | `npm run build` / `npm start` |
| 完整验收 | `npm test`（数据、类型、lint、回归、构建、Worker/D1、安全矩阵） |
| 依赖审计 | `npm run audit:deps`（含构建依赖）；`audit:prod` 仅查生产依赖 |
| 阅读审计 | `node --import ./tests/register.mjs scripts/audit-readings.mjs` |
| 本地 HTTP 混合负载 | `node --import ./tests/register.mjs scripts/benchmark-workload.mjs --output <path>` |
| 历史微基准 | `npm run benchmark` / `npm run benchmark:backend` |

CI 执行 `npm ci`、`npm run audit:deps` 和 `npm test`。`install:ci` 提供锁和超时；单元测试默认并发 2。`.npmrc` 只关闭安装时自动审计，安全审计显式执行。

## 验证选择

文档改动核对事实、链接和 diff；界面改动检查相关视口与操作；学习、存储、鉴权和同步改动验证行为、异常输入及并发；构建链或广泛重构执行完整验收。当前任务可要求更多轮次与覆盖，不以历史测试结果代替新证据。

`test:runtime` 与 `test:security` 使用临时 D1 和测试凭据，不调用真实 AI。负载测试使用生产构建、workerd、D1 和合成学习记录；记录数据规模、并发、p50/p95/p99、吞吐与错误。真实服务商、网关和物理设备的验证单独说明。

历史比较脚本只执行 `scripts/benchmark-baseline.mjs` 已审核提交；新基线须审查后加入允许列表，读取时禁用 replacement refs。微基准不代表整站延迟。

## 数据与发布

仓库包含发布词库，普通开发无需重建。修改来源流程才运行 `data:manifest` / `data:build`，并准备固定哈希的 `PEP_VOCAB_SOURCE_CACHE`；流程见 [SOURCE_BUILDS.md](SOURCE_BUILDS.md)。缺少来源时保留发布数据。

### 版本分级

兼容的安全、缺陷和性能修复升补丁；成组产品新功能升次版本；产品代际或不兼容公共契约升主版本并提供迁移及回退。内部重构、修复数量和报告排版不决定升档；纯文档不升级应用。

发布前核对源码、产物来源、数据库迁移和阻塞项。`bash scripts/package-site.sh` 清理旧产物并重建，输出 `outputs/site.tar.gz`；包内保留 `dist/server`、`drizzle/` 及 journal、根 `migrations/`，使用普通文件。Sites 会复用同提交的已保存版本，打包修正须提交新版本。GitHub 与 Sites 状态分别记录，部署成功后验证实际迁移。

### 修复报告

沿用灰白、炭黑无衬线、细线网格；默认逐页高清 PNG，其他格式仅按用户要求提供。说明改动、触发条件、正常对照、验证命令、实测数据与剩余范围，图表仅表达真实测量。

项目约束见 [AGENTS.md](../AGENTS.md)，专题按需读取；历史报告仅供追溯。
