# Workstream B Execution Review

本地完成日期：2026-08-29

计划来源：`docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md` 第 23.4 节

## 结果

Workstream B 已在本地实现并完成技术验证。Nora UI 不再获得完整 ST Runtime；`nora-story-core` 对外只暴露 `state`、`messages`、`cards`、`worldbook`、`model`、`settings`、`transport` 与 `worlds` 具名 Interface。`story.runtime`、`NoraRuntime.actions` 和 UI mount 的扁平 Runtime 参数已删除。

这次工作没有改变可见 UI、World 数据模型、持久化、复杂卡兼容策略或 Story Profile 业务行为，也没有部署到远端。因此当前证据等级是“已实现、已技术验证”，不是“目标环境用户结果已验证”或“已部署”。

## Scope Lock

保留：

- ST 兼容内核及其 Adapter 实现；
- `st-message-view-adapter.js` 作为消息 DOM 兼容 Seam；
- World Core v2 Interface 和现有 World 生命周期；
- 生成、编辑、重生成、人物、世界书、模型、MVU 与 Story Profile checkpoint 行为。

改变：

- `nora-runtime` 只发布 `story` 和 `story.state.whenReady`；
- UI mount 只接收 `story`，随后按用途注入具名领域 Interface；
- controller 不再依赖扁平 `runtime`；
- `ui-store` 分别消费 `state`、`settings` 与 `worlds`；
- 架构契约禁止重新引入 `story.runtime` 或 controller 的 `runtime.*` 调用。

延后：

- 远端部署和目标环境交互验收；
- Workstream D 的真实复杂卡与性能矩阵；
- 满足门槛后的 Workstream C legacy 在线路径退场。

## Interface 映射

| Module | 注入 Interface | 主要能力 |
| --- | --- | --- |
| `ui-store` | `state`, `settings`, `worlds` | 状态快照、UI 设置、World 读模型 |
| `interaction-controller` | `messages` | 发送、停止、重生成、智能回复 |
| `message-controller` | `messages`, `model` | 消息操作、生成态、模型前置校验 |
| `card-capability-controller` | `cards`, `worlds` | 复杂卡授权与能力恢复 |
| `character-controller` | `cards` | 角色解析、编辑和删除 |
| `worldbook-controller` | `worldbook` | 世界书与场景读写 |
| `model-controller` | `model`, `settings` | 模型后端配置与 UI 选择持久化 |
| `world-controller` | `settings`, `worlds` | World 生命周期与最近 World 选择 |
| `panel-controller` | `settings`, `worlds` | 人格设置与 World 操作入口 |
| `startup-controller` | `state` | 订阅与 ready 生命周期 |
| UI checkpoint / MVU adapter | `transport` | 受控请求头 |

## 计划对照

| 计划项 | 实现证据 | 状态 |
| --- | --- | --- |
| `nora-runtime` 传具名域 | `ui.mount({ story })`；ready 经 `story.state.whenReady` | 完成 |
| controller 按用途消费领域 Interface | 十个 controller 使用窄接口，无纯转发 Module | 完成 |
| `ui-store` 只从 state 取快照 | `createUiStore(state, settingsDomain, worlds)` | 完成 |
| 删除临时桥 | 产品源中无 `story.runtime`、`NoraRuntime.actions` | 完成 |
| 保持现有行为 | 220 个 Nora 行为测试和 24 个架构/产品契约通过 | 完成（本地技术验证） |

## 验证证据

- `npm run build:nora`：通过；Story Profile 同步无变化。
- `npm run test:nora`：220/220 行为测试通过。
- `node tests/run-nora-contracts.mjs`：24/24 契约通过。
- 静态边界搜索：产品源码无 `story.runtime`、`NoraRuntime.actions`、`runtime: story.runtime`。
- `git diff --check`：通过。

构建仍报告既有的 `lib-core.js` 与 `lib.js` 体积警告；本 Workstream 没有扩大启动资源范围，也不将该警告误报为本次已解决的性能结果。
