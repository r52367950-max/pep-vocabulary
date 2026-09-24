# AI 助手接口与部署

AI 助手是可关闭的增强层。核心浏览、学习、复习、搜索、统计、导入导出和离线能力不依赖外部模型。

## 接口

四个任务接口都要求站点身份，只接受正式词库 ID，并由服务端重新读取发布索引中的词义、词性与教材位置证据：

```text
POST /api/assistant/explain
POST /api/assistant/check-sentence
POST /api/assistant/generate-practice
POST /api/assistant/contrast-words
```

请求只发送完成任务所需的字段。例如：

```json
{ "wordId": "pep-1e3e7e41accdc5f7", "focus": "collocation" }
```

服务端会限制请求体、字段长度、词条数量与上游响应大小，校验模型结构化 JSON，并拒绝无证据页码、伪装教材原句及词库外证据 ID。上游不可用时返回统一中文错误，学习状态不受影响。

## 服务端配置

设置界面支持 DeepSeek 和 OpenAI-compatible Chat Completions，可配置 Base URL、模型名和服务端 API key。

首次通过设置界面保存配置前：

1. 部署 `drizzle/` 中的最新 D1 迁移。
2. 生成一个随机 32-byte 值并以 base64 保存为 Sites Secret `AI_CONFIG_ENCRYPTION_KEY`。
3. 由经过站点身份验证的用户在“设置 → AI 接口”保存自己的接口配置。

新保存的 API key 使用独立 96-bit IV 和绑定账号、服务商、规范化目标 URL 的 AES-256-GCM v2 上下文加密后保存到 D1；旧 v1 密文兼容读取并在成功保存时升级。服务端接口从不回显明文、密文、IV 或 Key 尾号。Base URL 的规范化目标发生变化时必须重新提交 API key，防止已保存凭据被转发到新目标。

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
- 模型输出只作为临时生成内容，不写回正式词库。

默认运行边界为 25 秒超时、每分钟最多 12 次、每日 30 次。用户可在设置页将超时调整为 10–60 秒、每日上限调整为 5–200 次。

## 变更与部署验证

按变更影响选择本地测试，命令见 [开发说明](docs/DEVELOPMENT.md)。身份、密钥、同源、限流、请求大小或超时变化需要对应回归；修改词条任务协议时覆盖其证据校验，修改分类时覆盖内容范围与枚举。

需要迁移或 Secret 的部署先在私有预览验证。真实服务商连接测试会产生少量模型用量，仅在任务授权覆盖时执行；不把两个服务商和全部错误场景规定为每次文档或界面修改的前置步骤。发布按当前授权和站点流程执行，并记录实际验证范围。
