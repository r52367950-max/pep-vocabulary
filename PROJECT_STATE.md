# 项目状态入口

核对日期：2026-10-03；基于 `5838abe` 后的 2.5.2 安全修复工作区。本页反映仓库，不推断 Sites 当前部署状态或未推送的改动。

| 信息 | 本次核对值 | 持续维护的依据 |
| --- | --- | --- |
| 应用版本 | 2.5.2 | `package.json` |
| 词库版本 / 词条 schema | 1.0.0-rc.1 / 1.0.0 | `public/data/v1/manifest.json` |
| 学习备份 schema | 1.2.0（新增 `writings`；兼容导入 1.0.0 / 1.1.0） | `lib/backup.ts` 的 `USER_DATA_SCHEMA_VERSION` |
| AI 回答缓存 | 独立 IndexedDB `pep-vocab-ai-cache`；不进入备份 | `lib/ai-client.ts` |
| 本机个人文章 | 独立 IndexedDB；不包含在学习 JSON 备份中 | `lib/personal-readings.ts`、`lib/storage.ts` |
| 云端备份 | 带 revision 冲突保护的手动快照，尚无自动事件合并 | `app/api/sync/route.ts` |
| 数据库迁移 | 0000–0005（0004 增加限流过期索引；0005 增加配置并发写入标记） | `drizzle/` 与迁移 journal |

当前仓库功能见 [README](README.md)，开发约定见 [AGENTS.md](AGENTS.md)。版本、测试数量和数据缺口以后以对应代码、生成数据与本次执行结果为准，不把这里的快照作为永久常量。

## 已知边界

- `data/audit-summary.json` 的现有记录仍有 333 个开放英文释义缺口、153 个音标不完整词条、7 个存在未解析记录的单元。不能仅因构建通过就宣称完成数据终审。
- 自动多设备合并、词条拆分/合并的完整 ID 迁移尚未实现。文档中的方案不代表现成功能，也不自动构成下一项任务。
- 历史浏览器验收、设备限制和测试记录见 [文档索引](docs/README.md)。根据本次改动与可用环境确定验证，不继承某轮工具故障或暂停安排。
- 当前部署版本、访问成员、实际身份同步与设备表现需要独立核实。
- 2.4.0 的 AI 功能只用模拟回答和离线 harness 验证过；真实服务商的质量、用量与缓存命中需用 `scripts/ai-harness.mjs --live` 确认。见 [2.4.0 更新报告](docs/UPGRADE_REPORT_2.4.0.md)。

旧 A–G 关卡、固定下一步任务和 8 月份通过数量已从状态入口移除；原文可由 Git 历史追溯。

2.5.0 的核心变更见 `docs/BACKEND_ARCHITECTURE.md`。预算原子预留、配置 CAS、作文 CAS、备份深层校验、同步元数据预检已实现；仍是本地优先与手动快照备份。

2.5.2 收紧 AI 目标来源、用量结算及配置修改频率，并限制备份和 HTML 导入的资源消耗。第三方 AI 服务须由管理员配置 `AI_ALLOWED_PROVIDER_ORIGINS`；此工作区不代表线上已升级。
