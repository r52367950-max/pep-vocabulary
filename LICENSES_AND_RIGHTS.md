# 许可证与权利审计

核验日期：2026-08-03。发布目录只包含词头事实、短核心义、开放词典字段、应用代码和系统 TTS 指令；不包含教材 PDF、整页 OCR、整篇课文、商业词典批量内容或未核验真人音频。

| 资产 | 使用方式 | 权利/署名 | 发布处理 |
|---|---|---|---|
| 人教版教材 12 册 | 核验词头、册次、Unit、页码和极短词表事实 | 受版权保护，参考用途；不得公开再分发教材文件 | 原 PDF/OCR 在仓库外缓存；不进入 `public/` 或 Git |
| 高中英语课标 2017/2020、义务课标 2022 | 官方词汇范围和分级核验 | 政府/官方文件；本项目仍按参考源谨慎处理 | 只发布词头事实、层级和来源链接，不复制大段原文 |
| Open English WordNet 2025 | 英文简义与少量开放例句 | CC BY 4.0；Open English WordNet contributors | 保存 synset/署名；`englishDefinition: CC BY 4.0` |
| ECDICT | 中文核心义、词性和部分英文释义回退 | MIT；Copyright (c) 2025 Linwei | 保留 MIT 署名；只抽取目标词字段 |
| open-dict-data/ipa-dict | 英/美 IPA | MIT | 保留上游许可；与教材音标交叉确认 |
| mikigo/english-chinese-words | 初中词头、核心义和次序对照 | Apache-2.0 仓库；底层教材事实仍受原教材边界约束 | 不采用仓库扩展示例；与教材页图交叉核验 |
| Wiktionary/Kaikki | 已研究，当前发布包未直接导入 | Wiktionary 衍生数据通常 CC BY-SA/GFDL；必须记录 dump 版本 | 未进入本版，避免在未完成 share-alike 流程前误发布 |
| Tatoeba | 已研究，当前发布包未导入 | 句子文本多为 CC BY 2.0/CC0；音频逐条另核 | 不根据文本许可推定音频许可；本版无 Tatoeba 音频 |
| Wikimedia Commons | 已研究，当前发布包未导入 | 每文件作者与许可不同 | 本版无 Commons 音频 |
| 系统 TTS | 浏览器 Web Speech API 即时朗读 | 不捆绑音频文件 | UI 明示“系统语音”，失败时不阻断学习 |
| `ts-fsrs` | FSRS v6 调度适配 | MIT | 作为依赖保留许可 |
| Lucide | 统一图标 | ISC | 无 emoji 代替主图标 |
| Noto Sans / Noto Sans SC / Source Serif 4 | 本地打包字体 | SIL Open Font License 1.1 | 随依赖分发并保留许可 |

上游入口：[OEWN](https://en-word.net/)、[ECDICT](https://github.com/skywind3000/ECDICT)、[IPA Dict](https://github.com/open-dict-data/ipa-dict)、[Kaikki](https://kaikki.org/dictionary/)、[Tatoeba 下载](https://tatoeba.org/en/downloads)、[Tatoeba 条款](https://tatoeba.org/en/terms_of_use)、[Commons 复用说明](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)。

## 发布阻断规则

- `license` 中出现 `unknown` 或 `prohibited`：硬失败。
- 真人音频缺作者、来源页、许可或校验值：拒绝发布。
- 教材整页、整段课文、大型 OCR 缓存：拒绝进入公开静态资产。
- 模型单独生成且未经人工规则/人工审校的词典内容：保持 `provisional`，不得冒充正式字段。
- 商业词典内容：仅允许少量人工核对，不做批量抓取或改写发布。

当前无 R2 音频包，未配置付费 API，也没有前端密钥。

