# Workstream C Execution Review

执行日期：2026-08-29

计划来源：`NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md` 第 23.5 节

## 结论

World legacy 在线路径已退场。Nora 产品启动、列表、打开、导入、修复和删除只通过 World Core v2；旧数据的扫描与迁移只能由显式离线工具执行。

当前证据等级：已分析、已实现、已技术验证、已部署；五条浏览器产品流程尚未全部完成用户结果验收。

## 已删除的在线组件

- 后端 `src/endpoints/nora-worlds.js`。
- 后端 `src/nora-world-core/legacy-world-reader.js`。
- 浏览器 `legacy-world-reader-client.js`。
- 浏览器 `world-runtime.js` 的 v1/v2 切换组装。
- `worldCoreV2` feature flag、v1 启动分支、recent-chat 预取和旧 World 还原状态。
- v1 在线专用测试，替换为 v2-only 架构契约。

## 保留的迁移边界

`src/nora-world-core/legacy-migration.js` 保留为显式离线能力。它不被服务启动、bootstrap、World 列表或 World 打开路径 import。保留它是为了数据可恢复性，不构成第二套在线架构。

## 目标环境证据

- `GET /api/nora-worlds`：HTTP 404。
- `GET /api/nora-worlds-v2/status`：`enabled=true`, `schema=2`。
- `GET /api/nora-worlds-v2/worlds`：4 个 World，全部 `lifecycle.status=READY`。
- 其中三个复杂卡 World 声明 MVU、Regex 和 Tavern Helper，能力记录为 READY；这仅证明持久 evidence，不代表本轮浏览器已重新执行。
- 运行目录中 18 个 macOS `._*` AppleDouble 打包副产物已删除，剩余 0。
- 下线前的运行与数据备份位于 `/opt/data/backups/nora-v1-retirement-20260829-1.tar.gz` 和 `/opt/data/backups/nora-v1-retirement-ui-20260829-1.tar.gz`。

## 技术契约

- 服务启动只挂载 `nora-worlds-v2` router。
- Story Core 只组装 `createWorldCoreRuntime`。
- 生产 HTML 和启动 controller 不引用 feature flag、legacy reader 或旧 chat 预取全局。
- 架构审计将旧路径的“缺失”作为退出契约，而不再强制它们存在。

## 未被本 Workstream 证明的内容

本 Workstream 不证明消息生成、编辑并发送、重生成、智能回复、角色卡库与刷新恢复已在目标浏览器通过。这些属于 Workstream F，不得用 World API 健康或后端 READY 代替。
