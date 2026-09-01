# Tavern

[English](README.en.md)

Tavern 是面向 Hermes / ClawChat 单用户工作区的 World 核心角色扮演运行时。它复用 SillyTavern 的角色卡、世界书、脚本和扩展兼容能力，同时由 Nora World Core 统一管理世界、会话、资源和长期状态。

当前稳定版本：[v2.0.6](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.0.6)

## 你可以用它做什么

- 导入 PNG、WebP、JSON 或 CHARX 角色卡，并创建相互独立的 World。
- 使用 SillyTavern 角色卡、世界书、正则、Tavern Helper 和 MVU 等兼容能力。
- 在会话中发送、停止、编辑、重生成和使用智能回复。
- 使用每 15 轮压缩一次的剧情账本，减少长会话的全量上下文负担。
- 通过 Story Profile 生成和查看用户偏好、故事年表及相关投影。
- 通过 Nora MCP 和四个 Hermes 技能读取、管理并操作 Tavern。

Tavern 保留复杂卡所依赖的 ST 兼容内核，但 World 身份、会话绑定、资源引用和持久操作由 Nora World Core 管理。它不是将原版 ST 页面直接包装成一个新入口。

## 先判断你的安装情况

| 当前环境 | 是否可以使用正式更新器 | 处理方式 |
| --- | --- | --- |
| 已安装旧 Python Tavern | 支持 | 迁移可识别的卡、世界书、World、聊天和 Story Profile 数据，然后切换到 Node Tavern |
| 已安装当前 Node Tavern | 支持 | 保留目标机器数据与模型配置，完整替换受管程序目录 |
| 空白 Hermes，从未安装过 Tavern | 暂不支持 | 当前发布器是升级与迁移工具，不是空白环境首次安装器 |

不要在空白 Hermes 环境中把下面的更新命令当作首次安装命令。首次安装需要单独完成程序落盘和两个 Liveware App 的创建；该流程尚未作为稳定的一键入口发布。

## 更新或从旧版迁移

### 1. 更新前

- 确认目标机器已经安装 Hermes / ClawChat，并可使用 Liveware。
- 暂停 Tavern 内正在生成的对话和其他写入任务。
- 确保目标机器有 Node.js 20 或更新版本、npm、curl，以及 Hermes 自带的 Python 环境。
- 不要手工删除旧 Tavern、World、聊天、模型配置或 Story Profile 数据。

### 2. 执行正式更新命令

在目标机器终端中运行，或者让 Hermes 原样执行：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

这条命令只选择 GitHub 最新的稳定 Release。它会校验发布清单与文件摘要、准备依赖、备份现有版本，然后直接更新 Tavern、Story Profile、Nora MCP、官方技能和 AGENTS。

### 3. 激活 Hermes 侧更新

当终端最终显示 `installed` 后，在 **ClawChat 对话中**发送：

```text
/restart
```

`/restart` 是 ClawChat 命令，不是终端命令。它让 Hermes 重新加载 MCP、技能和 AGENTS；更新器不会重启正在执行它的父 Hermes 进程。

### 4. 确认结果

更新完成后应满足：

- 原有两个 Liveware 入口仍分别显示为 **Tavern** 和 **Story Profile**，不会创建重复 App。
- Tavern 和 Story Profile 均可打开。
- 目标机器自己的模型与密钥仍然保留，发布包不会写入开发者模型或密钥。
- 可兼容的 World、角色卡、世界书、聊天和 Story Profile 数据仍可使用。
- Nora MCP 与四个官方技能在新会话中重新加载。

## 数据如何处理

程序更新和旧 Python 数据导入是两个独立结果：

- 更新前会完整备份现有 Tavern 状态。
- 能可靠转换的数据会被导入 Node Tavern。
- 不兼容或不完整的单条记录会保留原文件并写入待转换报告，不会因为一条异常数据阻止整个程序更新。
- 缺少依赖的 World 不会以“半个世界”的状态进入新运行时。
- 无效剧情账本不会覆盖仍然有效的原始聊天。
- Story Profile 有效数据及目标机器模型配置继续保留。

完整备份位于目标 Hermes 目录下的 `tavern-backups/<时间>-<版本>-<编号>`。确认新版数据和入口可用前，不要删除最新可用备份。

## 更新失败时

- 如果结果显示数据导入为 `partial`，表示程序已经安装成功，但部分旧数据等待人工转换；这本身不是回滚理由。
- 如果新版 Tavern 确实无法启动，更新器会直接恢复刚才的目录备份，并在最终结果中报告恢复是否成功。
- 本地健康检查只证明进程和基础接口正常，不等于 Liveware 公网入口、浏览器复杂卡和所有模型供应商均已验收。

更新器的详细兼容与恢复约定见 [Full-release contract](ops/skills/system/tavern-updater/references/release-compatibility.md)。

## 项目组成

| 目录 | 作用 |
| --- | --- |
| `app/` | Node Tavern、ST 兼容内核、Nora World Core、Nora UI、模型与生命周期代码 |
| `story-profile/` | Story Profile 核心、原版 UI、Nora 适配器和测试 |
| `nora-mcp/` | 面向 Hermes 的 Nora MCP 源码、工具契约与测试 |
| `ops/skills/` | Tavern、Tavern Ops、Tavern Updater、CardForge 四个官方技能及 AGENTS 受管块 |
| `ops/updater/` | 发布下载、备份、迁移、直接目录替换与启动恢复 |
| `docs/` | 架构决策、兼容矩阵、执行记录和版本说明 |

运行时数据、模型密钥、日志、缓存和依赖目录不属于发布源码，也不会随发布包分发。Tavern 面向单用户/单 Agent 信任边界；不同用户应使用不同实例和数据目录，而不是共享同一个公网多租户服务。

## 开发与发布

本地开发、测试、Story Profile 同步和正式打包说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

进一步资料：

- [v2.0.6 版本说明](docs/releases/2.0.6.md)
- [复杂卡兼容矩阵](docs/architecture/COMPLEX-CARD-COMPATIBILITY-MATRIX.md)
- [Nora MCP 能力与边界](nora-mcp/README.md)
- [Story Profile 项目说明](story-profile/README.md)
- [架构决策记录](docs/adr/)
