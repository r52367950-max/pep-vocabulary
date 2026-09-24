# 开发与验证

## 环境与命令

Node.js 要求见 `package.json#engines`，依赖以 `package-lock.json` 为准。普通开发使用 `npm ci`、`npm run dev`。构建脚本依赖 Bash 与 GNU `timeout`，Windows 可在 WSL 中运行。

| 目的 | 命令或说明 |
| --- | --- |
| 类型检查 | `npm run typecheck` |
| 静态检查 | `npm run lint` |
| 全部单元/回归测试 | `npm run test:unit` |
| 指定回归测试 | `node --import ./tests/register.mjs --test tests/sync.test.mjs`，替换为受影响的测试文件 |
| 生产构建及产物校验 | `npm run build` |
| 本地 Worker/D1 检查 | 构建后执行 `npm run test:runtime` |
| 完整验收 | `npm test`：数据审计、类型检查、单元测试、构建、Worker 检查；ESLint 另用 `npm run lint` |
| 词库数据审计 | `npm run data:audit`；会更新 `data/audit-summary.json`，留意生成差异 |
| 阅读数据审计 | `node --import ./tests/register.mjs scripts/audit-readings.mjs` |
| 性能对照 | `npm run benchmark -- <baseline-ref>`；本地需有相应提交，省略时使用历史基线 `3b12529` |

`test:runtime` 使用本地临时 D1 和测试凭据，不调用真实 AI 服务；不验证生产认证网关、真实服务商或物理设备行为。

`npm run install:ci` 是早期受管环境安装工具：它检查特定 HOME 路径，而当前 `sites-env.sh` 不设置该路径，不能视为通用入口。日常用 `npm ci`；改造该工具时单独验证环境兼容性。

## 按影响选择验证

| 改动 | 通常需要的证据 |
| --- | --- |
| 纯文档 | 核对命令/代码事实、本地链接和 `git diff --check`；无需安装依赖或全量构建 |
| 界面或交互 | 相关静态/类型检查；在可用预览中检查受影响视口与操作，关注焦点、触控与减少动效 |
| 学习、存储、同步、鉴权或密钥 | 相关行为回归；涉及 Worker、数据库或打包时构建并运行本地运行时检查 |
| 词库或阅读数据 | 对应数据审计与来源检查；稳定 ID 或 schema 变化另验迁移及恢复 |
| 广泛重构、依赖/构建链变更或发布 | 按影响运行完整验收及必要浏览器检查；纯静态资源发布可针对资源与构建验证 |

验证范围取决于实际风险，不机械按版本号执行同一矩阵。相关检查足以支持结论后停止重复验证；新增失败先区分本次回归、原有问题与环境限制。历史测试数量、截图和某次工具故障不作为长期指令。

## 数据与发布

仓库已包含可运行词库，日常开发无需 `data:manifest` 或 `data:build`。调整来源/提取流程时才使用它们，并准备 `PEP_VOCAB_SOURCE_CACHE` 等脚本所需输入；缺少原始缓存时不要覆盖发布数据。发布来源记录时复查私有文件路径与标识。

版本沿用三段规则：大重构升主版本，多处功能改进/主要功能增加升次版本，小修升补丁版本。纯文档整理不自动升级应用版本。GitHub 提交与 Sites 部署是不同操作，线上状态需从实际部署核实。

## 指引维护依据

2026-09-24 查阅：[GPT-6 Astra 技能与提示词指导](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)、[Claude Code 最佳实践](https://code.claude.com/docs/en/best-practices)、[Claude Code 项目指令加载](https://code.claude.com/docs/en/memory)。只保留必要项目约束，专题按需阅读；`CLAUDE.md` 导入 `AGENTS.md`，避免维护两套规则。开发代理模型与应用内 AI 服务配置相互独立。
