# 项目状态

核对日期：2026-11-11。工作区版本 2.19.3，尚未发布；变更见 [CHANGELOG](CHANGELOG.md)，本次证据见 `artifacts/qa/streamline-20261111/`。

| 内容 | 当前依据 |
| --- | --- |
| 应用与运行 | `package.json`、[README](README.md) |
| 词库 / schema | `public/data/v1/manifest.json`；索引 `pep-lexicon-index/2` |
| 学习备份 | `lib/backup.ts`，1.2.0，兼容 1.0.0 / 1.1.0 |
| AI 缓存 / 个人文章 | 独立本机 IndexedDB，不包含在学习 JSON 备份中 |
| 账户数据 | 手动完整快照与冲突合并；学习活动另自动记入账户日志 |
| 数据库迁移 | `drizzle/` 0000–0009 与 journal，本轮无新增迁移 |

已知边界：词库审计仍有 333 个开放英文释义缺口、153 个音标不完整词条、7 个未解析单元；补齐需固定哈希来源缓存。全量学习数据尚无后台增量同步，词条拆分/合并的完整 ID 迁移尚未实现。

线上部署、认证网关和付费模型表现需另行验证。历史数量、截图与工具限制只供追溯；开发入口见 [AGENTS](AGENTS.md)，专题见 [文档索引](docs/README.md)。
