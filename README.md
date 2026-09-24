# 词迹 2.2.1

面向人教版初高中英语学习者的本地优先 PWA。用回忆、拼写、听写建立记忆，再通过短文理解词语的用法。

[打开应用](https://pep-vocab-studio.namizore.chatgpt.site) · [开发指引](AGENTS.md) · [文档索引](docs/README.md) · [后端与数据架构](docs/BACKEND_ARCHITECTURE.md)

[2.2.1](docs/RELEASE_2.2.1.md) 换用新的应用图标。[2.2.0 更新](docs/RELEASE_2.2.0.md)把插画改为程序实时生成（今日页青绿山水随时间变化，阅读封面按分类用水墨、剪纸、海流），新增词卡速记、配对消除、单元自测三种记单词方式，并统一了图标与动效。主要功能见 [2.1.0 发布说明](docs/RELEASE_2.1.0.md)：60 篇可阅读内容、个人文章导入与扫描、独立设置浮层、iPad 布局与手绘分类封面。

## 功能

- 今日学习：教材与单元选词、到期复习优先、时间预算与新词额度、刷新恢复。
- 记单词：词卡速记（滑动翻看新词）、配对消除（英中配对）、单元自测（混合题型、得分与薄弱词）；不改变复习计划，错词可一键转入练习。
- 专注练习：词义回忆、拼写、听写与语境填空；先作答再揭示，错误与提示影响评分，本轮薄弱词重练，支持撤销。
- 我的词库：4,681 个稳定词条，12 册教材与高中课标范围；中英文搜索、状态筛选、收藏、笔记、选择练习与 CSV 导出。
- 阅读：保留原有 6 篇并净新增 54 篇，独立篇幅与难度筛选、来源和双语简介、查词与词汇练习。原有 6 篇保留译文和理解题。
- 个人文章：TXT、Markdown、HTML、DOCX、PDF 和英文图片扫描；本机保存、统一排版、可选 AI 分类、Markdown 导出。
- 学习记录：真实作答、首次作答正确率、学习天数、近期趋势与未来复习负担。
- 数据与偏好：浅色 / 深色、FSRS 保持率与学习预算、JSON 备份恢复、手动私有云端备份、显式离线下载。
- 可选 AI：词条用法讲解，密钥仅在服务器加密保存。核心学习无需 AI。

下图为 9 月 14 日版本。9 月 15 日的字体、图标、今日页、词库及动画调整见[界面更新说明](docs/history/INTERFACE_REFINEMENT.md)。

![9 月 14 日桌面界面，历史截图](artifacts/screenshots/studio-v2-desktop.jpg)

## 本地开发

要求 Node.js >=22.13.0。仓库包含发布词库，日常开发无需重新抽取教材。

```bash
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm test` | 完整验收入口；日常按[改动影响选择检查](docs/DEVELOPMENT.md) |
| `npm run typecheck` / `npm run test:unit` | 类型检查 / 单元与回归测试 |
| `npm run lint` | ESLint 检查 |
| `npm run benchmark -- <baseline-ref>` | 对照指定历史提交；本地需已取得该提交 |
| `npm run build` | 有超时限制的生产构建与产物验证 |
| `npm run data:audit` | 审核发布词库与来源字段 |
| `npm run data:manifest` / `npm run data:build` | 在具备来源缓存时重新生成词库 |

数据重建所需缓存通过 `PEP_VOCAB_SOURCE_CACHE` 指定。受保护教材、整页 OCR 与未授权音频不会进入公开产物。

## 代码结构

| 位置 | 职责 |
| --- | --- |
| `components/vocab-app.tsx`、`components/studio/` | 导航与按需加载的页面 |
| `hooks/use-vocabulary.ts` | 本机数据加载、保存、跨标签页刷新 |
| `lib/study.ts`、`lib/questions.ts`、`lib/session.ts` | 选词、题型降级、学习队列与恢复 |
| `lib/reading.ts` | 原创短文、理解题与例句 |
| `lib/art/`、`components/studio/art.tsx` | 生成式插画：六种画风、按文章 ID 与时间生成、空闲时绘制与位图缓存 |
| `lib/learn.ts`、`components/studio/learn/` | 词卡速记、配对消除、单元自测 |
| `lib/storage.ts`、`lib/scheduler.ts` | IndexedDB 事务、备份校验、FSRS |
| `app/api/`、`lib/assistant/` | 身份隔离、快照、模型配置与受限代理 |
| `public/sw.js`、`lib/offline.ts` | 发布缓存、离线下载确认 |
| `tests/`、`artifacts/verification-v2.json` | 测试与验证记录 |

## 当前边界

词库仍为 1.0.0-rc.1 发布候选：333 个高中词条缺开放英文简义、153 个词条音标不完整、7 个单元存在未解析记录。本次修复了 32 个词的地区标记音标显示问题，没有宣称完成全库人工终审。来源见 [SOURCE_MANIFEST.md](SOURCE_MANIFEST.md) 与 [VOCAB_AUDIT_REPORT.md](VOCAB_AUDIT_REPORT.md)。

语境不足时明确降级为基础题；原创内容不冒充教材原文。听写使用设备英语 TTS，离线发音取决于设备语音包。浏览器可能回收站点数据，重要记录可导出备份。

云端目前是带 revision 冲突保护的手动快照备份，尚未实现自动多设备合并。站点保持仅所有者访问；托管身份依赖受信任网关，迁移平台需接入服务端认证。详见[架构说明](docs/BACKEND_ARCHITECTURE.md)。

旧版设计与测试报告已移至 [docs/history](docs/history/)，仅供追溯。现行开发入口为 [AGENTS.md](AGENTS.md)，功能与运行行为以当前代码和本次验证为准。数据权利见 [LICENSES_AND_RIGHTS.md](LICENSES_AND_RIGHTS.md)。
