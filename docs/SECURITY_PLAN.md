# 安全加固：已实施项与待确认方案

2026-09-24，基于 2.2.1（`58ac110`）。第一部分是本次已经实施并验证的加固；第二部分是需要所有者确认后才实施的方案。**服务端会话和密钥轮换只有方案，没有实现。**涉及线上身份、访问范围或生产数据的步骤，都要先征得所有者同意。

## 一、本次已实施

### 1. 安全响应头（`worker/security.ts`，由 `worker/index.ts` 包装 vinext 处理器）

头部加在 Worker 入口，没有放在 `next.config.ts headers()`，原因有两个：

- 每个请求需要不同的脚本 nonce，`headers()` 只能配置静态值。
- 构建后的 Worker 里，`dist/client` 的静态文件由 Cloudflare 资源层直接返回，不经过 Worker；`headers()` 同样覆盖不到这些文件。只有 Worker 入口能统一处理页面、RSC 和 `/api/*`。

| 响应 | 头部 |
| --- | --- |
| 所有 Worker 响应 | `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Permissions-Policy`（关闭摄像头、麦克风、定位、支付、USB、串口、HID、蓝牙、MIDI、传感器、屏幕捕获、browsing-topics）、`Cross-Origin-Opener-Policy: same-origin`；HTTPS 下另加 `Strict-Transport-Security: max-age=31536000`（不含 `includeSubDomains`/`preload`） |
| HTML 页面 | 每个请求一个 nonce 的 CSP（见下） |
| `/api/*` | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`、`Cross-Origin-Resource-Policy: same-origin`，缺少 `no-store` 时补上 `Cache-Control: no-store, max-age=0` |
| 其他 Worker 响应（如 RSC 载荷） | `Content-Security-Policy: frame-ancestors 'none'` |

页面 CSP：

```
default-src 'self';
script-src 'self' 'nonce-<每请求随机 16 字节>' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' data: blob:; media-src 'self' data: blob:;
worker-src 'self' blob:; manifest-src 'self'; frame-src 'none';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
upgrade-insecure-requests   （仅 HTTPS）
```

来源盘点（按代码核实）：

- **没有第三方来源**。仓库里没有 Google 字体、`next/font` 或外部 CSS/脚本，`layout.tsx` 只引入本地 CSS。客户端 `fetch` 只访问同源 `/api/*` 和静态数据；DeepSeek 状态页只是链接。
- **内联脚本**：首页有 6 个 vinext/React 内联脚本（引导脚本和 RSC 载荷）。vinext 从请求的 `content-security-policy` 头读取 nonce 并写到这些脚本上，所以包装器把同一策略同时放在转发的请求和响应上。客户端自带的 CSP 请求头会被覆盖或删除，不能用来指定 nonce。
- **`wasm-unsafe-eval`**：自托管的 Tesseract（`/vendor/ocr-7`）和 pdf.js（`/vendor/pdfjs-5.6.205`）需要编译 WebAssembly。它不放行字符串 `eval`。
- **`worker-src 'self' blob:`**：OCR 和 PDF 在同源 Worker 中运行（`workerBlobURL: false`）；保留 `blob:` 以兼容 pdf.js 的回退路径。
- **`blob:`/`data:` 图片**：导入图片时用 `URL.createObjectURL`，导出备份时生成 blob 下载链接。
- **语音**：`speechSynthesis` 不受 Permissions-Policy 控制。代码中没有 `getUserMedia` 或语音识别，因此可以关闭麦克风。
- **Service Worker 与 IndexedDB**：不受 CSP 限制。`/sw.js` 同源注册。

缓存上的取舍：vinext 会把带 nonce 的页面标成 `no-store`，而 Service Worker 不缓存 `no-store` 响应，`scripts/smoke-worker.mjs` 也断言首页可以缓存。所以只对 `/` 的成功响应改为 `Cache-Control: private, no-cache`：Service Worker 仍能保存离线外壳（外壳里没有个人数据）；`private` 禁止共享缓存复用 nonce；浏览器每次都会重新验证。其他页面保持 vinext 的 `no-store`。代价是 vinext 不再对首页 HTML 做 ISR 缓存，每次请求都要服务端渲染。对单用户站点可以接受。

开发模式（`vite`）由 vinext 开发服务器直接处理请求，不经过 `worker/index.ts`，因此没有这些头部。入口里的 `import.meta.env.DEV` 开关保证 nonce CSP 不会在 Vite 开发客户端下启用。

框架层 API 错误统一成 JSON：未知 `/api` 路径返回 `404 {error, code:"not_found"}`；方法不允许返回 `405 {error, code:"method_not_allowed"}` 并带 `Allow`；未捕获异常或非 JSON 的 5xx 返回 `500 {error, code:"internal_error"}`，不带框架文本或栈。页面渲染抛出的异常返回纯文本 500，也不带细节。

### 2. 同步接口独立限流与错误规范化

- 限流计数移到 `lib/http.ts` 的 `consumeRateLimit()`，AI 和同步共用。它复用已有的 `ai_rate_limits` 表，靠键前缀区分（`sync:minute:*`、`sync:write-day:*`），**不需要新迁移**。
- `/api/sync`：同一身份每分钟最多 30 次请求（GET 与 POST 合计），每个 UTC 日最多 200 次写入。超限返回 `429`，带 `Retry-After`（秒）和 `{error:"云端同步请求过于频繁…", code:"rate_limited"}`。检查顺序：同源 → 身份 → 限流 → 读取请求体，超限时不读取 5 MB 请求体。
- 限流存储不可用时返回 `503 storage_unavailable`（fail closed）。同步本来就依赖同一个 D1，这不会增加新的不可用场景；本地学习不受影响。
- 同步错误的形状统一为 `{error: string, code: string}`，保留 `no-store` 和 `nosniff`。备份界面直接显示 `error`，所以它仍是字符串。`409` 的 `error` 保持 `identity-conflict`/`revision-conflict`；原有英文提示没有改动，其中含 `5 MB private-sync limit` 的文案受契约测试约束。
- AI 路由保持原来的 `{ok:false, error:{code,message,retryable}}`，客户端依赖这个形状。AI 配置路由保持 `{error}`。统一两者需要同时改前端（`components/`），不在本次范围内。

### 3. 身份头信任边界（`app/chatgpt-auth.ts`）

- 邮箱格式校验：先去掉首尾空白，长度 3–254，只能有一个 `@` 且两侧非空；不得含空白、逗号、分号、`<>"\`、控制字符。逗号能识别出 `Headers.get()` 把重复头拼接后的值。网关不会发出这类值，所以对网关放行的用户没有影响。
- 显示名：编码值最长 1024，解码后最长 200 且不含控制字符，否则回退为邮箱。
- **用户键推导不变**：仍是 `sha256(email.trim().toLowerCase())`，没有加入 Unicode 规范化或别名折叠，已有快照和加密配置仍能找到（有测试证明）。
- 可选开关 `IDENTITY_TRUSTED_HOSTS`（逗号分隔的主机名），**默认不设置，线上行为不变**。设置后，只有这些 Host 上的身份头有效。同一个 Worker 若在没有网关的域名（例如 `*.workers.dev`、预览域名）上被访问，伪造的身份头不会通过认证。启用前要先在线上确认网关转发给 Worker 的 `Host` 值，否则可能把所有者也挡在外面。

### 4. 复核结论：全部私有接口

`worker/security.ts` 的 `PRIVATE_API_ROUTES` 登记了全部 8 个路由及其方法。`tests/security-hardening.test.mjs` 会把它和 `app/api/**/route.ts` 实际导出的方法对比，新增路由必须先登记。项目中没有 Server Actions（`"use server"`），也没有 middleware。

| 防护 | 覆盖范围 | 证据 |
| --- | --- | --- |
| 缺失或伪造身份头 → 401 | 8 个路由、11 个方法，9 种异常身份值 | 单元测试；运行时（workerd）抽测 `/api/sync` |
| 跨站 `Origin`、`Origin: null`、`Sec-Fetch-Site: cross-site` → 403 | 所有写方法 | 单元测试；运行时抽测 |
| 超大请求体 → 413（声明的 `Content-Length` 和无长度的分块流） | 所有 POST，确认读取被中止 | 单元测试；运行时 20 MB 分块流 |
| 同步超限 → 429 + `Retry-After` | GET/POST 每分钟上限，POST 每日上限 | 单元测试；运行时第 31 次请求 |
| AI 配置与连接测试缺少设置操作头 → 403 | `POST`/`DELETE /api/ai/config`、`POST /api/ai/test` | 单元测试；运行时抽测 |
| 方法不允许 → 405 JSON + `Allow` | Worker 包装器 | 单元测试；运行时 `PUT /api/sync` |

另外两点复核：

- 所有需要请求体的私有写接口都要求 `Content-Type: application/json`，跨站请求因此必须先经过 CORS 预检，而预检拿不到 `Access-Control-Allow-Origin`。这与 Origin 检查一起构成两层 CSRF 防护，所以没有给同步再加操作头要求（`scripts/smoke-worker.mjs` 用 `settings` 调用同步，加了会破坏冒烟测试）。
- 助手和分类接口先校验请求体再检查身份，未登录的非法请求会得到 400 而不是 401。它们不读数据库、不外呼，没有信息泄露。冒烟测试依赖这个顺序，本次没有调整。

## 二、待所有者确认的方案

### A. 不依赖网关的服务端会话

目标：同一个 Worker 部署到没有托管网关的平台时，身份仍由服务端验证，并且仍然只有所有者能访问。

设计：

1. **会话 cookie**：`__Host-ciji_session`，`HttpOnly; Secure; SameSite=Strict; Path=/`，不设 `Domain`。值为 `base64url(payload).base64url(HMAC-SHA256(key[kid], payload))`，payload 为 `{v:1, kid, sid, sub:<userKey>, iat, exp}`。绝对有效期 30 天，空闲超时 7 天。
2. **服务端会话表**（新增兼容迁移，`CREATE TABLE IF NOT EXISTS`，可重复执行）：`sessions(sid PK, user_key, created_at, last_seen_at, expires_at, revoked_at, user_agent_hash)`。每次请求先校验签名，再查表确认没有撤销。
3. **签名密钥**：Secret `SESSION_SIGNING_KEYS`（JSON：`{"s1":"<base64 32B>"}`），用 `SESSION_SIGNING_KEY_ACTIVE` 指定签发用的 kid。验证时接受列表中的全部 kid，轮换方法同下文 B。
4. **登录凭据**：网关还在时，所有者在设置页用已通过网关的身份注册一个 Passkey（WebAuthn）。公钥存入新表 `passkeys`，同样用 `IF NOT EXISTS` 迁移。脱离网关后，用 Passkey 登录签发会话。邮件魔法链接需要付费或外部邮件服务，不作为默认方案。
5. **仅所有者**：Secret `OWNER_USER_KEYS`（userKey 列表）。会话模式下，不在列表里的 `sub` 一律 401。`sub` 沿用现在的 userKey，D1 里的同步快照和 AI 配置不需要迁移。
6. **模式开关** `AUTH_MODE`：`gateway`（默认，即现状）→ `gateway+session`（两者都要求，且会话 `sub` 必须等于网关身份）→ `session`（只看会话）。`getChatGPTUser()`/`authenticatedUserKey()` 是唯一入口，路由不需要改。
7. **CSRF**：`SameSite=Strict`，加上现有的 Origin、`Sec-Fetch-Site` 和 JSON 类型检查。登出时同时撤销服务端会话并清除 cookie。

迁移步骤：部署代码（默认 `gateway`，行为不变）→ 执行迁移建表 → 所有者注册 Passkey → 切到 `gateway+session` 观察一周 → 在新平台以 `session` 模式部署 → 确认后再下线网关。

回滚：把 `AUTH_MODE` 改回 `gateway` 立即生效；新表和 cookie 会被忽略，不删除任何数据。

测试：签名篡改、过期、撤销、kid 未知、`sub` 不在所有者列表、模式切换矩阵，以及三种模式下的 `409 identity-conflict` 行为。

### B. 加密主密钥版本化与轮换

现状：`AI_CONFIG_ENCRYPTION_KEY` 只有一把。`encryption_version` 表示的是附加验证数据的格式（1 或 2），不表示密钥版本，所以换密钥会让已有密文全部无法解密。

方案（需要改 `lib/ai-config.ts`，它不在本次边界内）：

1. 新 Secret `AI_CONFIG_ENCRYPTION_KEYS`，JSON 形式 `{"k1":"<旧值>","k2":"<新值>"}`；`AI_CONFIG_ENCRYPTION_KEY_ACTIVE="k2"`。未设置时，旧的 `AI_CONFIG_ENCRYPTION_KEY` 视为 `k1`，兼容现状。
2. 新密文格式 v3：附加验证数据为 `["pep-vocab-ai-config:v3", kid, userKey, provider, baseUrl]`，`encrypted_api_key` 存为 `kid:base64`，`encryption_version=3`。**不改表结构**：本地冒烟测试会重放全部迁移 SQL，而 `ALTER TABLE ADD COLUMN` 不能重复执行，把 kid 放进现有字段可以避开这个问题。
3. 解密按 kid 选择密钥；v1、v2 视为 `k1`。
4. 逐步重新加密：每次读取配置（AI 请求或保存设置）时，如果 kid 不是当前活动的 kid，就用活动密钥重新加密并条件更新（`WHERE encrypted_api_key = 旧值`）。另提供一个只供所有者手动触发的批量重加密操作。
5. 轮换流程：加入 `k2` → 切换 `ACTIVE` → 等待逐步重加密，或手动批量执行 → 确认 `SELECT COUNT(*) … WHERE encrypted_api_key NOT LIKE 'k2:%'` 为 0 → 移除 `k1`。

回滚：在移除 `k1` 之前，把 `ACTIVE` 切回 `k1` 即可。任何时候都不要在还有旧密文的情况下删除旧密钥。

### C. CSP 收紧路线

1. **当前**：脚本已靠 nonce 收紧；样式保留 `'unsafe-inline'`，因为服务端渲染的 React `style` 属性是内联的，而 CSP 中出现 nonce 时 `'unsafe-inline'` 会失效，没法混用。
2. 增加 `Content-Security-Policy-Report-Only`，试运行 `style-src 'self' 'nonce-…'` 和 `require-trusted-types-for 'script'`。`lib/reading-import.ts` 用 `template.innerHTML` 解析导入的 HTML：模板内容是惰性的，但启用 Trusted Types 前需要给它定义一个 policy。收集违规需要一个同源报告接口，受限流约束、只记录计数，本次没有添加。
3. 核实 pdf.js 与 Tesseract 只在 Worker 中编译 WebAssembly 之后，可以从页面策略中去掉 `'wasm-unsafe-eval'`，改到 `/vendor/*/worker` 静态资源的策略上。
4. **静态资源头部**：资源层不经过 Worker。建议由主会话新增 `public/_headers`。vinext 只在该文件不存在时才生成 `/assets/*` 的不可变缓存规则，所以新文件必须保留这一条：

   ```
   /*
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Referrer-Policy: same-origin
     Cross-Origin-Resource-Policy: same-origin
   /assets/*
     Cache-Control: public, max-age=31536000, immutable
   ```

   HSTS 是否由托管层统一添加，需要到线上核实后再决定是否写进 `_headers`。

### D. Service Worker 缓存范围复核（`public/sw.js`、`lib/offline.ts`）

结论：**不需要修改**。

- 私有响应不会进入缓存：`/api/`、登录/登出/回调路径和 RSC 请求（`rsc: 1` 或 `_rsc`）都直接放行，不读也不写缓存。现在所有 `/api/*` 响应都带 `no-store`，而 `cacheable()` 会拒绝 `no-store`，这是第二层保护。
- 只缓存两类请求：不带查询串的 `/` 导航，以及白名单前缀下的静态资源（`/assets/`、`/data/v1/`、`/readings/v1/`、`/vendor/`、`/icons/`、`/images/`、`/manifest.webmanifest`）。跨源、重定向和非 2xx 响应都不缓存。
- 首页外壳没有个人数据（身份与数据都通过 `/api` 在客户端取得），可以离线缓存。缓存的响应带着自己的 CSP 头，nonce 与正文一致，离线启动不会触发 CSP 拦截（已在 Chromium 中验证）。
- 缓存版本由构建哈希决定，激活时删除同前缀的旧缓存；词库分片的数量和文件名都有校验。
- 可选改进（低优先级）：`message` 处理器可以检查 `event.source` 是否为受控客户端；目前只有同源页面能向 SW 发消息，风险很低。

### E. 依赖审计与版本锁定

2026-09-24 的 `npm audit --omit=dev` 和 `npm audit` 都是 **0 个漏洞**（生产依赖 24 个，总计 636 个）。本次没有升级任何依赖，也没有改动 `package-lock.json`。

`npm outdated` 显示的补丁或小版本更新（仅记录，是否升级由所有者决定）：`next` 16.3.5→16.3.6、`drizzle-orm` 0.45.2→0.45.3、`react`/`react-dom`/`react-server-dom-webpack` 19.2.8→19.3.0、`wrangler` 4.131.2→4.137.0、`@cloudflare/vite-plugin` 1.54.9→1.58.0、`@vitejs/plugin-rsc` 0.5.26→0.5.35。`vinext` 已有 1.0.0-beta，属于大版本，需单独评估 nonce 与缓存行为。

锁版本策略建议：

- 运行时依赖和构建链（`next`、`react*`、`vinext`、`vite`、`wrangler`、`@cloudflare/*`、`drizzle-*`）继续使用精确版本。目前 `lucide-react`、`ts-fsrs` 和 `@cloudflare/workers-types`、`fake-indexeddb` 还在用 `^`，建议改成精确版本；`package-lock.json` 已经锁定了实际安装的版本，这只是让意图更明确。
- CI 与发布只用 `npm ci`。每次发布前运行 `npm audit --omit=dev`，出现 high 或 critical 时阻止发布。
- 升级时单独提交：先升补丁版本，并跑完整验证（`typecheck`、`lint`、`test:unit`、`build`、`test:runtime`）。升级 vinext 或 React 后，还要复核 nonce 是否仍然覆盖所有内联脚本，以及首页的缓存头。

## 三、仍需主会话处理

1. **`scripts/smoke-worker.mjs`**：建议在首页检查后加入头部断言，让 `npm run test:runtime` 本身就能证明头部生效：

   ```js
   if (path === '/') {
     const csp = response.headers.get('content-security-policy') || '';
     const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
     assert.ok(nonce, 'document CSP must carry a nonce');
     assert.ok([...text.matchAll(/<script([^>]*)>/g)].every(m => m[1].includes(`nonce="${nonce}"`)), 'every inline script is nonced');
     for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(csp.includes(directive), directive);
     assert.equal(response.headers.get('x-frame-options'), 'DENY');
     assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
   }
   if (path.startsWith('/api/')) assert.match(response.headers.get('cache-control') || '', /no-store/);
   ```

   并加一项：`PUT /api/sync` 返回 405，响应带 `allow`。
2. **`public/_headers`**：见 C.4。
3. **`public/sw.js`、`lib/offline.ts`**：不需要修改，见 D。
4. **线上核实**：托管层是否已经添加 HSTS 等头部（避免重复或冲突）；网关转发的 `Host` 值（启用 `IDENTITY_TRUSTED_HOSTS` 之前必须确认）。
