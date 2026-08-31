# Workstream F Execution Review

执行日期：2026-08-29

计划来源：`NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md` 第 23.10 节

## 结论

Workstream F 已在源码中把五条产品流程变成可执行技术门禁，并修复了远端日志和最小回归用例确认的 Liveware 阻塞。

当前证据等级：已分析、已实现、已技术验证、已部署。本文不把非浏览器测试冒充为目标环境用户结果验证。

## 验收范围

1. 打开 Nora 并恢复权威 World。
2. 导入一张复杂卡为一个可恢复 World。
3. 发送、编辑并发送、重生成和智能回复。
4. 角色卡库分页、详情和显式创建新 World。
5. 刷新和 Node 重启后的 World、Session、资源、消息和 pending operation 恢复。

## 根因和结构修复

| 证据中的问题 | 根因 | 实现边界 |
| --- | --- | --- |
| 页面已可用，首次发送仍会隐藏等待 | `Generate()` 把 locales、system messages、avatars、personas 等 UI 任务串到生成前 | 生成只等待 full chat、token cache 和 Regex 基线；后续收口又将这四项无界面任务从 Nora 启动完全移除 |
| 同一复杂卡扩展可被多条链路同时激活 | 全局启动和能力按需激活没有共享 in-flight owner | extension name 维度的激活 task registry；Regex 由 Regex capability 明确请求 |
| 首次/手动 World 打开期间出现额外权威列表请求 | `worldChanged` 将激活错认为列表变更 | 激活事件只刷新本地 active-World 投影；无调用者的延时 reload 边界删除 |
| 后台操作可以每 150ms 永久轮询 | 客户端没有等待预算 | 150ms→1s 退避，单次最长 120s；超时错误包含 operation ID 且保留 pending 状态 |
| World 打开后还计算隐藏 Persona 编辑器的 token | ST Persona API 同时承担数据与可见管理页 UI | 保留 Persona 数据、事件和设置保存，Nora adapter 使用 `syncUi:false` 跳过隐藏 UI/token 工作 |
| 角色卡库每页 8 张但打开前顺序下载全部完整卡 | ST 详情数据被当成列表先决条件 | 列表只用浅元数据；详情只展开用户选中的一张卡 |

## 回归证据

- `nora-liveware-blocking-contract.mjs` 在修复前基线明确失败（缺少 extension in-flight registry），在当前源码通过。
- 新的 World operation 测试证明轮询间隔为 `10, 20, 25ms` 后封顶，且超时后 pending operation 仍可恢复。
- Persona adapter 回归在实现前会收到 `syncUi: undefined`，实现后两个 Nora adapter 均明确传入 `syncUi:false`。
- Nora 启动契约禁止恢复 `nora-deferred-core`；系统消息通过惰性无 UI Interface 生成，扩展翻译可在不启动 ST 语言面板时注册。
- 角色卡库回归在实现前打开 10 张浅卡会展开全部 10 张；实现后打开/切页展开 0 张，点击详情只展开 1 张。
- 五条技术流程门禁通过；它还支持 `--require-browser --browser-report` 严格模式，没有报告时不会声称用户验收。
- Nora 行为套件：239/239 通过。
- 架构契约：25/25 通过。
- `npm run build:nora`：通过。

## 目标远端部署证据

> 注：上述“四项无界面任务完全移除”已由运行提交 `63b80dd` 部署到同一测试环境；下方同时保留前一运行基线的审计证据。

- 运行源提交：`f38d6d3` (`refactor: remove Liveware workflow blockers`)。
- 备份：`/opt/data/backups/nora-liveware-f38d6d3-predeploy-20260829.tar.gz`，SHA-256 `9852ef89eb11a6eb98a35d4da8dd386907f688baf9238d1e79366c1137add445`。
- 部署后 `entry.js` SHA-256：`ff4987e45ac717e13f39c0de16216ff47662812e15da56af32f5715fcd9711ac`。
- 部署后 `inline-modules.json` SHA-256：`f28b7ed9b525c35c5290e30bc2ead72960435c04e8294d0556e0792b814cb39c`。
- 运行进程健康；`/api/nora-worlds-v2/status` 返回 schema 2，旧 `/api/nora-worlds` 返回 404。
- 4/4 World 的 lifecycle 与 Capability Set 均为 READY，部署未修改持久数据。
- 内容寻址资源返回 Brotli、`Cache-Control: public, max-age=31536000, immutable`。
- 最后一次重启后日志的 error/fatal/uncaught/unhandled 计数均为 0。
- 远端本机 5 次 root 和 World-list HTTP 请求均约 1ms；这只排除 Node 本机服务阻塞，不代表 Liveware 交付或浏览器指标。

### 无 UI hydration 收口部署

- 运行源提交：`63b80dd` (`refactor: remove legacy UI hydration from Nora startup`)。
- 目标 SSH 入口：`forward.agent-dashboard.clawling.io:27612`；运行目录与状态目录保持 `/opt/data/apps/tavern-runtime` 和 `/opt/data/tavern-state`。
- 回滚备份：`/opt/data/backups/nora-headless-63b80dd-predeploy-20260829.tar.gz`，SHA-256 `f5d1ea94d8924e6cb2bed9933175e538fc7b1cf56ea2bd877f028f5aa71a5bdd`。
- 活动 `inline-modules.json` SHA-256：`0498969cc116a9bf16291ef9407694aba7d8fa501ee0423f7ce7b16e22401367`；Brotli SHA-256：`9a1d5f741052937b45dcdbb19368e54dcd4f29ec780c6df0f8987c04da114049`。
- 内容寻址路径 `/assets/d73891617b6b8410/dist/nora/inline-modules.json` 返回 Brotli 且 `Cache-Control: public, max-age=31536000, immutable`，传输字节哈希与本地一致。
- 重启后 root 返回 200，World v2 状态为 schema 2，权威列表为 4 个 World。
- 部署前后保持 5 个角色文件和 4 个聊天文件；未更改或迁移用户状态。
- 最新进程启动行之后 `ForbiddenError|Error:|fatal|uncaught|unhandled` 扫描为 0。历史日志中一条旧 CSRF 失效记录位于本次启动标记之前。

## 保留的必要 ST 边界

- Runtime Card 的完整数据只在打开 World、详情或执行复杂能力时需要。
- Regex 是消息正确渲染与生成的基线先决条件。Tavern Helper 和 MVU 依声明按需加载，失败只使 Capability Set 降级。
- 创建、删除、修复、角色资料或 Worldbook 确实变更后，重新请求权威 World 列表仍是必要的一致性操作。

## 未完成的发布门槛

1. 不使用浏览器无法验证可见 UI、真实扩展 DOM 和模型生成结果。
2. 目标环境还需采集真正的 5 次 cold Liveware 和 10 次 warm navigation，确认 cold P95 ≤ 10s、warm P95 ≤ 5s。
3. 生产构建仍有 780 KiB `lib-core.js` 和 889 KiB `lib.js`。当前远端不变资产缓存正常；只有目标浏览器 profile 证明它们仍在关键路径上超预算时才拆分。
4. `/api/characters/all` 仍随卡片总数读取浅投影。本轮已消除角色卡库再次下载所有完整卡；若未来大卡库的启动指标证明该端点超预算，再引入后端读模型索引，不在无数据时新建存储子系统。
