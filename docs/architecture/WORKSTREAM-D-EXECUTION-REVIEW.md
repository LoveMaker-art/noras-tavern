# Workstream D Execution Review

本地与目标环境执行日期：2026-08-29

计划来源：`docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md` 第 23.6 节

## 结论

Workstream D 的**后端兼容矩阵、后端性能预算、目标环境进程冷启动和热资源路径已完成技术验证并部署**。远端实测定位到一个确定瓶颈：生产发布包没有携带 ST `lib.js` 的独立生产产物，每个新 Node 进程都在监听端口前现场执行 Webpack。该阶段单独耗时 7,695ms，叠加 Node 初始化、默认内容检查和健康轮询后，5 次冷启动 P95 为 10,131ms。

现在发布链在构建阶段生成稳定的 `dist/_webpack/output/lib.js`，运行时优先复用并保留缺失时的编译回退。该产物同时纳入静态资源内容哈希和发布包完整性门。修复后 5 次隔离进程冷启动为 1,100–1,103ms，P95 1,103ms；生产 10 次 HTML + `entry.js` + `lib.js` 热路径 P50 32.3ms、P95 42.4ms。

这些证据同时排除了 World Core 读路径是启动主瓶颈：目标环境 `listWorlds` P95 3.84ms，3 个 World 的 `prepareOpen` P95 为 1.29–1.88ms。当前仍缺浏览器内的实际首屏、消息发送/刷新和可见 UI 稳定性验收，所以 Workstream D 整体还不能称为完成了“用户结果验证”。

当前证据等级：已分析、已实现、已技术验证、已部署；浏览器内用户结果未验证。

## Scope Lock

本 Workstream 增加脱敏兼容夹具、回归测试、可重复验收脚本和证据文档，并在取证确认后修正了生产前端库的构建/运行时归属。没有修改 Nora UI、World 数据模型、ST 激活逻辑、持久数据或超时策略。

## 可分发兼容矩阵

仓库内新增或固化以下脱敏夹具：

| 夹具 | 覆盖内容 | 后端结果 |
| --- | --- | --- |
| `sanitized-v2.png` | V2 PNG、first message、alternate greetings、内嵌 Worldbook | 通过 |
| `sanitized-v2.json` | canonical V2 JSON 到 ST Runtime PNG | 通过 |
| `sanitized-managed-mvu-v3.png` | V3 PNG、Managed MVU、内嵌 Worldbook | 通过 |
| `sanitized-v3.charx` | 无辅助资产 CHARX | 通过 |
| `sanitized-empty-v3.json` | 空 first message | 生成 header-only Session |
| `sanitized-same-name-different-v3.json` | 同名不同内容 Worldbook | 生成 collision-safe 名称，不静默复用 |
| `sanitized-regex-v3.json` | Regex only | 只声明 `regex` |
| `sanitized-tavern-helper-v3.json` | Tavern Helper only | 只声明 `tavern_helper` |
| `sanitized-managed-mvu-v3.json` | Managed MVU | 声明 `mvu,tavern_helper`，来源识别为 `managed` |
| `sanitized-embedded-mvu-v3.json` | Embedded MVU | 声明 `mvu,tavern_helper`，来源识别为 `embedded` |

canonical V2/V3 JSON 是当前支持边界。一个带 `spec: chara_card_v2`、但仍将人物字段平铺在顶层的 V1 形状混合 JSON，会稳定返回 `NORA_CARD_FORMAT_UNSUPPORTED`；它不是 canonical V2 数据。测试已锁定该边界，避免以后误把标签字符串当作实际结构版本。

## 真实复杂卡证据

以下 7 张本地真实 V3 卡通过完整后端验收，但二进制未写入 Git：

- 噬血狂袭 夜之帝国；
- 废土机娘 MVUZOD 3.7 lite；
- 电锯人；
- 废土机娘 MVUZOD 4.0；
- 萧凡宇宙；
- 作为机娘生活吧 2.0 MVU；
- 莓和白和夜的卡。

观察结果：

- 首次导入 7 张卡得到 7 个 World；同一 idempotency key 的并发提交复用同一个 Operation。
- Node Core 重建后恢复 7/7，`prepareOpen` 仍返回同一 World、Session、Runtime Card 和 Worldbook 绑定。
- `REPAIR_WORLD` 通过 7/7。
- 使用新 operation key 显式再创建第一张卡时得到第二个独立 World；删除第二个后第一个仍能打开。
- 删除全部 8 个 World 后列表为 0；共享 Worldbook 文件保留。
- 六张组合卡声明 `mvu,regex,tavern_helper`；“莓和白和夜的卡”只声明 `regex`。

这些结果验证的是后端 materialization 和权威身份生命周期，不等于浏览器扩展已经 READY。

## 本地后端性能

两组脚本在隔离临时目录中执行；以下数值不是 Liveware 用户启动时间：

| 样本 | import P50/P95 | `listWorlds` P50/P95 | `prepareOpen` P50/P95 |
| --- | --- | --- | --- |
| 10 个脱敏夹具 | 104.8ms / 187.8ms | 0.1ms / 0.1ms | 0.1ms / 0.1ms |
| 7 张真实复杂卡 | 171.2ms / 292.1ms | 0.1ms / 0.1ms | 0.1ms / 0.3ms |

对照第 14.1 节，后端 `listWorlds` P95 <= 100ms 和 `prepareOpen` P95 <= 200ms 均通过。导入总时长没有对应预算；计划要求的是 1 秒内出现首次进度反馈，该项必须在 HTTP/UI 工作流中验证，不能由本脚本代替。

## 目标环境证据

目标入口：`forward.agent-dashboard.clawling.io:15553`；运行目录：`/opt/data/apps/tavern-runtime`；状态目录：`/opt/data/tavern-state`。

- 已部署当前 Workstream D 构建；关键 Runtime/UI 聚合指纹与本地一致。
- 修复前 5 次隔离 Node 进程冷启动为 10,103.9–10,131.4ms，P50 10,111.4ms，P95 10,131.4ms。冷启动日志记录 Webpack 单阶段 7,695ms。
- 修复后 5 次隔离冷启动为 1,100–1,103ms，P95 1,103ms；5/5 日志均记录 `Using bundled frontend libraries.`。
- 生产 10 次热资源组合（HTML、Nora entry、ST lib）均返回成功，每次 1,165,389 bytes，P50 32.3ms，P95 42.4ms。
- World Core v2 开关启用，schema 2；3 个 World 全部为 READY。`listWorlds` 20 次的 P50 2.32ms / P95 3.84ms；3 个 World 各 10 次 `prepareOpen` P95 为 1.88ms、1.29ms、1.37ms。
- 两个声明复杂能力的 World 已持久 MVU、Regex 和 Tavern Helper READY evidence。MVU 用时 3–4ms，Regex 1–2ms，Tavern Helper 9,073–9,353ms；后者是异步支持能力，不阻塞基础 World READY。
- 部署前后用户数据数量一致：4 个人物文件、3 个聊天文件、2 个 Worldbook、11 个 World Core 持久文件。三个托管扩展全部存在，最近日志致命错误数为 0。
- 当前生产静态发布号为 `fd9f0fd4f8fd3bf1`；部署前运行目录完整保存在 `/opt/data/backups/nora-pre-startup-fix-40b4cda-runtime`（232MB）。

## 尚未完成的退出条件

以下内容必须在目标浏览器内完成：

1. World 打开后实际发送一条消息并验证持久化；刷新后验证 World、Session、人物和 Worldbook 投影。
2. 验证没有原生 ST 错误、思考/编辑控件竞态、重复布局或加载中间态泄漏。
3. 使用真正 Liveware 页面导航补齐 shell、bootstrap、base open 和可见首屏的 P50/P95。本次 5 次是真实 Node 进程冷启动，10 次是生产 HTTP 热资源路径，不应被误报为完整浏览器用户体感。

## 技术验证

- `npm run test:nora`：231/231 个行为测试通过。
- `node tests/run-nora-contracts.mjs`：24/24 个架构与产品契约通过。
- `node --test tests/nora-st-card-codec.test.mjs`：9/9 个格式与能力边界测试通过；该测试也包含在完整 Nora 测试中。
- `npm run build:nora`：通过；Story Profile 同步无变化。
- `git diff --check`、夹具 JSON 解析、CHARX 文件清单和验收脚本语法：通过。
- 远端隔离候选版启动、生产健康、运行进程、World v2 状态、数据数量和回滚备份：通过。

构建仍报告既有的 `lib-core.js` 780 KiB 与 `lib.js` 889 KiB 体积警告。它们会影响首次下载和解析，但本次已证实的进程冷启动主瓶颈是现场 Webpack，不是这两个文件的网络传输。

## 复现命令

脱敏矩阵使用：

```bash
node ops/scripts/smoke-st-world-materializer.mjs --compact app/engine/sillytavern/tests/fixtures/nora-world-compat/*.{png,json,charx}
```

格式与能力边界测试使用：

```bash
cd app/engine/sillytavern
node --test tests/nora-st-card-codec.test.mjs
```
