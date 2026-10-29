# 词迹 2.6：OpenAI 听说接入

## 使用

登录原站点，打开「设置 → AI 接口 → 使用 OpenAI 推荐配置」，填入 API Key 后保存。文字模型默认 `gpt-6.1-terra`，可改为 `gpt-6.1-sol`；实时口语固定 `gpt-live-1`，AI 听写固定 `gpt-audio-1.5`。模型可用性取决于该 API 项目的权限和余额，保存配置不表示已调用验证。

首页与侧栏都有「口语与听写」。口语默认日常生活 / B1 / 10 分钟，可以选择六个主题、B1/B2/C1 和 5/10/15/20 分钟。设备听写不需要 API Key 或麦克风；已安装的本地英语声音可离线，系统其他声音可能仍需联网。

## 接入选择

- 文字：官方 OpenAI 地址使用 Responses API；兼容服务保留 Chat Completions，已有 DeepSeek 配置不会自动更换。
- 实时语音：浏览器通过原生 WebRTC 传输音频，服务端使用已加密保存的 Key 创建 Live 会话并返回 SDP。长期 Key 不下发浏览器，不写入前端持久存储或学习备份。
- 会话关闭：浏览器发送 `session.close`；服务端通过 Live sideband WebSocket 发出相同命令，并等待 `session.closed`。刷新后可以关闭所属账号遗留的会话，不允许跨账号关闭。
- 听写：用户明确选择 AI 语音并点击播放后才请求音频。服务端核对返回转录与目标原文，并验证 WAV。重播和 0.8 倍播放复用本页音频缓存。
- 反馈：结束后可先修正转写，再请求文字反馈。最多两条改进，只能引用学习者实际发言；不从转写推断发音分数。

| 站点接口 | 用途 |
| --- | --- |
| GET `/api/voice/status` | 配置状态、应用秒数预算、尚未确认结束的会话 |
| POST `/api/voice/session` | 验证主题、难度、时长和 SDP，创建会话 |
| POST `/api/voice/close` | 验证会话归属并确认远端结束 |
| POST `/api/voice/speech` | 生成指定词语或句子的听写音频 |
| POST `/api/voice/feedback` | 根据可修正的对话文字生成反馈 |

所有接口复用站点身份、同源校验、服务端加密配置和用量控制。语音以 D1 原子预留每日 3600 秒，提前结束不退还应用预留；文字 token 另行预留。静音和思考暂停仍会产生语音费用。页面时限、单活锁和预算控制不等于服务商硬账单上限。创建请求若在拿到 session ID 前超时，无法确认上游是否创建，故不自动重试。

最近 12 次口语转写与反馈、最多 300 条听写记录仅存当前浏览器，不包含录音，不进入现有学习备份；可从各自页面删除。每次最多保留最近 150 段转写，长对话的反馈最多使用最近 18,000 字符。

## 研究与取舍

核对日期：2026-10-29。实现依据 OpenAI 的 [WebRTC 指南](https://developers.openai.com/api/docs/guides/voice-webrtc)、[Live 会话管理](https://developers.openai.com/api/docs/guides/live-conversations)、[sideband 控制](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)、[音频 Chat Completions](https://developers.openai.com/api/docs/guides/audio-chat-completions)和 [Responses 文本生成](https://developers.openai.com/api/docs/guides/text?api-mode=responses)。没有把旧 Realtime 事件名混用到 Live 协议。

也考察了 [LiTy](https://github.com/voidism/LiTy) 的语音/文字语言伙伴思路、[SpeakAlong](https://github.com/r4yg/speakalong) 的重复播放、隐藏文本、变速与本机学习记录。本次采用短任务、可隐藏答案、重播慢放和独立记录，未复制项目代码、录音或课文。教学依据与边界见 [VOICE_DESIGN.md](./VOICE_DESIGN.md)。

## 验证边界

单元测试覆盖 Responses 文本与流解析、转写分段、听写差异、取消后的迟到音轨清理、播放被浏览器拦截后的恢复、到时结束、会话归属、并发预算、关闭确认与超时。Worker 运行测试使用临时 D1 与测试密钥，不访问收费模型。

真实 OpenAI 模型权限、麦克风音质、iPad Safari 和付费音频端到端需配置真实 Key 后验证。云端浏览器没有可用设备朗读声音，已验证播放失败提示与未播放时禁止计分，不能视为声音播放成功。
