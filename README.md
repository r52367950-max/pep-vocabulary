# 词迹 · 人教版英语词汇学习

面向山东高中生的本地优先词汇学习 PWA。应用覆盖人教版高中必修一至三、选择性必修一至四，以及可核验的人教版七上、七下、八上、八下、九年级词表；学习状态由 FSRS v6 调度，初高中范围独立筛选，首次加载后可离线复习。

> 当前数据版本是 `1.0.0-rc.1` 发布候选，不是人工终审后的正式终版。自动审计通过硬性安全规则，但仍有 333 个高中短语/专名缺少许可清楚的开放英文简义、153 个词条的 IPA 不完整、7 个单元存在字段级未解析记录。详见 [VOCAB_AUDIT_REPORT.md](./VOCAB_AUDIT_REPORT.md) 与 [data/audit-summary.json](./data/audit-summary.json)。

仅所有者可访问的 Sites 部署：[pep-vocab-studio.namizore.chatgpt.site](https://pep-vocab-studio.namizore.chatgpt.site)。访问策略经 Sites 接口核验为 `custom`，仅包含站点所有者，无外部访客或授权群组。

## 已实现

- 4,681 条可操作发布候选，初中核心、高中必修、高中选择性必修、课标差集分层；稳定 ID、来源位置与字段审核状态可追溯。
- 今日计划、36 词可跳过诊断、教材进度、时间预算、积压时自动减少新词、五种学习模式。
- 14 种题型、客观评分、四档主观评分、反应时间/提示/错误类型、撤销误触与六项能力向量。
- `ts-fsrs` v5.2.3 / FSRS v6 适配层；每词一个主调度状态，默认保持率 0.90，可查看负担变化。
- 词库搜索与教材/单元/状态筛选、懒加载详情、收藏、注释、系统 TTS、趋势和负担分析。
- IndexedDB 本地状态、追加式复习事件、JSON 备份恢复、CSV/TSV、文章生词对齐、Service Worker 离线。
- 可选 D1 私有同步；AI 关闭或不可用时核心功能不受影响。

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm ci
npm run data:manifest
npm run data:build
npm test
npm run dev
```

数据源缓存默认位于 `/workspace/source-cache/pep-vocab`，也可通过 `PEP_VOCAB_SOURCE_CACHE` 指定。受保护教材、整页 OCR 和未授权音频不会进入 `public/` 或 Git。

## 核心命令

| 命令 | 作用 |
|---|---|
| `npm run data:manifest` | 重建机器可读和人工来源清单 |
| `npm run data:build` | 原始抽取 → 规范化 → 聚合 → 分片发布 |
| `npm run data:audit` | 生成字段级审计摘要；硬错误会非零退出 |
| `npm run test:unit` | 数据、FSRS、题型、PWA 和同步结构测试 |
| `npm test` | 审计、单元测试、生产构建与产物验证 |
| `npm run db:generate` | 从 Drizzle schema 生成 D1 迁移 |

## 目录

- `app/`, `components/`, `lib/`：应用、交互、词库、调度和本地存储。
- `scripts/`：来源清单、抽取、规范化、审计和构建脚本。
- `data/build/`：页码级原始与规范化 JSONL；`data/unit-reconciliation.json` 为逐单元对账。
- `public/data/v1/`：版本化轻量索引和详情分片。
- `db/`, `drizzle/`：可选私有同步 schema 与迁移。
- `tests/`：可重复的自动化证据。
- `artifacts/screenshots/`：手机、iPad、桌面和主要流程的真实运行截图及索引。

## 数据与隐私边界

学习数据默认只在浏览器 IndexedDB。私有同步需要站点身份，并只在 D1 保存经过 SHA-256 处理的身份键和 2 MB 以内的用户备份；发生 revision 冲突时拒绝静默覆盖。应用不收集核心学习以外的个人信息，不在前端放模型密钥，不捆绑真人音频。完整权利说明见 [LICENSES_AND_RIGHTS.md](./LICENSES_AND_RIGHTS.md)。

## 相关证据

- [SOURCE_MANIFEST.md](./SOURCE_MANIFEST.md)
- [PRODUCT_RESEARCH.md](./PRODUCT_RESEARCH.md)
- [DATA_SCHEMA.md](./DATA_SCHEMA.md)
- [TEST_REPORT.md](./TEST_REPORT.md)
- [PROJECT_STATE.md](./PROJECT_STATE.md)
- [LEXICON_VERSIONING_AND_MIGRATIONS.md](./LEXICON_VERSIONING_AND_MIGRATIONS.md)
