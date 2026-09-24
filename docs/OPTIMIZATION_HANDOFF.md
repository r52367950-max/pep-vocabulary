# 性能、精简与安全架构：交接须知

2026-09-24 写于 2.2.1 之后，供下一个专门做性能优化、代码精简和安全架构升级的会话使用。常驻约束仍以 [AGENTS.md](../AGENTS.md) 为准，命令与验证范围见 [DEVELOPMENT.md](DEVELOPMENT.md)。本文只补充这三项工作需要的现状、已知问题和容易踩的坑。

## 开工前

- PR #9（2.2.0）已合并。新工作从最新 `main` 开分支，不要在已合并的分支历史上继续提交。
- `npm ci` 后先记录基线，再动代码：`npm run typecheck`、`npm run lint`、`npm run test:unit`（2.2.1 时为 122 项）、`npm run build`、`npm run test:runtime`。性能改动另记 `npm run benchmark` 和浏览器性能记录（见文末）。
- 不改变的东西：
  - 稳定词条 ID、用户数据 schema `1.1.0` 与备份兼容。
  - 复习时"词卡 + 事件"同事务写入。
  - 撤销语义、revision 冲突保护。
  - AI 密钥只在服务端。
  - 站点仅所有者访问。
- 界面外观不在这次范围内，除非是修复。

## 代码地图（行数为 2.2.1 时）

| 位置 | 职责 | 备注 |
| --- | --- | --- |
| `components/vocab-app.tsx`（585） | 应用外壳：视图切换、学习会话、记单词模式、快捷键 | 状态集中在这里，改动影响面大 |
| `hooks/use-vocabulary.ts` | 载入词库与本机数据、保存、跨标签页刷新、提示条 | 性能问题的源头之一，见下文 |
| `components/studio/study-session.tsx`（721） | FSRS 练习界面 | 唯一写复习记录的界面 |
| `components/studio/learn/*`、`lib/learn.ts`、`app/learn.css`（1,222） | 词卡速记、配对消除、单元自测 | 不写复习记录；错词经 `startSession` 转入练习 |
| `components/console-settings.tsx`（819） | 设置、AI 配置、数据工具入口 | 体量最大的组件之一 |
| `lib/art/*`、`components/studio/art.tsx` | 生成式插画：画风、空闲时绘制、位图缓存 | `geometry` 画风当前未被使用 |
| `lib/storage.ts`、`lib/scheduler.ts`、`lib/session.ts` | IndexedDB 事务、FSRS、会话恢复 | 数据正确性核心，必须有回归测试 |
| `lib/lexicon.ts` | 索引与详情分片载入、显示层修复 | 含 `repairMeaning`（补回丢失的左括号） |
| `app/api/*`、`lib/assistant/*`、`lib/http.ts`、`lib/server-user.ts`、`app/chatgpt-auth.ts`、`worker/index.ts`、`db/`、`drizzle/` | 身份、同步、AI 代理、D1 | 安全架构工作的范围 |
| `public/sw.js`、`lib/offline.ts` | 离线缓存 | `/icons/` 等路径按缓存优先，换资源要换文件名 |
| `app/*.css` | 五个样式文件 + `learn.css`，按 `layout.tsx` 顺序加载 | 层叠债务较重，见精简部分 |

## 性能：已知热点

以下问题已在 2.2.0 审查中确认，尚未处理：

1. **`useVocabulary()` 每次渲染返回新对象**：以 `data` 为依赖的回调每次都重建，练习界面的 `keydown` 监听在每次按键后重新绑定。
   - 改法一：依赖其中稳定的成员（`notify`、`saveReview`、`metadata`、`reload`）。
   - 改法二：用 React 19.2 的 `useEffectEvent`。记单词模式已经这样写。
2. **提示条状态仍在全局 hook 里**：每次提示出现和 5 秒后消失，都会让整个应用重渲染。可以改为独立的外部 store（`useSyncExternalStore`）加一个 `<Toaster/>`。播报区域已改为常驻，只需迁移状态。
3. **重复扫描 4,681 条词库**：
   - `study-session.tsx`、`activity.tsx` 每次挂载都重建 `Map`。
   - `vocab-app.tsx` 的 `onRetry` 用 `ids.includes` 做 O(n·m) 过滤。
   - 改法：在 `useVocabulary` 里建一次 `byId` 再往下传。
4. **切换标签会整页重挂载**（`key={view}`）：丢失词库搜索、页码和打开的文章，还要重新计算。
   - 可评估 React 19.2 的 `<Activity>`。
   - 注意 `vocab-app.tsx` 里已有名为 `Activity` 的懒加载组件，需要改名。
5. **阅读查词模式每次渲染都重新分词**：可以按 `[article, lookup, lookupEnabled]` 缓存结果。
6. **插画绘制成本**：
   - 现状：接近视口才绘制，每个空闲时段只画一张，并缓存最近 48 张位图。
   - 在无 GPU 的无头 Chromium 中，单张 480×320 约 10–70 ms，水墨最慢。
   - 如果真机记录到超过 50 ms 的长任务，可以考虑改用 `OffscreenCanvas` 放到 Worker 里画。
   - 胶片颗粒已改为贴图叠加，不要改回逐像素的 `getImageData`。
7. **已处理，不必重做**：
   - 隐藏标签页不再每分钟重算。
   - 空闲时预载练习和词条详情。
   - `getBookUnits`、记录页统计、今日页统计已缓存。
   - 练习切换卡片时不再整屏闪出"正在准备"。

建议指标：初始 JS gzip 体积、中端手机上首次可交互时间、练习中超过 50 ms 的长任务、按键到反馈的延迟、翻页时的掉帧。改动前后用同一套测量对比，不凭感觉。

## 精简：候选清单

- **CSS 层叠债务**：同一选择器分散在多个文件里。
  - 例如 `.word-dialog` 的圆角声明了六次，`.recall-word` 在五处出现，只有最后加载的那条生效。
  - 目标是每个组件只有一个样式归属文件，或者引入 `@layer`。
  - 合并时逐项核对视觉，避免悄悄改掉外观。
- **两套图标并存**：导航和功能入口用 Phosphor（`symbol.tsx`），操作按钮用 lucide（全局线宽 1.5）。可以评估统一为一套。
- **未使用的代码**：`lib/art` 的 `geometry` 画风；CSS 里隐藏掉的图标和已失效的选择器（审查报告曾列出 `.symbol-tone` 等，部分已删）。
- **大组件拆分**：`console-settings.tsx`、`study-session.tsx`、`flashcards.tsx`。以可读性为目标，不为拆而拆。
- **测试会断言源码字符串**：
  - `tests/architecture.test.mjs`、`tests/redesign-contract.test.mjs` 会直接断言源码里的特定字符串，例如 `window.confirm("将清空本机…`、`系统英语语音`、`@media (prefers-reduced-motion: reduce)`。
  - 重构时确认这些约束仍然成立再更新断言，不要为了通过测试而删掉断言。

## 安全架构：现状与升级方向

现状（详见 [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md)）：

- **身份**：`getChatGPTUser()` 读取托管网关注入的 `oai-authenticated-user-*` 请求头。`authenticatedUserKey()` 取规范化邮箱的 SHA-256 作为用户键。**这只在网关会剥离外部伪造同名头的前提下才安全**。同一个 Worker 一旦暴露在没有该网关的域名上，任何人都能伪造身份。
- **请求防护**：
  - `sameOriginRequest` 检查 `Origin` 和 `Sec-Fetch-Site`。
  - `readJsonObject` 边读边限制体积，也覆盖无 `Content-Length` 的分块请求，并有读取超时。
  - AI 配置要求同源请求加上设置操作头。
- **同步**：整份快照上限 5 MB；`user_key + revision` 条件更新；身份变化时返回 `409 identity-conflict`；私有接口统一 `no-store`。
- **AI**：
  - 密钥用 AES-GCM v2 加密，附加验证数据绑定账号、服务商和目标 URL；v1 密文在下次保存时升级。
  - 出站只允许 HTTPS，拒绝私网地址，不跟随重定向，响应读取上限 300 KB。
  - 按分钟和 UTC 日原子计数限流。
- **仓库中没有设置任何安全响应头**：没有 CSP、`X-Frame-Options`/`frame-ancestors`、`Referrer-Policy`，也没有 HSTS。托管层是否补充，需要到线上核实。

可以考虑的升级（先写方案，涉及线上身份、访问范围或生产数据的改动要先征得所有者同意）：

1. **不依赖网关的服务端会话**：签名 cookie 或令牌，由服务端验证。这是迁移平台的前提。
2. **安全响应头**：CSP 需要允许 Google 字体以外的哪些来源，要先盘点。应用使用了 canvas、Service Worker 和 IndexedDB，没有第三方脚本。
3. **同步接口的独立限流**（AI 接口已有），并规范化错误响应。
4. **密钥轮换流程**：加密主密钥版本化，旧密文按需重新加密。
5. **依赖审计**：`npm audit`，锁定版本策略。
6. **Service Worker**：缓存范围、版本与过期策略。避免缓存私有接口响应（现有逻辑按路径白名单缓存，需要复核）。

## 无障碍：2.2.0 HIG 审查的遗留问题

以下来自按 Apple HIG 做的审查，尚未修复。它们属于正确性问题，精简时顺手避免重复引入：

- **对比度不足**：
  - 今日卡片在浅色天色下，次要文字 4.1–4.5:1，黄昏链接 3.8:1。
  - 选中态的蓝字配浅蓝底 4.2:1，出现在标签页文字、侧栏选中项、自测题量选项和配对选中块上。
  - 答对时的绿字配浅绿底 4.1:1。
- **200% 字号**：
  - 词卡顶栏的撤销按钮被挤出屏幕。
  - "再看看/认识"每行只剩一个字。
  - 配对块的释义被截断，导致无法配对。
- **没有浏览器历史记录**：iOS 边缘右滑或安卓返回键会直接离开应用，丢失词卡和自测的进度。
- **iPad 竖屏（761–1000px）**：侧栏只剩图标、没有文字。
- **系统字号**：iOS 的文字大小设置影响不到应用，可以考虑 `font: -apple-system-body`，限定在 `@supports` 内。
- **系统深色下"增强对比度"不生效**：选择器优先级问题。另外 Safari 不支持 `prefers-reduced-transparency`。

## 验证与环境备忘

- **浏览器检查**：本环境预装 Chromium，用全局 Playwright。
  - 导入：`import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'`
  - 启动：`chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`
  - 模拟手机：`hasTouch: true, isMobile: true`，这样只在触屏设备生效的样式才会被应用。
- **开发服务器**：`WRANGLER_LOG_PATH=.wrangler/wrangler.log npx vite --port 5199 --host 127.0.0.1`。
  - 新增被 `import` 的文件后如果首页报 500，重启一次即可。
  - 不要在同一条命令里 `pkill -f "vite --port 5199"`，它会连同当前 shell 一起结束。
- **`npm run data:audit`**：只会改写 `data/audit-summary.json` 的时间戳，与改动无关时还原。
- **`npm run build`**：带 3 分钟超时。
- **`.claude/`**：已从 ESLint 和 tsc 中排除。
- **单元测试**：通过 `tests/register.mjs` 直接加载 TS，新测试照现有文件的写法即可。
- **换公共资源**（图标、图片）要换文件名，否则已安装的用户会一直拿到 Service Worker 缓存的旧文件。
- **提交约定**：
  - 界面文案用简体中文。
  - 版本号按 [DEVELOPMENT.md](DEVELOPMENT.md) 的三段规则：性能、精简或安全加固属于补丁或次版本，架构级重构属于主版本。
  - 每次发布在 `docs/RELEASE_x.y.z.md` 写明改了什么、如何验证、还有哪些没验证。
