# 词库版本与迁移

## 版本

- 词库数据：`1.0.0-rc.1`，位于 `public/data/v1/`。
- 词条 schema：`1.0.0`。
- 用户数据 schema：`1.0.0`。
- D1 迁移：`drizzle/0000_curvy_newton_destine.sql`。

## 稳定 ID

ID 来自规范化后的 `kind:lookup`，不依赖册次，因此同一词跨教材共享一个学习状态；册次/Unit 作为多值来源关系保留。短语和单词不合并，例如 `apply`、`apply for` 是不同 ID，但可通过 `relations.phrases` 关联。

## 升级流程

1. 新来源先写 raw/normalized 层并生成逐单元对账。
2. 生成 `id-migration.json`：`oldId → newId | split[] | mergedInto | removed(reason)`。
3. 运行数据审计和状态迁移回放；任何未知/禁止权利字段阻断发布。
4. 发布新版本目录，保留上一版本 manifest 和 checksum，Service Worker 采用新 cache 名。
5. 客户端先下载新 manifest，再原子切换；失败继续使用上一缓存。
6. 用户卡片按迁移表更新，事件保留原 ID 和迁移注记；无法解析的卡片暂停而非丢弃。

## 拆分与合并

- 词条拆分为多个义项/词形时：原卡保留到主条，其余新条为 `unseen`，不得复制稳定度制造虚假掌握。
- 多条合并时：选择最近事件的主 FSRS 状态；能力向量按事件重放重算，不简单取最大值。
- 被拒绝内容：用户注释和历史事件仍保留为 tombstone，不再进入学习队列。

## 同步冲突与回滚

- D1 使用 revision 乐观并发；409 后必须由用户选择拉取、导出或重试，不静默 last-write-wins。
- 回滚只切换词库静态 manifest；用户事件 schema 不降级。必要时由 forward migration 兼容旧字段。
- 所有迁移先在备份副本上执行，恢复测试通过后才更新 `meta` 中的 schemaVersion。

