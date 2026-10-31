# 项目技能

词迹前端开发使用的 Claude Code 技能，放在仓库内以便每次会话都能加载。

| 技能 | 来源 | 许可 | 用途 |
| --- | --- | --- | --- |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | 见目录内 LICENSE.txt | 整体视觉方向、排版与文案 |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) | MIT | React 实现与性能 |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | MIT | 交互、响应式与无障碍检查 |
| `apple-design` | [dickwu/apple-design-skill](https://github.com/dickwu/apple-design-skill) | 未附开源许可；HIG 原文版权归 Apple，上游说明仅供辅助设计审查 | 按苹果 HIG 复查界面、深色模式、iPad 适配 |

2026-09-24 从各仓库默认分支复制，随后在本仓库维护安全修改。更新时审阅完整差异，保留本地安全边界；不要直接覆盖整个目录。`apple-design` 即 2.1 使用过的 apple-design-skill，现名 apple-design；它随附的 `scripts/pull-hig.mjs` 仅生成待审阅的临时参考资料，不直接更新代理加载的文件，也不属于应用代码。
