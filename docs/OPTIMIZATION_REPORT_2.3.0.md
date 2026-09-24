# 2.3.0 优化报告：性能、精简、安全与无障碍

2026-09-24，基于 2.2.1（`58ac110`），分支 `claude/wonderful-tesla-o3ibu4`。目标是在不改外观、不改数据与学习语义的前提下，处理 [交接须知](OPTIMIZATION_HANDOFF.md) 里列出的问题。发布摘要见 [RELEASE_2.3.0.md](RELEASE_2.3.0.md)，安全方案见 [SECURITY_PLAN.md](SECURITY_PLAN.md)。

## 一、结论

| 方面 | 结果 |
| --- | --- |
| 性能 | 提示条出现一次，重渲染组件从 50 个减到 3 个；切换标签的点击到绘制从 69.5 ms 降到 45.0 ms；练习时每按一次键都重新绑定监听的问题已消除。首页初始 JS 几乎不变（+100 B gzip）。 |
| 精简 | 233 条死 CSS 声明、55 条死规则、1 个未用画风、1 个未用函数已删除；设置组件从 819 行减到 681 行。精简前后的 96 张截图逐像素相同。 |
| 安全 | 新增 nonce CSP 和一整套安全头，同步限流，API 错误统一为 JSON，身份头格式校验。13 项新测试覆盖全部 8 个私有路由、11 个方法。`/security-review` 没有发现问题。 |
| 无障碍 | 对比度不达标项从 22 处降到 0。修复了深色加增强对比度不生效、iPad 竖屏侧栏没有文字、大字号布局和系统返回手势。 |
| 不变的部分 | 词条 ID、schema `1.1.0`、备份兼容、"词卡 + 事件"同事务、撤销、revision 冲突保护、线上认证方式和访问范围。 |

## 二、改了什么

### 性能（`hooks/`、`components/vocab-app.tsx`、练习、阅读、记录）

1. `useVocabulary()` 的返回值用 `useMemo` 固定下来，并在加载词库时建一次 `byId`，向下传给练习、记录和三种记单词模式。
2. 提示条改为外部 store（`hooks/toast-store.ts`），由 `useSyncExternalStore` 加 `<Toaster/>` 读取。播报区域仍然常驻，5 秒后消失，同一条提示重复出现不会重新计时。
3. 练习界面和 Ctrl/⌘K 快捷键改用 `useEffectEvent`，键盘监听只绑定一次。
4. 视图改用 React 19.2 的 `<Activity>`，访问过一次后保持挂载，切换标签不再整页重新挂载。原来的懒加载组件 `Activity` 已改名为 `ActivityView`。
5. 阅读查词的分词按 `[article, lookup, lookupEnabled]` 缓存。再次回到阅读页时，已加载的目录、个人文章和正在读的文章都不会重新读取。
6. 练习或记单词进行时，今日计划用 `useDeferredValue` 在后台重新计算，不再挡在下一张卡的绘制前面。

### 精简

- **CSS**：用 postcss 分析 6 个样式文件（按 `app/layout.tsx` 的加载顺序）。
  - 如果某条声明后面还有一条在同一选择器、同一 `@media`/`@supports` 上下文里设置同一属性的声明，它就永远不会生效，属于死代码。这类声明有 233 条，全部删除。
  - 以下情况保留：同一条规则里的回退写法；带 `!important` 的声明；后面那条用了 `dvh`、`color-mix` 等新语法、旧浏览器可能不认的情况。
  - 另外删除了只针对已经没有组件输出的类名的 55 条规则。动态拼出来的类名，例如 `status-*`、`cover-*`，都保留了。
- **代码**：
  - 删除 `lib/art` 里的 `geometry` 画风（没有画面调用）和 `lib/scheduler` 里的 `workloadEstimate`（没有引用）。
  - AI 连接诊断拆到 `components/studio/ai-connection.tsx`，保存、测试、移除三个操作共用一个 `run()`。
  - 三种记单词模式改用共享的 `data.byId`。
- **没有做**：两套图标合一，CSS 改为每个组件一个文件或 `@layer`。这两项会改动外观或层叠顺序，收益主要在可维护性，留作单独任务。

### 安全（服务端）

- `worker/security.ts` 包装 vinext 处理函数：
  - 页面：每次请求生成新的 nonce CSP，vinext 从请求头读取这个 nonce，并写到首页全部内联脚本上。另设 `frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`。
  - 所有响应：`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: same-origin`、`Permissions-Policy`、COOP，HTTPS 下还有 HSTS。
  - `/api/*`：全禁 CSP、`CORP: same-origin`，并强制 `no-store`。
  - 客户端自带的 CSP 请求头会被删除，不能再用它指定 nonce。
- 同步限流：每个身份每分钟 30 次，每天最多 200 次写入，超限返回 429 并带 `Retry-After`。限流复用 `ai_rate_limits` 表，按键前缀区分，没有新增迁移。
  - 如果部署缺少这张表，同步照常工作，不会被限流拖成 503。
  - 数据库本身不可用时返回 503。
- 错误响应统一为 `{error, code}`。框架产生的 404、405 和 5xx 去掉内部信息，405 带 `Allow`，502 和 504 保留原状态码。
- 身份头会拒绝网关不会发出的值，例如重复头拼出来的逗号、空白、控制字符和超长值。用户键推导不变，有测试保证。可选开关 `IDENTITY_TRUSTED_HOSTS` 默认关闭。
- **只写了方案、没有实施**（需要所有者确认）：不依赖网关的服务端会话、加密主密钥的版本化与轮换、`public/_headers`。详见 [SECURITY_PLAN.md](SECURITY_PLAN.md)。

### 无障碍（修复）

- 新增三个令牌 `--blue-ink`、`--green-ink`、`--muted-strong`，只用在"浅色底上的文字"：选中的标签和侧栏、题量选项、配对选中块、答对、状态标签、今日卡片次要文字、侧栏搜索。
- 当前导航项在鼠标悬停时不再换成灰底。之前在增强对比度下，蓝字配灰底只有 2.1:1。
- 系统深色下，`html:not([data-theme])` 的优先级高于 `:root`，所以增强对比度一直没有生效。现在给它单独写了一段规则。
- iPad 竖屏（761–1000px）：侧栏图标下加了文字。
- 大字号：用 `em` 媒体查询。它跟随用户的浏览器字号设置，所以正常字号下的布局完全不变。字号放大后，词卡顶栏会隐藏标题，保证撤销按钮留在屏幕内；"再看看/认识"改为并排；配对块不再截断释义。
- 系统返回手势：`hooks/use-back-guard.ts` 在有浮层或非今日页时，保留一条同 URL 的历史记录。按返回会依次关闭词条详情、设置、练习（保留续学点）、记单词模式、当前标签，回到今日页再返回才会离开应用。
  - vinext 对每次 `popstate` 都会发起一次同 URL 的 RSC 导航，离线时这次导航失败会导致整页刷新。所以这类导航在 vinext 的导航函数处直接跳过。

## 三、测量数字

### 性能（生产构建，由 workerd 提供）

**测量条件**：
- 无头 Chromium 1194，CPU 节流 4x，1280×800，每次运行都用全新 profile。
- 前后两个构建交替运行，各 7 次，取中位数。
- 测量时机器上还有其他构建在跑。
- 原始数据在 `artifacts/perf/results-2.2.1.json`。

| 指标 | 前 | 后 |
| --- | --- | --- |
| 首页初始 JS（gzip，8 个分块） | 124,122 B | 124,222 B |
| 应用就绪 / TTI | 1215 / 1215 ms | 1122 / 1218 ms（在噪声范围内） |
| 提示条出现 / 消失时重渲染的组件数 | 50 / 48 | 3 / 1 |
| 切换标签：点击到绘制，中位数 / 最大值 | 69.5 / 95.7 ms | 45.0 / 72.2 ms |
| 切换标签：每次重渲染的组件数 | 78 | 23 |
| 练习 40 次按键：新增 keydown 监听次数 | 61 | 0 |
| 练习：评分到下一张卡，中位数 / p90 | 75.5 / 104.3 ms | 72.6 / 93.9 ms |
| 练习：超过 50 ms 的长任务 | 0 | 0 |
| 词库翻页 10 次：点击到绘制中位数 | 92.6 ms | 95.4 ms（无变化） |
| 反复切换到阅读页时请求阅读目录的次数 | 每次切换 1 次 | 总共 1 次 |

说明：
- 练习时每次按键渲染的组件数从 25.9 增加到 33.6。这是延后重算多出的一轮后台渲染，发生在绘制之后，所以下一张卡反而更快。
- 词库翻页的瓶颈在布局和中文文字排版，不在 JS，见第六节的后续建议。

### 精简

| 项 | 前 | 后 |
| --- | --- | --- |
| 样式源码 | 4,673 行 / 133,956 B / gzip 24,740 B | 4,353 行 / 127,027 B / gzip 23,979 B |
| 被覆盖的死声明（`css-overridden.mjs`） | 233 | 0 |
| `console-settings.tsx` | 819 行 | 681 行（诊断组件另有 75 行） |

### 无障碍

| 检查 | 前 | 后 |
| --- | --- | --- |
| WCAG AA 文字对比度不达标（`contrast.mjs`） | 22 处 | 0 |
| 系统深色加增强对比度时的 `--muted` | `#a1a1a6`（未生效） | `#d1d1d6` |
| 200% 字号下，词卡里被挤出屏幕的控件 | 撤销按钮 | 无 |
| 返回手势（`back-gesture.mjs`，8 项） | 直接离开应用 | 8/8 通过，0 次重载，0 次 RSC 请求 |

## 四、外观核对

- **方法**：
  - 用 `artifacts/qa/screens.mjs` 截图：桌面 1280×800、iPad 820×1180、手机 390×844，浅色和深色，16 个画面，共 96 张整页截图。时间和随机数都固定。
  - 用 `pixel-diff.mjs` 逐像素比较。
  - 同一份代码连续截两次，96/96 张相同，说明截图本身是确定的。
- **精简**：只做 CSS 精简时，与基线比较为 95/96 张相同。唯一不同的一张（iPad 浅色词条详情）重新截图后也相同，原因是截图时正好有另一个文件保存触发了热更新。
- **最终版本**（包含无障碍修复）：34 张完全相同；另外 62 张有差异，每张差异都小于 1% 的像素，逐张检查后都是有意的修复，主要是以下几处：
  - 选中项的文字颜色；
  - 当前导航项不再换成悬停灰底；
  - 今日卡片次要文字和侧栏搜索的颜色；
  - iPad 侧栏的文字标签。
- 性能改动单独比较（桌面和手机各 8 个画面）：差异为 0。

## 五、测试：怎么跑、结果如何

### 1. 基本检查（本次实际结果）

```bash
npm ci
npm run typecheck      # 通过
npm run lint           # 通过
npm run test:unit      # 139/139（基线 122 项）
npm run build          # 通过
npm run test:runtime   # 通过；现在还检查 nonce CSP、XFO、nosniff、/api no-store 和 PUT /api/sync 返回 405
```

### 2. 安全防护测试（`tests/security-hardening.test.mjs`，13 项）

单独运行：`node --import ./tests/register.mjs --test tests/security-hardening.test.mjs`

| 测试 | 证明了什么 |
| --- | --- |
| every API route is inventoried… | `app/api/**/route.ts` 导出的每个方法都在 `PRIVATE_API_ROUTES` 里登记过。新增路由不登记，测试就会失败。 |
| missing or malformed identity headers… 401 | 缺少身份头，或身份头是伪造的格式（逗号拼接、空白、控制字符、超长等 9 种）时，每个私有接口都返回 401。 |
| cross-site requests are rejected with 403… | `Origin` 不同、`Origin: null`、`Sec-Fetch-Site: cross-site` 都返回 403。这一步在读取身份和请求体之前完成。 |
| AI settings mutations require the settings action header | 缺少设置操作头返回 403。 |
| oversized bodies are refused with 413… | 声明了超大 `Content-Length`，或用无长度的分块流发送超大内容，都返回 413，并确认读取已中止。 |
| sync is rate limited… 429 and Retry-After | 第 31 次请求返回 429，并带 `Retry-After`。 |
| sync writes have a daily budget… | 每日写入上限生效；存储不可用时返回 503；缺少限流表时同步照常工作。 |
| sync keeps identity and revision conflicts… | 身份变化和 revision 冲突仍然返回 409，不会静默覆盖。 |
| gateway identity values are validated… | 大小写和首尾空白不同的同一邮箱，仍然得到同一个用户键（兼容已有云端数据）。 |
| the optional trusted-host guard… | 开关默认关闭，线上行为不变。设置后，其他主机上的身份头会被忽略。 |
| HTML documents carry a per-request nonce CSP… | 响应 CSP 里的 nonce 与交给 vinext 的一致，而且每次请求都不同。 |
| development skips script CSP… | 开发模式下不启用脚本 CSP，但仍然有防嵌入和 nosniff。 |
| framework API errors become private JSON… | 404、405（带 `Allow`）、500 和 504 都返回 JSON，不含栈、SQL 或框架文本。 |

同步和 AI 原有的回归测试（`sync`、`backend-security`、`assistant-proxy`）也全部通过。

### 3. 浏览器检查（`artifacts/qa/`，任何一项不通过时退出码为 1）

先启动开发服务器：`WRANGLER_LOG_PATH=.wrangler/wrangler.log npx vite --port 5199 --host 127.0.0.1`。

```bash
node artifacts/qa/css-overridden.mjs                    # 本次：0 条死声明
node artifacts/qa/contrast.mjs http://127.0.0.1:5199    # 本次：issues: 0（基线 22）
node artifacts/qa/dark-increased-contrast.mjs http://127.0.0.1:5199/
node artifacts/qa/large-text.mjs http://127.0.0.1:5199/ /tmp/large
node artifacts/qa/back-gesture.mjs http://127.0.0.1:5199/          # 本次：8/8 PASS，rscRequests: 0
node artifacts/qa/back-gesture-offline.mjs http://127.0.0.1:5199/  # 本次：离线返回不重载
# 截图对比：在两个版本上各截一组，再比较
node artifacts/qa/screens.mjs http://127.0.0.1:5199 /tmp/shots-new
node artifacts/qa/pixel-diff.mjs /tmp/shots-old /tmp/shots-new /tmp/shots-diff
```

### 4. 性能复测（`artifacts/perf/`）

```bash
npm run build
node artifacts/perf/serve.mjs dist 5200 &                  # 用 workerd 提供生产构建
node artifacts/perf/bundle-size.mjs http://127.0.0.1:5200/ dist
node artifacts/perf/runtime.mjs before=<旧构建地址> after=http://127.0.0.1:5200/ --runs=7
node artifacts/perf/smoke.mjs http://127.0.0.1:5200/       # 11 项行为冒烟
```

## 六、没有验证或没有做的部分

- **真机**：没有在真实 iPhone、iPad、安卓设备上验证。返回手势、大字号和性能数字都来自无头 Chromium。iOS 的系统文字大小（Dynamic Type）没有接入：`font: -apple-system-body` 会把 iOS 默认字号从 16px 改成 17px，属于外观变化，需要所有者决定。
- **线上**：没有部署。需要核实托管层是否已经添加 HSTS 等响应头，以及网关转发的 `Host` 值（启用 `IDENTITY_TRUSTED_HOSTS` 前必须确认）。静态资源不经过 Worker，所以没有这些安全头，`public/_headers` 的写法见安全方案 C.4。
- **审查里没有处理的项**：
  1. 开始练习再退出时，外壳仍会整体重新挂载，词库和阅读的状态会丢失。这是 2.2.1 就有的行为，改动需要调整外壳结构。
  2. AI 限流里的窗口计算和清理代码与同步重复，属于重构，没有功能影响。
  3. `newCount` 仍然按实时卡片计算，影响很小。
- **后续建议**：
  - 词库翻页的瓶颈在布局和中文文字排版（约 75 ms，4x 节流）。可以给 `.word-row` 加 `content-visibility: auto`，改完需要逐屏核对截图。
  - `summarizeStudy` 和 `buildStudyQueue` 可以共用 `selectEntries` 的结果；`studyStats` 可以按 events 缓存。
  - 作答时 `saveReview` 会复制整个事件数组。数据量变大后，可以考虑改成增量结构。
