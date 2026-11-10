# 学习助手 harness 设计参考

核对日期：2026-11-10。资料来自产品官方文档与公开仓库；下方“词迹取舍”为本项目的设计判断。

## 三套参考框架

| 参考 | 已核实的设计 | 词迹取舍 |
| --- | --- | --- |
| [Codex App Server](https://openai.com/index/unlocking-the-codex-harness/) | 共用 core 负责模型循环、会话和工具执行；客户端消费 thread / turn / item 及其开始、增量、完成事件。工具沿统一策略进入沙箱。 | 把请求解析、模型调用、工具注册和结果校验分开；复用现有对话入口与账户边界。小任务保持短循环。 |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Python / TypeScript SDK 暴露 Claude Code 的循环、上下文、工具、会话与 hooks，并运行 Claude Code 进程。 | 借鉴轮次上限、取消、明确结束状态；现有 Worker 内使用小型 TypeScript 实现，沿用已配置模型。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek 官方开源项目，基于 Cordis，将模型适配、工具、会话日志和循环都做成可替换插件；官网 [Harness 页面](https://deepseek.com/harness/) 指向该仓库。 | 用小型、显式工具注册表保留扩展接口；当前学习场景采用固定服务端工具集。 |

### 可以直接借鉴的细节

- **成本与上下文**：Codex 的[循环说明](https://openai.com/index/unrolling-the-codex-agent-loop/)强调稳定指令前缀和固定工具顺序，变化内容追加在后；历史持续增长需要压缩。词迹优先限制历史、来源与工具结果长度，同一请求复用已加载的词库和学习上下文。
- **循环有终点**：Claude 的[循环文档](https://code.claude.com/docs/en/agent-sdk/agent-loop)提供轮次、预算和取消控制；只读工具可并行，写入工具顺序执行。词迹每一步复用现有 token 预留与结算，给工具调用总数和模型步数设置硬上限，留出最后回答所需预算。
- **权限在执行入口**：Claude 的[权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)说明自动放行规则可能早于回调生效。词迹应在每个工具执行前校验账户、允许工具名和参数；前端传入的历史、文章、文件及模型输出均不获得配置权限。
- **统一工具管线**：DeepSeek 的[架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)将会话事实、运行事件与能力接口分离；其[工具执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md)串联检查、执行、结果归一化和事件记录。词迹采用可观测的调用结果，保留工具名、成功状态及耗时，避免把密钥和完整学习资料写入日志。

## 对当前仓库的实现约束

`lib/assistant/server.ts` 已集中处理同源、账户身份、出站请求和 token 预算；`chat-core.ts` 已解析来源、选择模型并校验学习动作。harness 接在这些边界以内，模型自行选择本轮所需工具，再根据真实工具结果作答。

适合首批工具的是词库查询、已提供文章的字词统计、确定性计算，以及已获准提供的学习记录摘要。工具只返回完成任务所需的小结果；教材来源随词条返回。开始复习、听写等动作继续交给用户点击，沿用现有稳定词条 ID 校验。

采用 TypeScript 工具箱可直接运行于现有 Sites / Cloudflare Worker，避免增加语言运行时与跨服务开销。[Cloudflare 的 harness 文档](https://developers.cloudflare.com/agents/harnesses/)也将模型循环和底层运行、持久化能力分别组织。需要 Python 时，应另接具备 CPU、内存、时间、文件和网络边界的隔离执行服务；普通 JSON 参数和表达式解析器不应被标成通用 Python 沙箱。

## 验收要点

1. 覆盖正常工具查询、未知工具、畸形参数、过长结果、重复调用、步数耗尽和取消。
2. 每次模型调用经过预算边界；工具错误以结构化结果返回；达到上限后停止进一步执行。
3. 临时对话与关闭学习记录时，工具也遵循相同数据范围；历史与文件中的指令无法扩展权限。
4. 分开报告本地计算耗时、请求体大小与真实模型延迟；本地基准不代替付费上游测量。

以上资料为架构参考，实际功能和测量结果以本次实现与验证记录为准。
