# AI 助手接口与部署

AI 助手是可关闭的增强层。核心浏览、学习、复习、搜索、统计、导入导出和离线能力不依赖外部模型。

## 接口

八个任务接口都要求站点身份，只接受正式词库 ID，并由服务端重新读取发布索引中的词义、词性与教材位置证据：

```text
POST /api/assistant/explain            词条讲解；focus 可选 meaning/grammar/collocation/exam/mistakes/general
POST /api/assistant/check-sentence     造句检查
POST /api/assistant/generate-practice  出题（1–10 题）
POST /api/assistant/contrast-words     易混词辨析（2–4 词）
POST /api/assistant/review-essay       作文深度批改（正文 ≤ 8,000 字符，题目或读后续写原文 ≤ 4,000 字符，目标词 ≤ 12）
POST /api/assistant/mnemonic           词根词缀与联想记忆
POST /api/assistant/story              用 3–12 个词生成短文与理解题
POST /api/assistant/diagnose           学习诊断与一周计划
```

请求可以附带 `profile`（学习画像）。例如：

```json
{ "wordId": "pep-1e3e7e41accdc5f7", "focus": "mistakes", "profile": { "recentMistakes": [...], "confusions": [...] } }
```

画像由浏览器从本机学习记录生成（`lib/learner-profile.ts`），服务端用 `lib/assistant/profile.ts` 逐字段校验、限长，丢弃非正式词库 ID，并从发布索引补上词头。范围见 [PRIVACY.md](PRIVACY.md)。

服务端会限制请求体（64 KB）、字段长度、词条数量与上游响应大小，校验模型结构化 JSON，并拒绝无证据页码、伪装教材原句及词库外证据 ID。作文批改中引用的原文片段必须能在作文里找到，找不到的批注会被略去并在 limitations 中说明。上游不可用时返回统一中文错误，学习状态不受影响。

## 提示词结构与缓存

请求按“最稳定的内容在前”排列，以便服务商的前缀缓存命中（DeepSeek 自动磁盘缓存，OpenAI 超过 1,024 token 自动缓存）：

1. `SYSTEM_PROMPT`（`lib/assistant/prompt.ts`）：所有任务、所有请求完全相同，包含规则、八个任务的输出形状和作文评分方法（[依据](docs/ESSAY_RUBRIC.md)），约 3,100 token。
2. 学习画像：键顺序固定的 JSON；浏览器在同一天内、新增复习不足 30 次时复用同一份，保证字节相同。
3. 本次任务、输入与证据。

对 `api.openai.com` 额外发送 `prompt_cache_key`；其他兼容服务不发送未知参数。服务商返回的 `prompt_cache_hit_tokens`（DeepSeek）或 `prompt_tokens_details.cached_tokens`（OpenAI）计入“缓存命中”。浏览器另把回答缓存到本机 `pep-vocab-ai-cache`，同一任务和输入再次查看不发请求。

## 输出上限、流式与预算

- `max_tokens` 统一为 10,000；已知模型的文档上限更低时取模型上限（如 `deepseek-chat` 8,192），设置页可再填更低的“单次输出上限”。DeepSeek V4/V4.1（`deepseek-v4-flash`、`deepseek-flash` 等）上限为 384K，因此实际为 10,000。OpenAI 官方 o 系列与 gpt-5 使用 `max_completion_tokens`。
- 回答以流式读取。设置里的超时（10–60 秒）是“无响应超时”：超过这么久没有新内容才中止；整个请求最长 5 分钟。回答因输出上限被截断时返回 `output_truncated`。
- 每日 token 预算默认 200,000，可设 1 万–500 万，按北京时间日期计。每次请求前检查，用完返回 `429 token_budget_exhausted`；用量按服务商返回的 `usage` 累计（没有时按字符估算），答案即使校验失败也计入。请求次数限额（每分钟 12 次、每日 5–200 次）保持不变。
- 预算与输出上限保存在 `ai_preferences` 表（迁移 `0003_small_smiling_tiger.sql`，`CREATE TABLE IF NOT EXISTS`）；用量计数复用 `ai_rate_limits`，键前缀为 `tokens:`、`tokens-hit:`、`tokens-out:`。未执行 0003 时使用默认预算，保存预算会提示先部署迁移。
- DeepSeek 请求显式关闭 thinking，避免推理 token 占用 10,000 的输出额度。

## 评测 harness

`scripts/ai-harness.mjs` 与 `scripts/ai-harness/cases.json` 覆盖八个任务：

```bash
node --import ./tests/register.mjs scripts/ai-harness.mjs                     # 离线：按服务端方式构建提示词，检查共享前缀
HARNESS_API_KEY=... node --import ./tests/register.mjs scripts/ai-harness.mjs --live [--case essay-practical] [--repeat 2]
```

真实模式默认 DeepSeek（`HARNESS_BASE_URL`、`HARNESS_MODEL`、`HARNESS_PROVIDER` 可改），每个用例默认发两次以观察缓存命中，报告写入 `artifacts/ai-harness/`，包含耗时、token、缓存命中、结束原因和是否通过生产校验。真实模式会产生费用；密钥只从环境变量读取，不写入报告。离线模式在 `npm run test:unit` 中运行。

## 服务端配置

设置界面支持 DeepSeek 和 OpenAI-compatible Chat Completions，可配置 Base URL、模型名和服务端 API key。

首次通过设置界面保存配置前：

1. 设置 `IDENTITY_TRUSTED_HOSTS` 为经过身份网关的精确域名（多个域名逗号分隔，不含协议、路径、端口或通配符）。缺失、空或非法配置会拒绝私有 API 身份；本地学习不受影响。本地测试需显式配置自己的测试域名，没有 localhost 自动绕过。
2. 确认这些域名的网关移除用户伪造的身份头，并禁用或保护绕过网关的 Worker / preview 入口。域名列表不替代经过验证的身份会话或签名断言。
3. 部署 `drizzle/` 中的最新 D1 迁移。
4. 生成一个随机 32-byte 值并以 base64 保存为 Sites Secret `AI_CONFIG_ENCRYPTION_KEY`。
5. 由经过站点身份验证的用户在“设置 → AI 接口”保存自己的接口配置。

新保存的 API key 使用独立 96-bit IV 和绑定账号、服务商、规范化目标 URL 的 AES-256-GCM v2 上下文加密后保存到 D1。旧 v1 密文缺少账号与目标绑定，运行时不再解密、发送或自动迁移；原配置行保留，GET 返回 `requiresKeyReentry=true` / `hasApiKey=false`，设置页提示用户重新填写服务商 API key。空密钥保存会明确拒绝，不覆盖原行；重新填写后正常保存为 v2 / v3。不能仅根据可被修改的数据库行推断旧密文的原归属或目的地。服务端接口从不回显明文、密文、IV 或 Key 尾号。Base URL 的规范化目标发生变化时必须重新提交 API key，防止已保存凭据被转发到新目标。

### 主密钥轮换

默认只需要 `AI_CONFIG_ENCRYPTION_KEY`，密文格式 v2，行为不变。需要轮换时改用带编号的密钥集，不改表结构：

- `AI_CONFIG_ENCRYPTION_KEYS`：JSON 对象，键为 kid（`^[a-z0-9]{1,16}$`），值为 base64 编码的 32 字节密钥，例如 `{"k1":"<当前 AI_CONFIG_ENCRYPTION_KEY 的值>","k2":"<新值>"}`。
- `AI_CONFIG_ENCRYPTION_KEY_ACTIVE`：新密文使用的 kid，必须存在于上面的对象中。

配置了 `AI_CONFIG_ENCRYPTION_KEYS` 后新密文写成 v3：AES-GCM 的附加验证数据为 `["pep-vocab-ai-config:v3", kid, userKey, provider, baseUrl]`，`encrypted_api_key` 存为 `kid:base64`，`encryption_version=3`。v2 密文始终视为 `k1`（对象里没有 `k1` 时使用旧的 `AI_CONFIG_ENCRYPTION_KEY`）；v1 始终拒绝。密钥集格式不合法、密钥不是 32 字节、kid 不合规或 `ACTIVE` 不存在时，加解密一律失败并返回统一的“无法使用密钥存储”错误，不会退回旧密钥。

轮换步骤：

1. 生成新的 32 字节随机值（`openssl rand -base64 32`）。先把当前 `AI_CONFIG_ENCRYPTION_KEY` 作为 `k1`、新值作为 `k2` 写入 `AI_CONFIG_ENCRYPTION_KEYS`，并设置 `AI_CONFIG_ENCRYPTION_KEY_ACTIVE=k2`；保留旧的 `AI_CONFIG_ENCRYPTION_KEY`。
2. 部署。已有 v2 密文仍可解密；之后每次在设置页保存并保留已有密钥时，服务端会用 `k2` 重新加密（`needsReencryption` / `reencryptApiKey`，条件是保存路径上凭据的 kid 不是活动 kid）。助手运行时在解密成功后可调用 `refreshStoredCredential()` 逐步迁移有作用域的 v2 / 旧活动密钥 v3。v1 用户必须重新填写 API key，不能懒迁移。
3. 确认没有遗留旧密文：`SELECT COUNT(*) FROM ai_configs WHERE encrypted_api_key NOT LIKE 'k2:%'` 必须为 0。仍有 v2 / 旧密钥 v3 的用户重新保存一次设置即可迁移；v1 行必须重新填写 API key。
4. 结果为 0 之后才从 `AI_CONFIG_ENCRYPTION_KEYS` 与 `AI_CONFIG_ENCRYPTION_KEY` 中移除 `k1`。

回滚：移除 `k1` 之前，把 `AI_CONFIG_ENCRYPTION_KEY_ACTIVE` 切回 `k1` 即可，`k2` 写下的 v3 密文继续可读。任何时候都不要在还有旧密文的情况下删除旧密钥；旧密钥丢失后对应密文无法恢复，用户需要重新填写 API key。

运行时懒迁移：`lib/ai-config.ts` 导出 `refreshStoredCredential(db, row, scope, plaintext?)`。在 `lib/assistant/server.ts` 的 `loadUserRuntimeConfig` 成功解密后调用它，传入带 `prepare()` 的 D1 对象、刚读取的 `{ encryptedApiKey, keyIv, encryptionVersion }` 行、解密所用的 `{ userKey, provider, baseUrl }`，以及已解出的明文。v1 在任何入口（包括传入明文时）均拒绝迁移。它只在有作用域凭据需要迁移时执行 `UPDATE ai_configs SET encrypted_api_key=?, key_iv=?, encryption_version=?, updated_at=CURRENT_TIMESTAMP WHERE user_key=? AND encrypted_api_key=?`，条件更新保证并发的设置保存不会被覆盖；永不抛出，返回本次是否更新了行。它不影响本次请求的成功判断，但当前实现仍等待 D1 更新完成。

从早期 GitHub 版本升级时保留并先执行历史迁移 `0001_flawless_human_cannonball.sql`，再执行 `0002_swift_cerise.sql` 创建按站点身份隔离的 `ai_configs`。早期全局 `ai_provider_config` 不再被运行时代码读取；升级后应由各用户在设置页重新保存自己的 API key。不要删除或改写已经执行过的历史迁移。

DeepSeek 默认配置为：

- Base URL：`https://api.deepseek.com/v1`
- 模型：`deepseek-v4-flash`

旧配置中的官方 DeepSeek 根地址会在服务端自动规范化为 `/v1`，并在目标凭据范围不变时保留已加密密钥。OpenAI-compatible 默认使用 `https://api.openai.com/v1` 与 `gpt-4.1-mini`，也可填写其他经过 HTTPS 与公网目标校验的兼容接口。

上述默认模型是应用运行时配置（见 `lib/ai-config.ts`），不是开发本仓库时对 Opus 或 GPT 的选型要求；实际服务可用性需另行验证。

另有 `POST /api/reading/classify`：用户主动开启分类时发送标题和最多 8,000 字符正文，复用身份、同源、限流和密钥保护。分类结果限于现有枚举，不修改正式词库。

## 测试连接与服务

`POST /api/ai/test` 执行分层、真实且有界的诊断：

1. 检查服务端是否已读取到加密配置；浏览器仍只知道 `hasApiKey`。
2. 先发送不带 API key 的 HTTPS 可达性探测。任何非重定向 HTTP 响应（包括预期的 401）都证明 Worker 已到达服务商；探测不会产生模型用量。
3. 可达后发送两个极小的真实 Chat Completions 请求，分别验证鉴权/额度/模型生成与结构化 JSON 能力。DeepSeek 请求会显式关闭 thinking，避免测试被推理 token 挤占。
4. 返回每一阶段的通过、失败或未检测状态及安全错误码；不返回上游响应正文、模型正文、请求内容或 API key。

官方 DeepSeek 会依次探测 `/v1/chat/completions` 与兼容旧路径，但拒绝所有重定向，任何凭据请求也设置 `redirect: manual`。网络异常只分类为 DNS、TLS、连接或未知类型，不把底层异常文本写入日志或发给浏览器。测试接口单独限制为每分钟最多 6 次。

## 安全与运行边界

- API key 不进入 IndexedDB、浏览器持久化、客户端包、同步备份、导出文件或应用日志。
- Base URL 默认只允许 HTTPS，拒绝凭据、查询参数、片段、私网及特殊用途地址；本机 HTTP 仅能由显式开发变量开启。
- 配置写入和删除要求同源请求、自定义动作头与站点身份。
- D1 使用按身份、分钟和日期的原子限流；限流存储失败时关闭请求。
- 上游连接与响应正文共用超时，并采用增量大小限制；不跟随重定向。
- 模型输出不写回正式词库；讲解等回答缓存在本机独立数据库，作文批改随作文保存在学习数据中。

默认运行边界为 25 秒无响应超时（单次最长 5 分钟）、每分钟最多 12 次、每日 30 次、每日 200,000 token。用户可在设置页将超时调整为 10–60 秒、每日次数调整为 5–200 次、每日 token 预算调整为 1 万–500 万。

## 变更与部署验证

按变更影响选择本地测试，命令见 [开发说明](docs/DEVELOPMENT.md)。身份、密钥、同源、限流、请求大小或超时变化需要对应回归；修改词条任务协议时覆盖其证据校验，修改分类时覆盖内容范围与枚举。

需要迁移或 Secret 的部署先在私有预览验证。真实服务商连接测试会产生少量模型用量，仅在任务授权覆盖时执行；不把两个服务商和全部错误场景规定为每次文档或界面修改的前置步骤。发布按当前授权和站点流程执行，并记录实际验证范围。
