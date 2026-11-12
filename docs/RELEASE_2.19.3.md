# 词迹 2.19.3

此补丁优化云端快照校验与限流写入，并统一私有 API 的缓存与助手流失败处理。学习备份 schema 继续使用 1.2.0，数据库沿用迁移 0000–0009。

- 云端上传复用已经规范化的复习调度状态，去除复习链遍历中的重复计算，保留账号和版本冲突检查。
- 达到请求限额后继续返回 429 和重试时间，停止增加已满计数桶的数据库写入。
- Worker 对 API 响应统一设置私有、禁止缓存的策略，移除可能覆盖该策略的 CDN 缓存指令。
- AI 服务商在响应流中报告失败或取消时，中止读取并保留本次额度预留，避免把部分响应当作成功结算。
- React、React DOM 和 React Server Components 同步升级到 19.2.9，采用 [GHSA-xqc2-xf4c-x3h3](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3) 的修复版本。构建时捆绑 RSC 的 Vite 插件同步升级到 0.5.38，采用 [GHSA-59pf-q495-3c99](https://github.com/vitejs/vite-plugin-react/security/advisories/GHSA-59pf-q495-3c99) 的修复版本。CI 同时审计生产和构建依赖。
- 本地 Worker 和 D1 验收覆盖两个账户独立保存、并发写入冲突、切换账号后的迟到上传、元数据读取和迁移重放。

本地 SQLite 测试适配器中，含 100 条复习记录的同步 POST 中位耗时由 6.008 ms 降至 4.760 ms，含 1,000 条记录时由 54.354 ms 降至 43.732 ms。两组分别使用相同请求及数据库初始状态。数据反映本地路径，线上延迟还受网络及远程 D1 影响。
