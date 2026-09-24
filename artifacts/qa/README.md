# 浏览器与样式检查脚本

2.3.0 使用的可复现检查。浏览器脚本默认使用本环境预装的 Playwright 与 Chromium，可以用环境变量 `PLAYWRIGHT_MODULE`、`CHROMIUM_PATH` 改路径。先启动开发服务器（`WRANGLER_LOG_PATH=.wrangler/wrangler.log npx vite --port 5199 --host 127.0.0.1`），再运行下面的命令。任何一项不通过，脚本的退出码都是 1。

| 脚本 | 检查内容 | 用法 |
| --- | --- | --- |
| `css-overridden.mjs` | 同一选择器、同一上下文里被后面声明完全覆盖的 CSS 声明（死代码），不需要浏览器 | `node artifacts/qa/css-overridden.mjs --list` |
| `screens.mjs` | 3 种视口 × 浅/深色 × 16 个画面，共 96 张全页截图（时间、随机数固定，结果可以复现） | `node artifacts/qa/screens.mjs http://127.0.0.1:5199 /tmp/shots-a` |
| `pixel-diff.mjs` | 两组截图逐像素比较，差异会以红色标出 | `node artifacts/qa/pixel-diff.mjs /tmp/shots-a /tmp/shots-b /tmp/shots-diff` |
| `contrast.mjs` | 主要画面上所有可见文字的 WCAG AA 对比度；覆盖清晨、白天、黄昏，浅色和深色，普通和增强对比度 | `node artifacts/qa/contrast.mjs http://127.0.0.1:5199` |
| `dark-increased-contrast.mjs` | 系统深色加增强对比度时，令牌是否真的生效 | `node artifacts/qa/dark-increased-contrast.mjs http://127.0.0.1:5199/` |
| `large-text.mjs` | 用 CDP 把浏览器默认字号设为 32px（相当于 200%），检查词卡与配对里有没有被挤出屏幕或截断的控件 | `node artifacts/qa/large-text.mjs http://127.0.0.1:5199/ /tmp/large` |
| `back-gesture.mjs` | 系统返回手势：词库、词条详情、词卡、练习逐层关闭，到今日页再返回才离开应用；不重载页面，也不发 RSC 请求 | `node artifacts/qa/back-gesture.mjs http://127.0.0.1:5199/` |
| `back-gesture-offline.mjs` | 离线时按返回，停留在同一文档内，不会重新加载页面 | `node artifacts/qa/back-gesture-offline.mjs http://127.0.0.1:5199/` |

截图对比的做法：在改动前的提交上启动一个服务器，在改动后的提交上启动另一个，用同一个 `screens.mjs` 各截一组，再用 `pixel-diff.mjs` 比较。同一份代码连续截两次，结果逐像素相同，因此出现任何差异都来自代码改动。

运行时性能测量见 `artifacts/perf/`。
