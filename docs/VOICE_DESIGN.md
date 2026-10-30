# 听说练习的教学边界

词迹原创主题和练习句不冒充教材、考试原文或真人录音；设备朗读和 API 合成音均显示来源。现有词条沿用其 ID 和词库来源。

口语以交际目标、短回复和每次一个问题为核心。鼓励先完整表达，再看一至两条可执行反馈并重做相近任务。参考 British Council 的[反馈循环](https://www.teachingenglish.org.uk/comment/217632)与[口语反馈](https://www.teachingenglish.org.uk/comment/212572)。这是产品设计取舍，不宣称即时反馈或延迟反馈在所有任务上必然更好。

CEFR 强调[可理解度与声音、韵律](https://www.coe.int/en/web/common-european-framework-reference-languages/phonological-competence)，而非消除母语口音。转写可能出错，不从转写结果虚构发音分数、音素诊断或正式 CEFR 等级。

听写是逐字听辨与拼写练习；匹配数只描述本题文字对照，不代表综合英语水平。参考 British Council 的[听写与 dictogloss 区分](https://www.teachingenglish.org.uk/professional-development/teachers/knowing-subject/using-dictation)。当前模式没有把意译当作精确听写答案。

听写记录单独保存在当前浏览器，最多300条；不会改变 FSRS 卡片、复习事件或主数据 schema，目前也不进入原有备份。显露答案后的尝试不记入掌握记录。语音按点击请求；页面内缓存24段音频，慢速以同段音频的播放速率实现，离开后释放。停止与取消只能停止客户端继续等待，不能保证上游已经处理的请求免计费。设备朗读优先本地英语声音；系统声音可能仍需网络，界面按实际声音类型提示。


## 2.7 交互补充

准备、通话和复盘分别呈现。字幕是可选辅助，隐藏不删除转写。文字复盘允许追问，基于实际转写给建议；记忆候选经用户选择保存，避免将偶然提及或 AI 推断当成长久事实。长期记忆说明保存范围、使用开关与删除方式，不声称与 ChatGPT 记忆互通。

参考 Apple Design 技能中的内容优先、逐步展开、44px 触控目标与减少动效原则；沿用词迹现有颜色与系统字体。参考 OpenAI Live 会话管理的文字/音频状态分离与关闭确认，不用固定“轮到你”文案推断说话轮次。

## 2.7.1 界面减法

主屏采用平面布局，不再把准备设置、对话、记忆和历史排列为多层圆角卡片。顶部保留菜单与设置入口；未开始时只有一个开始操作，通话底部只常驻静音与结束。显示文字时，转写直接呈现在主背景上；隐藏文字时保留简洁的语音状态图形。图形不代表实测音量或识别到的说话轮次。

话题、难度、时长、AI 推荐与记忆管理进入设置面板；历史与完整转写按需打开。面板关闭不重建语音连接、不丢弃记忆编辑草稿；通话期间禁止加载历史记录或切换练习类型。连接失败、需要补充配置、播放解锁等恢复操作仍在需要时直接呈现。

设计依据为 Apple HIG 的 [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)、[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) 与 [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)，2026-10-30 核对：限制显著操作数量、避免工具栏拥挤、每次只打开一层面板。具体的两按钮语音操作与平面化内容布局是本产品结合使用者截图作出的取舍，并非 Apple 对所有语音界面的规定。
