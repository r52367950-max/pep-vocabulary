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
2. 将 `AI_CONFIG_ENCRYPTION_KEY` 配置为 Secret，值至少包含 32 个随机字符。
3. 设置 `AI_CONFIG_ADMIN_EMAILS`，多个允许管理配置的站点账号用逗号分隔。
4. 由允许的管理员在应用数据页开启 AI 增强层并填写接口信息。

API key 使用 AES-GCM 加密后保存到 D1，服务端接口从不回显明文。Base URL 的规范化目标发生变化时必须重新提交 API key，防止已保存凭据被转发到新目标。

也可完全使用服务端环境变量：

- `AI_PROVIDER`：`deepseek` 或 `openai-compatible`
- `AI_BASE_URL`
- `AI_MODEL`
- `AI_API_KEY`：必须配置为 Secret

可选运行参数见 `.env.example`。任何服务端变量都不得使用 `NEXT_PUBLIC_` 或 `VITE_` 前缀。

## 安全与运行边界

- API key 不进入 IndexedDB、浏览器持久化、客户端包、同步备份、导出文件或应用日志。
- Base URL 默认只允许 HTTPS，拒绝凭据、查询参数、片段、私网及特殊用途地址；本机 HTTP 仅能由显式开发变量开启。
- 配置写入要求同源请求、站点身份与服务端管理员名单。
- D1 使用按身份、分钟和日期的原子限流；限流存储失败时关闭请求。
- 上游连接与响应正文共用超时，并采用增量大小限制；不跟随重定向。
- 模型输出只作为临时生成内容，不写回正式词库。

默认运行边界为 20 秒超时、每分钟 12 次、每日 200 次，可由服务端环境变量调整。

## 部署后验证

在私有预览环境先执行迁移并配置 Secret，然后分别验证 DeepSeek 和一个 OpenAI-compatible 上游。至少覆盖：正常四接口、超时、429、错误密钥、无证据词条、非管理员配置写入，以及关闭 AI 后的本地降级。确认后再按现有站点发布流程提升版本。
