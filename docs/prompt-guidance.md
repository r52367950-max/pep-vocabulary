# 模型提示指引依据

2026-11-11 核对官方资料；用户所称 Cloud Opus 5.5 按官方名称 Claude Opus 5.5 理解。

| 来源 | 与本项目相关的建议 |
| --- | --- |
| [OpenAI：Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) | Astra 更敏感于 AGENTS.md 和技能中的指令，应审查常驻文件；自主推进与澄清边界写清即可。测试按任务风险选择。 |
| [Anthropic：Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) | 用代表性任务校准 effort，默认 medium 是起点；去掉无必要的“仔细思考”提示。无人值守任务要明确完成条件，进度文字不等于完成。 |
| [OpenAI：AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | 项目规则简短、就近放置，检查格式交给工具。 |

项目采用的判断：根指引只保留稳定产品事实、数据与权限边界；删除重复协议、禁词表和无来源引用，不预定模型、代理数或推理强度。详细操作放在按需文档，`CLAUDE.md` 只导入根指引。

这些是提示建议，不是强制 API 要求。开发代理的规则与应用模型配置独立；本次不据此更换应用模型，也没有执行付费模型 A/B 质量评测。
