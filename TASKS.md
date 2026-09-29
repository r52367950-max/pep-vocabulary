# 2.4.0 升级任务清单

分支 `claude/wizardly-faraday-yydubr`，基于 2.3.0（`65bd890`）。状态：☐ 未开始 · ◐ 进行中 · ☑ 完成 · ⏸ 等待确认。

## 待所有者确认（确认前不动手）

- ⏸ Q1 第 4 点方案（记单词增强 + 写作），见下文「四」。
- ⏸ Q2 数据结构：D1 新表 `ai_preferences`（迁移 0003，`CREATE TABLE IF NOT EXISTS`）；本机新增独立 IndexedDB（AI 缓存、作文）；作文是否进入学习 JSON 备份。
- ⏸ Q3 界面：写作入口放在哪里（导航新增一项，或放在今日页）。

## 一、性能与本机数据保留

- ☐ P1 事件日志改为追加式结构：`saveReview` 不再复制整个数组；派生统计（有效复习、撤销集合、按日汇总）增量维护，今日页、记录页和外壳共用一份。
- ☐ P2 `summarizeStudy` 与 `buildStudyQueue` 共用 `selectEntries` 结果；`studyStats` 只算一次。
- ☐ P3 持久化存储：请求 `navigator.storage.persist()`，设置页显示“已受保护 / 可能被回收”和用量估算；未受保护且长时间未备份时提示导出。
- ☐ P4 词库列表 `content-visibility: auto`（截图逐屏核对，无外观变化才保留）。
- ☐ P5 性能回归测试：大事件量（5 万条）下作答保存与统计的耗时断言。

## 二、AI 功能

- ☐ A1 前端重新接入：词条详情（讲解，按侧重切换）、造句检查、易混词辨析、AI 练习（可作答、看解析）。
- ☐ A2 个性化上下文：客户端从作答记录生成“学习画像”（错误类型、薄弱词、最近错答、笔记），服务端限长校验后作为数据放入提示词；保留证据约束与教材页码校验。
- ☐ A3 `max_tokens` 统一 10000，按已知模型输出上限取较小值；输出字段长度校验相应放宽。
- ☐ A4 本机结果缓存（独立 IndexedDB，按任务 + 词条 + 画像摘要做键，可在设置里清空），重复查看不请求。
- ☐ A5 每日 token 预算：服务端读取上游 `usage` 累计（复用 `ai_rate_limits` 键前缀），超出返回 429；设置页可调、显示今日用量与缓存命中。
- ☐ A6 提示词按前缀缓存规则排列：固定系统提示（含全部任务格式）→ 当日学习画像 → 本次任务与证据；OpenAI 官方端点附 `prompt_cache_key`。
- ☐ A7 其余 AI 功能调研与建议（写入更新报告）。
- ☐ A8 更新 PRIVACY.md、AI_ASSISTANT_DEPLOYMENT.md 中的数据范围说明。

## 三、安全（SECURITY_PLAN 未实施项）

- ☐ S1 加密主密钥版本化与轮换（方案 B，不改表结构，v1/v2 兼容读取）。
- ☐ S2 `public/_headers`：静态资源安全头，保留 `/assets/*` 不可变缓存。
- ☐ S3 Service Worker `message` 校验来源客户端。
- ☐ S4 依赖精确锁版本（`lucide-react`、`ts-fsrs` 等），`npm audit` 记录。
- ☐ S5 AI 与同步限流的重复窗口代码合并（随 A5 一起）。
- 不做：服务端会话（方案 A，站点仍由网关保护且仅自用）；CSP Report-Only 与 Trusted Types（需要新增报告接口，收益低）。理由写入报告。

## 四、学习新功能（方案待确认）

见对话中的方案；确认后拆成具体任务。

## 五、收尾

- ☐ F1 `npm test`、`typecheck`、`lint`、`build` 全部通过。
- ☐ F2 README、PRIVACY、发布说明 `docs/RELEASE_2.4.0.md`、PROJECT_STATE 更新。
- ☐ F3 更新报告 `docs/UPGRADE_REPORT_2.4.0.md`：改了什么、测了什么、没做什么。
