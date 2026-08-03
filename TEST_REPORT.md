# 测试报告

测试日期：2026-08-03 UTC

环境：Node.js ≥22、Vinext/React 19、Cloudflare Workers/Sites 兼容构建、真实浏览器预览。

## 当前结果

| 层级 | 命令/方法 | 结果 |
|---|---|---|
| 来源清单 | `node scripts/build-source-manifest.mjs` | 通过：41 项，12/12 目标教材 |
| 词库构建 | `node scripts/build-lexicon.mjs` | 通过：7,938 raw、7,936 normalized、4,759 unique、4,681 release candidate |
| 数据审计 | `npm run data:audit` | 硬错误 0；状态 `release-candidate-with-declared-gaps` |
| 自动测试 | `npm run test:unit` | 10/10 通过 |
| ESLint | `npm run lint` | 通过 |
| 生产构建 | `npm run build` | 通过；Worker export 与 D1 hosting manifest 验证通过 |
| 全量门禁 | `npm test` | 通过：数据审计 → 10 项测试 → 生产构建 |

## 自动覆盖

- 12 册教材来源和逐单元证据。
- 稳定唯一 ID、必填字段、来源关系、初高中范围分离。
- 无私有码残留、无 `unknown`/`prohibited` 权利内容。
- 官方高中课标 2,997 词头行可重复抽取、层级齐全。
- FSRS v6 对 0.85/0.95 保持率产生不同间隔；一个主卡状态 + 六项能力。
- 14 种题型目录、PWA shell、详情懒加载、JSON 备份、D1 revision 冲突、AI 安全降级和清空确认。
- 非安全预览环境下的本地 ID 回退、可见焦点、forced-colors、`prefers-reduced-motion` 与精确视口验收框。

## 真实浏览器验收

| 视口/场景 | 结果与证据 |
|---|---|
| 390 × 844 手机竖屏 | 通过：首页和词库/详情均无横向阻断，底部导航与触控按钮可操作；`artifacts/screenshots/mobile-home-390x844.jpg`、`mobile-lexicon-390x844.jpg` |
| 820 × 1180 iPad 竖屏 | 通过：首页、计划与导航正常；`artifacts/screenshots/ipad-home-820x1180.jpg` |
| 1440 × 900 桌面 | 通过：完整桌面导航和三栏信息层级；`artifacts/screenshots/desktop-home-1440x900.jpg` |
| 首次诊断 | 通过：36/36 题完整完成，刷新后可从 19/36 恢复，结束后写入计划；`artifacts/screenshots/diagnostic-complete.jpg` |
| 学习、复习、撤销、分析 | 通过：翻卡与四档评分、完成页撤销、事件回放、今日统计和六项能力更新；`study-session.jpg`、`analysis.jpg` |
| 搜索与组合筛选 | 通过：英文搜索、懒加载详情；“高中必修 + 必修三 + Unit 1 + 学习中”返回 2 条可追溯结果 |
| 保持率与计划 | 通过：滑块调至 0.97 后预计每日负担变为 45 分钟；`plan-retention.jpg` |
| JSON 备份恢复 | 通过：浏览器实际下载 8,239 字节备份，恢复提示“备份已验证并恢复” |
| 损坏/schema 错误 | 通过：`schemaVersion: 9.9.9` 被拒绝并显示“不支持的 schema 版本” |
| 文章生词对齐 | 通过：可对齐 `adapt`、`agricultural`、`apply`、`knowledge` 等词条 |
| AI 与私有同步失败 | 通过：AI 关闭时使用本地核验内容；无站点身份的本地预览明确拒绝私有同步，核心学习不受影响 |
| 键盘与焦点 | 通过：Tab 可依次进入主导航，焦点为 3 px 明确轮廓；DOM 暴露按钮、表单和区域名称 |
| 深色主题 | 通过：实测背景 `rgb(13, 23, 23)`、正文 `rgb(231, 239, 237)`，内容可读 |

真实截图总索引见 `artifacts/screenshots/README.md`。

## 私有部署核验

| 项目 | 结果 |
|---|---|
| Sites checkpoint | 通过：由提交 `475dfde` 构建并保存不可变版本 |
| 部署终态 | `succeeded`；[私有部署地址](https://pep-vocab-studio.namizore.chatgpt.site) |
| 访问策略 | `custom`；允许账户 1（owner），外部访客 0，授权群组 0 |
| D1/R2 | D1 绑定名 `DB` 已进入托管产物；R2 未配置，因为当前发布包没有许可明确的真人音频或需要对象存储的大文件 |
| 代理端限制 | 遵循 Sites 运行时边界，没有用云浏览器打开生产 URL；HTTPS 离线和实际所有者身份同步保留为用户设备复测项 |

## 浏览器验收中发现并修复

1. 非安全预览环境没有 `crypto.randomUUID()`，首次评分会中断。已加入 `randomUUID → getRandomValues → 本地熵` 适配回退，并增加自动测试。
2. 单词队列只有一个项目时，完成页无法撤销误触。已在完成页增加“撤销最后一次评分”，回退卡片、事件与会话位置后可继续答题。
3. 页面切换会保留上一页滚动位置。已在主视图切换时重置滚动位置。

## 尚未形成充分运行时证据

- Service Worker、缓存清单和离线资源路径已由代码/构建测试验证；浏览器预览运行时不暴露 Service Worker 能力，部署后的 HTTPS 首次加载再离线尚未在真实所有者设备复测。
- 可访问名称、键盘和焦点已通过；实际屏幕阅读器朗读与 200% 浏览器缩放尚未完成独立人工设备验收。
- `prefers-reduced-motion` 已有 CSS 与自动断言；受控低速网络和系统“减少动效”开关尚未做部署后设备复测。
- 本地预览已证明 D1 无身份时安全降级；带实际 Sites 所有者身份的同步、冲突与恢复需要在私有部署的用户设备上复测。
- 清空操作的 `window.confirm` 与执行路径已由代码断言覆盖；浏览器自动化运行器不支持对确认框挂接事件，因此没有执行会破坏当前验收数据的确认动作。

## 已声明的数据缺口

精确 ID 和来源位置位于 `data/audit-summary.json`：333 个高中英文简义缺口、153 个 IPA 缺口、7 个单元字段级未解析行。它们不会使硬安全审计失败，但阻止项目宣称达到“最终正式词库”门槛。
