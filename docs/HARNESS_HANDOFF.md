# AI 对话 harness 交接说明

日期：2026-11-10。后端部分到此为止，交给后续开发；前端继续在 `claude/great-dirac-prol0i` 分支进行。

## 一、参考了什么

| 来源 | 借用的做法 |
| --- | --- |
| OpenAI Codex CLI（官方 sandbox / approvals 文档；“Unrolling the Codex agent loop” 一文 403，没读到全文） | 沙箱与审批分开；默认只读或工作区可写、网络关闭；提示词按“最稳定的在前”排列以命中前缀缓存；每轮以一条助手消息结束 |
| Claude Code / Agent SDK 官方文档 | 循环：调用模型 → 执行工具 → 结果回传 → 直到无工具调用；只读工具可并行、写入类工具串行；`max_turns`、预算上限，触顶返回明确错误；被拒的工具调用作为工具结果回给模型；子代理/压缩用于长上下文 |
| DeepSeek Harness（dsh，README 与 docs/architecture、tools） | 工具 = 面向模型的 schema + 宿主专用字段（超时、并发安全、展示文案）分离；会话为只追加日志；工具执行前有 allow / deny / ask 关口 |

结论：本项目的工具只读、无副作用，不需要审批环节和写入沙箱；需要的是**有界的循环、只追加的上下文（保住前缀缓存）、工具错误不中断回合、每次模型调用都走现有计费与限流**。

## 二、后端已完成（未合并、未发版）

新增 `lib/assistant/harness/`：

- `python.ts`：Python 子集解释器。自写词法/语法分析和树遍历，不经过 `eval`/`Function`，没有宿主对象可达；支持数字、字符串、列表、元组、字典、集合、if/for/while、def、lambda、推导式、f-string、`math`、`mean/median`、日期函数 `today/add_days/days_between/weekday/weekday_name`。预算：源码 4000 字符、20 万步、约 100 万内存单元、序列 2 万项、输出 4000 字符、调用深度 40。所有失败返回中文错误和已打印内容，从不抛出。
- `tools.ts`：三个只读工具。
  - `lookup_words`：在已发布词库中核对词，支持大小写、括号短语、常见屈折变化（stopped→stop、studies→study），未收录时给出相近词。
  - `search_lexicon`：按册名/代号、单元、开头字母、中文释义筛选；册名或单元写错时返回可用名称。
  - `python`：调用上面的解释器。
  - 工具查到的词条进入 `evidence`（上限 96），模型给出的练习按钮只能引用这些 ID。
- `loop.ts`：`runHarness`。每回合最多 4 次模型调用，每步最多 4 个工具调用（多余的也会收到“没有运行”的结果，保证对话记录合法），参数 6000 / 结果 6000 字符截断，整回合 300 秒；最后一次调用强制 `tool_choice: "none"`，回合必定以回答或错误结束。只追加 transcript，系统提示词与工具列表字节不变。

改动的既有文件：

- `lib/assistant/core.ts`：Chat Completions（流式与非流式）和 Responses 两种格式都能解析 `tool_calls` / `function_call`；`responsesPayload` 把工具消息转成 `function_call` / `function_call_output` 并带上 `tools`、`tool_choice`。工具调用数量、名称格式、参数长度有上限，异常视为服务商错误。
- `lib/assistant/server.ts`：`handleChatRequest` 改为跑 harness；每次模型调用都经过 `complete()`（原子预留 token、结算、限流不变），工具定义计入提示词估算；用量汇总所有调用。兼容服务商若因 `tools` 字段返回 400 且尚未产生费用，降级为无工具单次回答，并在该 Worker 实例内记住。响应新增 `steps: [{tool, label}]`。
- `lib/assistant/chat-core.ts`：系统提示词重写（去 AI 腔：不写开场白/总结、不提自己是 AI、纯文字、数字要有来源），分“带工具/不带工具”两版；新增 `plainAnswer()` 去掉界面无法渲染的 Markdown；`today` 写入用户消息。
- `lib/assistant/chat-contract.ts`：新增 `ChatStep` 类型。
- `lib/assistant/prompt.ts`：结构化任务提示词加一条文风规则。

测试：`tests/assistant-harness.test.mjs` 15 项全部通过（解释器正确性、沙箱逃逸、失控程序、两个词库工具、schema 稳定、循环上限与超时、三种服务商格式、Responses 转换、纯文本清理、端到端路由含计费/降级/越权按钮/预算耗尽）。原有 `assistant-chat`、`openai-responses`、`assistant-response-boundaries`、`ai-quota-accounting`、`assistant-proxy` 共 33 项仍通过。

运行：`node --import ./tests/register.mjs --test tests/assistant-harness.test.mjs`

## 三、后端待办（建议顺序）

1. 跑一次完整 `npm test`（lint、构建、`test:runtime`）；本轮只跑了类型检查与上述测试。
2. 用真实服务商验证一次工具调用（`scripts/ai-harness.mjs --live` 可扩展一个 chat 用例），确认 DeepSeek 与 OpenAI Responses 的工具调用格式、`json_object` 与 `tools` 同时使用时的行为；会产生费用，需授权。
3. 前端接收 `steps` 后在 `chat-client.ts` 的 `CompanionResponse` 与 `persistence.ts` 中保存（前端会显示“查了词库 · 算了一下”）。
4. 文档：`AI_ASSISTANT_DEPLOYMENT.md` 补 `/api/assistant/chat` 的工具说明；按版本规则评估是否随前端一起升次版本。
5. 可选：把 `toollessHosts` 改为持久配置；评估是否开放 `search_lexicon` 的分页。

## 四、前端思路（本分支继续做）

问题与方向：

- **对话列表搜索框过高**（截图问题）：根因是全局 `app/studio-controls.css` 的 `.search-field { flex: 1 }` 等规则落在对话面板（纵向 flex）里，把搜索框撑满剩余高度。修法：对话面板内重置这些属性；另外对话少于 6 条时不显示搜索框，触屏打开面板时不自动聚焦搜索（避免键盘弹出遮住列表）。
- **全局样式泄漏**：浏览器审计到全局 `input/textarea/button/h1/h3/.icon-button/.small/.switch` 规则作用于对话界面（例如 `.switch { display:none }`、textarea 边框与 `resize: vertical`）。在 `components/studio/companion/styles.css` 中统一隔离。
- **去 AI 味**：开场白由“今天想学什么？”改为基于学习记录的事实（“今天有 N 个词该复习了”）；建议按钮改成学习者口吻、去掉装饰图标；回答下方用“查了词库 · 算了一下”替代模型名作为主信息；三点加载动画改为文字状态。
- **性能**：基线（50 段已保存对话、桌面、输入 142 个字符）脚本耗时中位数 1413 ms（面板收起）/ 1509 ms（面板展开）。原因是每次按键都重建对话列表与分组。改为面板关闭时不渲染、列表只在保存的对话或其他草稿变化时重算。改后重新测量并写入报告。

## 五、工作进度

| 项 | 状态 |
| --- | --- |
| 参考调研（Codex / Claude Code / DeepSeek Harness） | 完成 |
| harness：解释器、工具、循环、服务商适配、接入 `/api/assistant/chat` | 完成，测试通过，未跑全量 |
| 后端剩余（全量验证、真实服务商、文档、版本） | 交给他人 |
| 搜索框修复、样式隔离、文案、性能 | 进行中（本分支） |
| 报告（PNG / PDF / HTML） | 前端完成后出 |
