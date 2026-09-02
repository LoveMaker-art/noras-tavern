# Nora Tavern

[English](README.en.md)

## 项目介绍

Nora Tavern 是一个以“世界”为核心、可以被 Agent 管理的开源 AI 角色扮演应用。

它基于 SillyTavern 二次开发，保留了 SillyTavern 对复杂角色卡、世界书、脚本和扩展生态的兼容能力；同时，Nora Tavern 重新整理了原有的角色卡、聊天、世界书和运行状态之间的关系，尝试把 AI 角色扮演从“和一张角色卡聊天”推进到“管理一个持续存在的故事世界”。

在 Nora Tavern 中，世界、会话、角色、资源、剧情状态和用户偏好都可以被更清晰地组织，并逐步交给 Hermes Agent 中的 Nora 进行读取、维护和操作。

## 项目特色

- **Agent 可管理**：通过 Nora MCP，Hermes Agent 可以在用户授权下读取和管理 World、会话、角色、Story Profile 与运行状态。
- **以 World 为核心**：把角色卡、聊天、世界书、资源和长期状态组织成持续存在的故事世界。
- **兼容 SillyTavern 生态**：保留复杂角色卡、世界书、Regex、脚本、Tavern Helper、MVU 等能力。
- **支持长线故事**：通过剧情账本和 Story Profile 整理长对话、用户偏好、故事时间线和长期关系。
- **面向本地部署与迁移**：支持本地安装、备份、升级和旧数据迁移，并尽量保留用户模型配置和本地数据。

## 安装

Nora Tavern 支持两种安装方式：

- **完全版：安装 Nora + Tavern**：完整体验 Hermes Agent 管理能力，让 Nora 协助管理世界、会话、角色、记忆和应用状态。
- **精简版：只安装 Tavern**：仅安装 AI 角色扮演应用本体，可以正常游玩，但不包含 Nora / Agent 管理能力。

请选择安装文档：

- [安装 Nora + Tavern](docs/install-nora-tavern.md)
- [只安装 Tavern](docs/install-tavern.md)

已经完成安装后，请使用：

- [更新 Nora Tavern](docs/update-nora-tavern.md)

## 项目组成

| 目录 | 作用 |
| --- | --- |
| `app/` | Nora Tavern 应用本体，包含 SillyTavern 兼容内核、Nora UI、World Core、模型配置和本地生命周期代码。 |
| `app/story_profile_runtime/` | Story Profile 的内置运行快照，随 Tavern 一起发布，让用户不需要单独安装 Story Profile。 |
| `story-profile/` | Story Profile 的源码目录。开发者应修改这里，再同步生成 `app/story_profile_runtime/`。 |
| `nora-mcp/` | Nora MCP 服务源码，让 Hermes Agent 可以读取和管理 Tavern。 |
| `ops/installer/` | 首次安装器，用于把 Nora Tavern 初始化到本地 Hermes 环境。 |
| `ops/updater/` | 后续更新器，用于已安装环境的版本更新、备份、迁移和恢复。 |
| `ops/skills/` | 给 Hermes 使用的 Tavern、Tavern Ops、Tavern Updater、Nora CardForge 技能。 |
| `docs/` | 安装文档、架构说明、版本记录和 ADR。 |

`release/` 是本地生成的发布候选包目录，`local-state/` 是本地验证和审计记录。普通用户不需要阅读这两个目录。

## Story Profile 快照是什么

`story-profile/` 是源码，`app/story_profile_runtime/` 是打包进 Tavern 本体的运行副本。

这样做是为了让用户安装 Nora Tavern 后就能直接使用 Story Profile，而不需要再安装第二个项目。开发时不要手动维护两份逻辑；应该修改 `story-profile/`，再通过同步流程生成 `app/story_profile_runtime/`。

## 开发与发布

开发、测试、Story Profile 同步和正式打包说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

进一步资料：

- [Nora MCP 能力与边界](nora-mcp/README.md)
- [Story Profile 项目说明](story-profile/README.md)
- [复杂卡兼容矩阵](docs/architecture/COMPLEX-CARD-COMPATIBILITY-MATRIX.md)
- [架构决策记录](docs/adr/)
