# 词迹 · 安全 / 稳定性 / 隐私评估报告

> 授权范围内的自测（仓库所有者对自有代码的红队评估）。目标：稳定性、安全性、隐私性——重点看内置 AI 服务的密钥/接口暴露、用户数据能否被破坏、以及有没有办法拿到隐私。
>
> - **日期**：2026-08-04
> - **方法**：先人工通读全部安全关键面，再派 3 个子代理并行深挖（2×高强度打主要面、1×中强度扫细节），关键结论用可执行 PoC 坐实。**只读评估，未改动任何应用代码。**
> - **部署背景**：ChatGPT Sites 单所有者站点（access policy `custom`，仅所有者，无外部访客）。多处"多租户"风险因此收敛为"单账户"影响——本报告在每条里都据此定级，并显式标注"若换一个前置代理/直连 Worker 则升级为 X"。

## 总体结论

**codex 写的后端整体安全意识很强，不是随便能搞破坏的**——我预期的大部分攻击面都被显式堵死了（密钥不进前端、SSRF 过滤扎实、无 SQL 注入、无提交的密钥、错误信息在 AI 链路上统一脱敏、连恢复流程都做了事务回滚）。**真实问题集中在一条链路：`/api/sync`**（它是唯一没有跟上全站防护基线的变更端点），外加一个 AI 链路上的**算法复杂度 DoS（ReDoS）**。前端（本次由我编写）在 XSS 方面是安全的（无 `dangerouslySetInnerHTML`，React 自动转义）。

## 发现分级总表

| # | 级别 | 位置 | 一句话 |
|---|---|---|---|
| 1 | 🔴 High | `app/api/sync/route.ts:20-45` | `/api/sync` POST 无同源/CSRF 防护且不校验 `Content-Type` → 跨站可盲写/清空所有者云端备份 |
| 2 | 🟠 Medium（与 #1 组合升 High） | `app/api/sync/route.ts:35-43` | revision 冲突校验是"客户端可选"且非原子（check-then-write）→ 静默覆盖 / 丢更新，违背文档承诺 |
| 3 | 🟠 Medium | `lib/assistant/core.ts:356` | `parseJsonObject` 去围栏正则二次方回溯 ReDoS，300KB 模型响应 ≈ 100s CPU（已测） |
| 4 | 🟠 Medium（直连 Worker 则 Critical） | `app/chatgpt-auth.ts:19-36` | 完全信任入站 `oai-authenticated-user-email` 头，无签名/共享密钥兜底 → 若绕过前置代理即可冒名 IDOR |
| 5 | 🟡 Low | `lib/assistant/core.ts:214-258` | SSRF：不做 DNS 解析，`127.0.0.1.nip.io` 这类公网域名指向私网可过（本架构影响低） |
| 6 | 🟡 Low | `app/api/sync/route.ts:16` | GET 把原始 `error.message`（D1/驱动内部）回传客户端，全站唯一未脱敏端点 |
| 7 | 🟡 Low | `app/api/sync/route.ts:9-45` | 该端点缺 `Cache-Control: no-store` / `force-dynamic`（全站唯一返回用户数据却无 no-store 的端点） |
| 8 | 🟡 Low | `next.config.ts` / `worker/index.ts` | 全站无 CSP / X-Frame-Options / HSTS（单所有者部署下优先级低，属纵深防御） |
| 9 | 🟡 Low/Info | `lib/ai-config.ts:9,32` | 单一部署级主密钥；AAD 常量未绑定 `userKey`；`encryptionVersion` 写而不读（轮换会作废全部密钥） |
| 10 | 🟡 Low | `README.md:56` | 文档不一致：README 写同步上限 2MB，代码与 PRIVACY.md 实为 5MB |
| 11 | 🟠 Medium | `public/sw.js:33-38`、`lib/storage.ts:183-191` | **[修订新增]** Service Worker 把**任意**同源导航响应无条件写入 `/` 缓存键；私有 JSON 可落盘并在离线时充当应用外壳，且「清空本机数据」不清 Cache Storage |
| — | ⚪ Info/潜在 | `lib/assistant/core.ts:311` | 助手输出服务端未转义 `< > &`；当前前端无 `dangerouslySetInnerHTML` 故不可利用，但属潜在约束 |

---

## 逐条详述

### 1. 🔴 High — `/api/sync` POST 缺同源/CSRF 防护，且忽略 `Content-Type`

**位置**：`app/api/sync/route.ts:20-45`。对比：`lib/ai-config.ts:104-108`（`sameOriginMutation`）、`lib/assistant/server.ts:118-128`（`assertSameOrigin`）。

全站**其它每一个**变更端点都有应用层 CSRF 控制，唯独 `POST /api/sync` 一个都没有：

- `POST/DELETE /api/ai/config` → `if (!sameOriginMutation(request)) return 403`（Origin 校验 **+** 必需自定义头 `x-vocab-action: settings` **+** `Content-Type` 门禁）。
- 助手路由 → `assertSameOrigin` **+** `readJsonRequest`（校验 `application/json` 与体积）。
- `POST /api/sync` → 从 `authenticatedUserKey()` 直接到 `await request.json()`，**没有 `assertSameOrigin`、没有 `sameOriginMutation`、没有 `x-vocab-action`，且从不读取 `Content-Type`**。

**预检绕过（精确）**：合法客户端用 `content-type: application/json`，跨源 `fetch` 会触发 CORS 预检；路由没有 CORS 处理 → 预检失败 → 真正的 POST 被拦。**但处理器从不检查 `Content-Type`**——`Request.json()` 无视声明类型直接把 body 当 JSON 解析。于是攻击者发一个 CORS **"简单请求"**：`Content-Type: text/plain`（安全值，**不触发预检**），body 是一段 JSON 字符串。`request.json()` 解析成功，29-32 行校验全过，38-43 行写入执行。

**利用（所有者浏览器被诱导访问 attacker.com）**：
```html
<script>fetch("https://pep-vocab-studio.namizore.chatgpt.site/api/sync", {
  method:"POST", credentials:"include", mode:"no-cors",
  headers:{"content-type":"text/plain"},                 // 简单请求，无预检
  body: JSON.stringify({ schemaVersion:"1.1.0", clientUpdatedAt:new Date().toISOString(),
    payload:{ schemaVersion:"1.1.0", cards:[], events:[], lists:[], settings:[] } }) // 省略 baseRevision → 见 #2 直接跳过冲突检查
});</script>
```
效果：**把所有者整份云端备份盲写为空状态**（revision 自增），摧毁已同步的学习历史。响应因无 ACAO 头跨源不可读，故是**盲写/破坏**而非读取；GET `/api/sync` 同样无防护，但 CORS 仍挡住响应体——备份可被清空，但不能被读走。

**违背承诺**：README:56「revision 冲突时拒绝静默覆盖」（配合 #2）。

**残留不确定性（如实说明）**：真实可利用性取决于 **Sites 会话 Cookie 的 `SameSite` 策略**（平台属性，仓库里看不到）。若为 `SameSite=None` → 跨站请求带上 Cookie，代理盖上身份头，攻击成立；若为 `Lax/Strict` → 跨站 POST 不带 Cookie，代理会拒（401，无身份头），此时降为纵深防御缺口。**无论哪种，同类端点都做了防护而本端点没有，就是确定的、在范围内的缺陷。**

**修复方向**：给 `/api/sync` 的 GET 与 POST 都加 `assertSameOrigin`（或 `sameOriginMutation`）+ `application/json` 门禁。

### 2. 🟠 Medium（与 #1 组合升 High）— revision 守卫"客户端可选"且非原子 → 静默覆盖 / 丢更新

**位置**：`app/api/sync/route.ts:35-43`。

**守卫可被跳过**：冲突检查是
```js
if (current && typeof body.baseRevision === "number" && current.revision !== body.baseRevision) return 409;
```
只要 `baseRevision` **缺省**或**非数字**（`"5"`、`null`、`[]`…），`typeof … === "number"` 为假，整个条件短路，跳过 409，落到 `nextRevision=(current?.revision||0)+1` 与 `onConflictDoUpdate` **无条件覆盖**。因此"禁止静默覆盖"**在服务端并未强制**，只靠诚实客户端自愿带 `baseRevision`。任何手工/跨源请求（见 #1）都能轻易绕过。

**check-then-write 非原子（连诚实客户端都受影响）**：34 行 `SELECT` 与 39 行 `INSERT … ON CONFLICT DO UPDATE` 是两条独立语句，**无事务、写入也没有 `WHERE revision = baseRevision` 守卫**。两台设备同在 revision 5 并发推送：各自读到 5、各自过守卫、各自算出 6、后者覆盖前者——典型丢更新。该 revision 检查是"建议性"的，不是 CAS。

**违背承诺**：`DATA_SCHEMA.md:66`、`README.md:56`。

**修复方向**：`baseRevision` 强制为数字（否则 400）；写入改成单事务内的 CAS（`UPDATE … WHERE user_key=? AND revision=?`，0 行受影响即 409）。

### 3. 🟠 Medium — `parseJsonObject` 去围栏正则二次方 ReDoS

**位置**：`lib/assistant/core.ts:356`
```js
content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
```
尾部 `/\s*```$/` 未锚定：遇到很长的内部空白且结尾非反引号时，`\s*` 贪婪匹配后回溯，O(N²)。

**可达性**：运行在**未净化的原始上游模型内容**上。内容上限 300KB（`readChatCompletion` core.ts:671 / `readBoundedResponseText` core.ts:685），而 `cleanOutputText`（core.ts:311）只删控制字符，**不删空格/制表/换行**，故 300KB 的纯空白串可存活。用户自带 `baseUrl`（可指向自控端点），或一个啰嗦/对抗性的模型即可返回这种体。

**PoC（我独立复现，Node 22，纯正则）**：10k→131ms，40k→2069ms，80k→8395ms，160k→32185ms（干净二次方，4× 输入 ≈16× 时间）；300KB 外推 ≈100s 单线程 CPU。子代理经**真实** `sanitizeModelResult("explain", …)` 路径实测：60k 内部空格 → 4620ms CPU。

**影响**：认证用户可让一个 Worker isolate 每请求打满 CPU。Cloudflare 单请求 CPU 上限 + 限流（min(12,daily)/分钟）限制了爆炸半径，且是自导向，故定 Medium 而非 High——但这是**用在规格内（≤300KB）就能触发的真实算法缺陷**，也可能被一个仅仅"话多"的模型无意触发。

**修复方向（一行）**：该去围栏其实与 362-369 行已有的 `{…}` 子串回收逻辑重复——直接删掉；或用 `trimEnd()` + 固定后缀判断替代不定长正则。

### 4. 🟠 Medium（直连 Worker 则 Critical）— 完全信任 `oai-authenticated-user-email` 头

**位置**：`app/chatgpt-auth.ts:19-36` → `lib/server-user.ts:3-9`。

`getChatGPTUser()` 直接从入站请求头读 `oai-authenticated-user-email`，**无校验、无签名、无来源检查**。`authenticatedUserKey()` = `SHA-256(email)`，该哈希是 `sync_states` 与 `ai_configs` 的**唯一授权键**。全仓库搜 `hmac|signature|shared-secret|proxy-secret|x-forwarded` → **零命中**，也无 `middleware.ts`。

**信任边界**：安全**完全**依赖 ChatGPT Sites 边缘 (a) 认证所有者会话、(b) 在转发给 Worker **前剥离/覆盖**任何客户端自带的 `oai-authenticated-user-*` 头。若攻击者能直连 Worker 源（绕过 Sites 前门），或代理未剥离该头，则设置 `oai-authenticated-user-email: victim@…` 即可**完全读写该用户的 `sync_states` 与 `ai_configs`**（并触发对受害者密钥的服务端解密去发计费请求——明文密钥不回传客户端，但会被用来发上游请求）。注意：邮箱是低熵的，`SHA-256(email)` 不是秘密，知道目标邮箱即可算出键。

**定级理由**：本单所有者部署下，多租户 IDOR 爆炸半径 = 所有者一个账户，故 Medium；但这是把 100% 授权信任押在一个未认证入站头上、且**无任何应用内兜底**。若换一个/配错前门或 Worker URL 可直连 → **Critical 认证绕过**。

**修复方向**：加一个代理共享密钥头校验（或等价机制），让身份信任不是纯环境注入。**同时建议在部署层核实 Sites 确实剥离该客户端头。**

### 5. 🟡 Low — SSRF：不解析 DNS，公网域名指向私网可过

**位置**：`lib/assistant/core.ts:214-258`（纯字符串校验）。PoC 确认 `https://127.0.0.1.nip.io/v1` → **放行**。

**本架构影响低**：Cloudflare Workers 出网没有云 metadata（169.254.169.254 从 isolate 无意义），私网/回环从边缘一般不可路由；且只会把**用户自己的** `Bearer` 密钥发到**用户自己选的**主机，无环境凭据、无跨用户数据。`redirect:"manual"`（见下）也阻止已验证公网主机把请求弹走。属纵深防御建议（解析后再校验，或收敛为白名单），非本处可用于窃密的漏洞。

### 6. 🟡 Low — `/api/sync` GET 回传原始错误信息

**位置**：`app/api/sync/route.ts:16` → 503 体里 `error instanceof Error ? error.message : …`，把原始 D1/drizzle 异常文本（可能含 SQL/驱动内部）直接回客户端。POST 侧的 `db.insert(...)` 写入（39-43 行）**无 try/catch**，异常会走框架默认 500（视错误页可能带栈）。这是全站唯一未做错误脱敏的端点——AI 链路统一经 `assistantErrorResponse` 映射为固定码/文案。

**修复方向**：GET/POST 的 DB 调用改为返回固定文案，参照 `assistantErrorResponse`。

### 7. 🟡 Low — `/api/sync` 缺 no-store / force-dynamic

**位置**：`app/api/sync/route.ts:9-45` 两处 `Response.json(...)` 无任何头。全站其它 JSON 端点都用 `securityHeaders()`(`no-store, max-age=0`) 或 `responseHeaders()`(`no-store`)，且四个助手路由都有 `export const dynamic = "force-dynamic"`，唯独 sync 没有。这是唯一返回用户完整备份却不显式声明不可缓存的端点。

> **⚠️ 修订说明（本报告初版结论有误）**：初版此处写「Service Worker 经路径前缀排除，确实不会缓存 `/api/sync`」——**这是错的**。该结论只分析了 `sw.js:41-44` 的兜底分支及其路径前缀过滤，**漏掉了 `sw.js:33-39` 的导航分支会先命中并无条件缓存**。详见新增的发现 #11。缺 `no-store` 头因此不只是「声明性瑕疵」，它与 #11 直接叠加。

**修复方向**：两处 `Response.json` 复用 `securityHeaders()`；可加 `force-dynamic` 与其它路由对齐。

### 8. 🟡 Low — 全站无 CSP / X-Frame-Options / HSTS

`next.config.ts` 是空 stub（无 `headers()`），`worker/index.ts` 不注入头。单所有者、access-gated 部署下风险低；但一个 `default-src 'self'` + `frame-ancestors 'self'` 的基线成本几乎为零，可防范未来 Sites 访问门禁回归。低优先级纵深防御。

### 9. 🟡 Low/Info — 加密的三个纵深硬化点

AES-256-GCM 实现正确（见"打不穿"清单）。残留：
- **单一 `AI_CONFIG_ENCRYPTION_KEY` 加密所有用户密钥**——该 env 泄露 + DB 快照 = 全部密钥暴露（at-rest KEK 的固有性质；仅 DB 泄露仍受保护）。
- **AAD 是常量 `"pep-vocab-ai-config:v1"`（ai-config.ts:9），未绑定 `userKey`**——密文在行间可移植，仅在具备 DB 直写时可利用（此时已 game over）。
- **`encryptionVersion` 写入但从不读取**（route.ts:162，schema 默认 1），无 版本→密钥 映射 → 主密钥轮换会作废全部已存密钥（用户须重填）。

**硬化方向**：HKDF(masterKey, salt=userKey) 派生每用户子密钥，和/或把 `userKey` 折入 AAD。

### 10. 🟡 Low — 文档与代码不一致（2MB vs 5MB）

`README.md:56` 宣称私有同步上限 **2MB**，但代码 `MAX_PAYLOAD_BYTES = 5_000_000`（`app/api/sync/route.ts:7,32`）与 `PRIVACY.md:5`、`DATA_SCHEMA.md:66` 均为 **5MB**。README 把公开的"数据与隐私边界"配额少写了 2.5×。**修复**：README:56 「2 MB」→「5 MB」。

### 11. 🟠 Medium —（修订新增）Service Worker 把任意导航响应无条件缓存为应用外壳

**位置**：`public/sw.js:33-38`；配套 `lib/storage.ts:183-191`、`app/api/sync/route.ts:9-14`。

```js
if (event.request.mode === "navigate") {
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(VERSION).then((cache) => cache.put("/", copy));   // ← 无条件写入 "/"
```

导航分支对**任意同源导航响应**执行 `cache.put("/", copy)`：**不检查状态码、不检查 `content-type`、不尊重 `Cache-Control: no-store`、也不管请求 URL 是不是 `/`**。因此把已安装 PWA 的浏览器导航到 `/api/sync`（GET），就会把**该用户完整的同步备份 JSON** 以持久化条目写进 Cache Storage 的 `/` 键；离线时根导航会把这份私有 JSON 当作应用外壳返回。

注意它在 `sw.js:41-44` 兜底分支**之前**命中——初版报告只审了兜底分支的路径前缀过滤，因而误判为安全。

**与承诺冲突**：`lib/storage.ts:183-191` 的 `clearUserData()` 只清 IndexedDB 的 `stores`，**不清 Cache Storage**。故 PRIVACY.md「可在明确确认后清空本机数据」在这条路径上不成立——落盘的私有备份在"清空"后仍然留存。

**定级**：Medium。同浏览器配置内的隐私 + 可用性问题（共享设备/kiosk 场景更糟），无跨用户原语。

**修复方向**：导航分支只缓存**校验过的 HTML 外壳成功响应**（查 `response.ok` + `content-type` 含 `text/html`），遇 `no-store` 跳过，不要用任意导航覆盖 `/`；并在 `clearUserData()` 里一并 `caches.delete(VERSION)`。

### ⚪ Info/潜在 — 助手输出服务端未 HTML 转义

`cleanOutputText`（core.ts:311）不删 `< > &`，结果字符串可携带 HTML/脚本。**当前不可利用**：`components/`、`app/` 全无 `dangerouslySetInnerHTML`/`innerHTML`，React 自动转义，助手输出以纯文本渲染（本次前端由我编写，已核实安全）。但这是潜在约束：**若将来任何人给助手结果加 `dangerouslySetInnerHTML`，会立刻变成反射型 XSS**，因为后端不兜底。

---

## 打不穿的部分（验证为 SOLID）

- **API 密钥机密性——airtight**。解密后的密钥只存在于 `config.apiKey`，**仅**作 `Authorization: Bearer` 发往已验证上游；从不进响应体（只返回 `task/provider/model/evidence/result`）、从不进日志（`logConnectionTest` 只输出 `code/providerStatus/networkReason`）、从不进 prompt。`networkFailure` 从 `error.name/message/cause.code` 构串**仅用于正则匹配**并返回**固定**文案，原始错误被丢弃。`validApiKey` 的 `[\x21-\x7E]+` 保证头安全字节。
- **重定向/外发——无路径转发密钥**。探测 GET 不带 Authorization 且拒 3xx；每个带密钥的 fetch 都 `redirect:"manual"`；`readChatCompletion` 在 `!ok` 时经 `mappedUpstreamFailure` 把 3xx 映射为 `provider_redirect_rejected`。fetch 从不自动跟随，密钥不会被重发到 `Location`。
- **SSRF 字符串过滤——健壮**（除 #5 的 DNS 缺口）。PoC 确认拦截：`127.0.0.1`、`2130706433`、`0x7f000001`、`0177.0.0.1`、`[::1]`、全展开 `::1`、`[::ffff:169.254.169.254]`、`169.254.169.254`、`metadata.google.internal`、`100.64/10`、`[fe80::1]`、`10/8`、`172.16/12`、`192.168/16`、`*.localhost/.internal/.local`，以及账号/查询/片段拒绝。fetch 主机恒等于已验证 `baseUrl` 主机（`chatCompletionsUrl` 只改路径）。
- **加密核心——正确**。AES-GCM、每次加密新 `crypto.getRandomValues(12)` IV、AAD 上下文绑定、强制 32 字节密钥；同 scope 配置更新原样复制既有 `{encryptedApiKey,keyIv}` 不重新加密，故**无 IV 复用**。
- **无 SQL 注入**。`incrementBucket` 用模板串构造 SQL 但所有用户可控值都经 `.bind(?)` 绑定；`bucketKey` 拼进的是**键字符串**而非 SQL 文本再绑定；全部读写走参数化 Drizzle `eq()`；`sql\`\`` 仅用于常量 `CURRENT_TIMESTAMP`。
- **提示注入——上限很低（Info）**。唯一入 prompt 的自由文本是 `sentence`（≤600，NFKC-trim）；`masteryTags` 白名单过滤，`wordIds` 正则校验，其余枚举/整数。prompt 只含 `{task, 用户自己的请求, suppliedEvidence}`——无密钥、无服务端秘密、无跨用户数据（evidence 是共享公开发布索引）。输出硬校验：固定 JSON 形状、`evidenceIds` 限于所供证据、页码限于证据页、教材归属拒绝、字段长度封顶。成功注入至多在用户自己的返回字段放点良性文本，无外泄、无提权、不波及他人。
- **限流——稳健**。`> limit` 恰好放行 `limit` 次后拦（非 off-by-one）；`INSERT … ON CONFLICT DO UPDATE … RETURNING` 单语句原子（无 TOCTOU）；桶键内嵌窗口起点故首插即设对过期；桶按 `userKey` 键，无跨用户投毒；`DB` 缺失时 fail-closed。连接测试每次 2 次真实生成，限 6/分钟、30/天，计**用户自己**的账单，非服务端放大。
- **恢复原子性**。`restoreBackup`（`lib/storage.ts:165-181`）在开库前校验 `cards/events/lists/settings` 均为数组，clear+put 在单个 IndexedDB 事务内（原子），坏行抛错则**整个事务回滚**——畸形同步载荷不会污染/半清空本地数据。
- **前端密钥卫生**。设置页用 `type=password` + `autoComplete=off` + 瞬态 state（提交后 `setApiKey("")`），从不写 localStorage/sessionStorage/IndexedDB/console；有回归测试（`tests/assistant-proxy.test.mjs:279`）断言 `storage.ts` 不引用 `apiKey`。
- **无提交的密钥/PII**。`.gitignore` 覆盖 `.env*`；git 历史里 `AI_CONFIG_ENCRYPTION_KEY` 只有 `.env.example` 的空占位；`examples/*`、`public/data/*` 只有词库数据，无 PII。
- ~~**Service Worker 不缓存私有数据**~~ —— **此条已撤回，结论错误，见发现 #11**。

## 稳定性

- 单元测试 16/17 通过；唯一失败是本环境未 `npm ci` 导致 `ts-fsrs` 未安装（`tests/architecture.test.mjs`），**非代码缺陷**。安全相关套件（assistant-proxy、data-quality、redesign-contract）全绿。
- 唯一的稳定性型缺陷是 #3 的 ReDoS（CPU 型 DoS）。

## 建议修复优先级

1. **#1 + #2（同一文件）**：给 `/api/sync` GET/POST 加 `assertSameOrigin` + `application/json` 门禁；`baseRevision` 强制数字 + 事务化 CAS 写入。这一处修复同时关掉最高危的 CSRF 破坏面和静默覆盖。
2. **#3**：删/锚定 `parseJsonObject` 的去围栏正则（一行）。
3. **#4**：加代理共享密钥头校验（纵深，兜住"直连 Worker"这一最坏情形）。
4. **#6 #7 #10**：sync 错误脱敏 + no-store 头 + README 改 5MB。
5. **#5 #8 #9**：SSRF 解析后再校验 / 基线 CSP / 每用户子密钥——低优先级硬化。

---

*方法说明：本报告由所有者授权的自测生成，结合人工审计与多代理并行分析，关键结论均以 `file:line` 证据与可执行 PoC 支撑；评估过程未修改任何应用代码。*
