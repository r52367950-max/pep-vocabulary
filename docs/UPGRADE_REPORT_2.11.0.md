# 词迹 2.11.0

本轮在原站 2.10.0 源码上完成界面简化和目标词自由选择，保留站点私有访问范围。

- 写作题卡只展示题目、难度和字数。题库、调整题目、推荐、随机和 AI 出题统一从「题目选项」进入；选题与编辑使用独立弹窗，编辑取消不改变原题。
- 「添加词」支持全词库英文／中文释义搜索、已学与已选筛选、教材筛选、跨搜索多选和批量追加。稳定 ID 去重；沿用写作／备份现有 20 词容量并明确显示剩余名额。临时模式可手选词，不读取已学记录。
- 词库选择、导出收进「词库选项」；阅读字号、作品信息和个人文章操作收进「阅读选项」；快速查词从「阅读工具」进入。搜索、筛选和主要学习动作仍可直接操作。
- 删除全站反复出现的题型参考、非考试原题、仅供参考、未核验和通用局限说明。保留作品署名、来源与许可，以及实际错误、隐私、费用和数据操作反馈。
- 公共菜单使用原生 popover；弹窗复用原生 dialog 和现有焦点／滚动管理。支持菜单方向键、Home／End、Escape 和关闭后的焦点恢复。界面适配深浅主题、手机与平板尺寸及减少动效设置。

## 设计依据

- [Apple：Menus](https://developer.apple.com/design/human-interface-guidelines/menus)
- [Apple：Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
- [Apple：Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
- [Anki：Browsing](https://docs.ankiweb.net/browsing.html)
- [NN/g：Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)

菜单处理短操作，复杂任务在单独弹窗完成；词语添加保持直接入口，选择先存草稿、确认后追加。

## 验证

- 依赖安装、TypeScript、生产构建及打包产物检查通过。修正旧锁文件将 tslib 2.8.1 的相同完整性摘要误标为不存在的 2.9.0 的记录，恢复可重复安装；未新增依赖。
- 完整单测首次运行 66／67 文件通过；剩余 skill-supply-chain 测试在允许子进程执行的环境中单独重跑，3 项通过。其余测试未出现失败。
- 新增目标词行为测试覆盖全索引中英文查询和排序、跨筛选草稿、去重、超过六词、20 词容量及释放名额。
- 本地 Chromium 浏览器验证了题目菜单、选题搜索、题目编辑确认／取消、跨搜索多选、容量边界、弹窗焦点恢复及手机无横向溢出；阅读和词库菜单、快速查词、字号修改和作品信息弹窗通过。浏览器没有未处理页面异常。
- 本地 Worker／临时 D1 运行时检查通过。未调用付费 AI，也未改变数据库结构或生产学习数据。

浏览器检查使用桌面、平板和手机尺寸的 Chromium；未在实体 iPad／Safari 上执行。本轮提供给用户的现场访问位置仍为原站 URL。
