# 有界设计复查：阅读与设置

实施状态：下面三项均已在 2.1.0 采纳。按用户缩减测试的要求，未为这三项微调新增测试或重跑完整验收。

整体判断：**Good**。阅读页的内容层级、三列到两列的适配、安静的正文和设置分类已经成立；本轮只建议下面三处小修。淡绿／燕麦／紫灰的手绘封面由主代理负责，沿用当前尺寸与排版即可。

亲自查看了 `artifacts/round3/screenshots/` 中的 `desktop-reading.jpg`、`ipad-reading.jpg`、`phone-reader.jpg`、`phone-settings.jpg`、`phone-settings-general.jpg`，并只读核对了阅读、设置组件及 CSS。截图外侧的灰色区域属于设备预览画布，不作为页面布局缺陷。未启动浏览器、Sites 或测试。

按 [apple-design-skill / SKILL.md](https://github.com/dickwu/apple-design-skill/blob/main/SKILL.md) 与 `references/hig-lookup.md`，读取了 main 分支的 12 个相关 HIG 文件：`accessibility.md`、`layout.md`、`typography.md`、`color.md`、`designing-for-ios.md`、`designing-for-macos.md`、`motion.md`、`settings.md`、`scroll-views.md`、`buttons.md`、`modality.md`、`toggles.md`。下面应用的是跨设备 Web 的可读性、触控与交互原则。

1. **Medium｜给正文字号按钮更从容的触控区域。**

   文件：`app/reading-surfaces.css`，`.reader-toolbar .reader-type-size button`。当前声明的字号按钮宽度下限为 36px，工具栏按钮高度下限为 42px；手机截图中的减号、Aa、加号也挤在一小块区域内。建议在触控／窄屏规则中把两个按钮设为 `min-width: 44px; min-height: 44px`，图标大小不变；让 `.reader-toolbar`／`.reader-tools` 必要时换行，避免同时显示查词和译文时挤压返回按钮。只扩大命中区，不放大整条工具栏。

   依据：`buttons.md › Best practices`：“Make buttons easy for people to use.”；`accessibility.md › Mobility` 同时强调尺寸与间距。44 CSS px 是此 Web 应用的舒适触控目标，不将原生 pt 数值生套为合规判定。[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)、[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。收益：反复调字号时更容易点中，保留现有轻量外观。

2. **Low｜让阅读分类退出动作蓝。**

   文件：`app/reading-surfaces.css`，`.reader-meta > span:first-child`；对应 `components/studio/reading.tsx` 中不可点击的文章类别 `<span>`。手机正文页的“故事与小说”与旁边“阅读”返回操作同为蓝色，容易被理解为可点开的分类链接。建议只把该类别文字改成 `var(--muted)`，保留当前字重；卡片列表的类别本来就使用此颜色。

   依据：`color.md › Best practices`：“Avoid using the same color to mean different things.” [Color](https://developer.apple.com/design/human-interface-guidelines/color)。收益：蓝色专注表达操作，正文页和文章列表的类别语义一致。

3. **Medium｜设置返回分类时恢复到原分类的焦点。**

   文件：`components/console-settings.tsx`，`.settings-mobile-back` 的 `onClick`。进入分类时已有 `panelHeading.current?.focus()`，但返回时只有 `setMobilePanel(false)`；随后 `.settings-content` 被隐藏，没有把焦点明确送回刚才选择的分类。建议保留分类按钮 ref，在返回后的下一帧对当前 `section` 对应按钮调用 `focus({ preventScroll: true })`。不改页面结构和切换动效。

   依据：`accessibility.md › Speech`：“Let people use the keyboard alone to navigate and interact with your app.” [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。收益：手机连接键盘、屏幕阅读器或平板键盘使用者返回分类后，可以顺着原位置继续操作；这是依据组件状态与隐藏规则作出的判断，未声称做过运行验证。

现有动效无需继续加码：设置开启 200ms、关闭 160ms，`useModal` 在减少动态效果开启时直接关闭，CSS 也已有对应关闭规则；这个方向符合 `motion.md › Providing feedback` 的简短、准确反馈原则。[Motion](https://developer.apple.com/design/human-interface-guidelines/motion)。设置中的外观选项、分类结构与正文内的字号入口均保留。
