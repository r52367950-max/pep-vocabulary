# 测试报告

测试日期：2026-08-03 UTC  
环境：Node.js ≥22、Vinext/React 19、Cloudflare Workers/Sites 兼容构建。

## 当前结果

| 层级 | 命令/方法 | 结果 |
|---|---|---|
| 来源清单 | `node scripts/build-source-manifest.mjs` | 通过：41 项，12/12 目标教材 |
| 词库构建 | `node scripts/build-lexicon.mjs` | 通过：7,938 raw、7,936 normalized、4,759 unique、4,681 release candidate |
| 数据审计 | `npm run data:audit` | 硬错误 0；状态为带已声明缺口的发布候选 |
| 自动测试 | `npm run test:unit` | 9/9 通过 |
| ESLint | `npm run lint` | 通过 |
| 生产构建 | `npm run build` | 通过；产物验证通过 |

## 自动覆盖

- 12 册教材来源和逐单元证据。
- 稳定唯一 ID、必填字段、来源关系、范围分离。
- 无私有码残留、无 unknown/prohibited 权利内容。
- 官方高中课标 2,997 词头行可重复抽取、层级齐全。
- FSRS v6 对 0.85/0.95 保持率产生不同间隔；一个主卡状态 + 六项能力。
- 14 种题型目录、PWA shell、详情懒加载、JSON 备份、D1 revision 冲突、AI 安全降级和清空确认。

## 待完成的浏览器矩阵

以下项目在真实预览完成后填写证据路径和结论：

| 视口/场景 | 状态 |
|---|---|
| 390×844 手机竖屏 | 待测 |
| 820×1180 iPad 竖屏 | 待测 |
| 1440×900 桌面 | 待测 |
| 诊断 → 学习 → 复习 → 撤销 → 分析 | 待测 |
| 搜索/教材/Unit/状态筛选与详情懒加载 | 待测 |
| JSON 备份恢复、损坏/版本错误、清空确认 | 待测 |
| 首次加载后离线、网络/音频/AI/D1 失败 | 待测 |
| 键盘、焦点、屏幕阅读器名称、200% 缩放 | 待测 |
| 深浅色、prefers-reduced-motion、低速网络 | 待测 |

## 已声明的数据缺口

精确 ID 和来源位置位于 `data/audit-summary.json`：333 个高中英文简义缺口、153 个 IPA 缺口、7 个单元字段级未解析行。它们不会使硬审计失败，但阻止项目宣称达到“最终正式词库”门槛。

