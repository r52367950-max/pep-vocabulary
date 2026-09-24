# 词迹开发指引

按当前任务选择实现与验证方法；模型、推理强度、技能和分工由当前会话决定，不固定到某个版本。

## 项目约束

- 核心学习保持本地优先；AI 与云端备份不可用时仍能学习和复习。
- 保留稳定词条 ID、学习记录与备份兼容性。数据库变更新增兼容迁移，不删除已执行的历史迁移。复习卡片与事件保持事务一致，revision 冲突不可静默覆盖。
- AI 密钥只在服务端加密保存，不进入客户端存储、备份、日志或 Git。保留身份隔离、同源检查、限流与出站限制。
- 教材、词库和阅读内容保留来源与权利依据；生成内容不冒充教材原文或已核验词典字段。
- 延续现有中文界面、iPad 触控与键盘体验。视觉细节随任务调整，不受历史截图或旧封面方案约束。
- 站点沿用私有访问范围。按本次授权处理提交、发布和数据操作；仓库修改本身不包含扩大访问范围、覆盖生产数据或调用付费服务的授权。

## 工作与完成标准

- 在已授权范围内完成实现、相关验证和必要修正；普通本地修改与检查无需逐步请示。有影响结果的实质歧义再确认。
- 按改动影响选择检查，见 [开发说明](docs/DEVELOPMENT.md)。文案修正不触发完整构建或全库重建；安全、迁移、同步与学习逻辑的行为变化需相应回归证据。
- 交付说明修改结果、实际验证及仍存在的限制。旧报告中的通过项或工具故障不代表本次状态。

## 按需查阅

- 命令、环境与版本规则：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
- 数据或迁移：[DATA_SCHEMA.md](DATA_SCHEMA.md)、[LEXICON_VERSIONING_AND_MIGRATIONS.md](LEXICON_VERSIONING_AND_MIGRATIONS.md)。
- 身份、备份或 AI：[docs/BACKEND_ARCHITECTURE.md](docs/BACKEND_ARCHITECTURE.md)、[AI_ASSISTANT_DEPLOYMENT.md](AI_ASSISTANT_DEPLOYMENT.md)。
- 阅读及来源：[docs/READING_2.1.md](docs/READING_2.1.md)、[LICENSES_AND_RIGHTS.md](LICENSES_AND_RIGHTS.md)。
- 状态与索引：[PROJECT_STATE.md](PROJECT_STATE.md)、[docs/README.md](docs/README.md)。`docs/history/` 仅供追溯，不是当前任务清单。
