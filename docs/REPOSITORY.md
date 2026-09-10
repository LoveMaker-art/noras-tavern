# 仓库导航

这份文档说明当前源码职责。历史设计、验收记录和发布说明保留其当时结论，不作为当前实现的替代依据。

## 一张地图

```text
nora/                  诺拉是谁、如何工作
  SOUL.md              人格原文
  AGENTS.md            Hermes 操作规则，完整受管文档
  greeting.md          ClawChat 首次问候，简中 / 繁中 / 英文
  skills/              酒馆、运维、更新、制卡技能与样例
  hooks/               Liveware 注册与卡片通知 Hook

launcher/              用户打开的桌面启动器
  desktop/             Electron 主进程、preload、后台任务
  ui/                  正式界面、控制器、诺拉图片
  previews/            历史设计预览，不是正式入口
  bridge.py            UI 操作到部署逻辑的桥接

deployment/            安装后本地系统的生命周期
  install/             首次安装、目录选择、失败残留清理
  update/              完整系统更新与单独酒馆更新
  uninstall/           卸载与 Windows NSIS 集成
  shared/              共用配置、锁、进程、Liveware、上下文管控
  runtime/             实例命令、启动脚本、版本任务

app/                   酒馆本体，含 ST 兼容内核和 Nora World Core
story-profile/         Story Profile 唯一手写源码
nora-mcp/              Agent 操作酒馆的 MCP 接口
tooling/               构建、打包、校验、目录映射
tests/deployment/      安装、更新、回滚、卸载、启动器回归测试
docs/                  用户文档、当前导航、历史记录
```

## 一个业务，一份实现

- 酒馆的世界、会话与资源操作由 `app/engine/sillytavern/src/nora-world-core/` 和相应 HTTP 接口负责。启动器与 MCP 不另写一套世界逻辑。
- Story Profile 在 `story-profile/` 修改，生成 `app/story_profile_runtime/` 运行快照；快照不是第二套可独立编辑的源码。
- Nora 内容只在 `nora/` 维护。安装器和更新器读取同一份发布内容。
- `deployment/shared/managed_context.py` 统一 AGENTS 与问候文件策略；`model_config.py` 通过已有模型配置逻辑工作。首次模型同步不等于永久绑定 Hermes、酒馆和 MVU 的模型。
- 主界面只有 `launcher/ui/index.html`。保留预览文件供设计回溯，但发布入口不能指向预览。

## 安装、启动、更新、卸载

### 首次安装

启动器确认发布身份和平台完整组件，解压配套 Hermes 运行时，调用 `deployment/install/first_install.py`；同一流程配置 Nora 内容、技能、Hook、任务、MCP 和 Tavern。模型与 ClawChat 需要用户参与，组件文件齐全不等于完成全部首次设置。

### 日常启动

启动器读取既有安装和配置状态，分别管理 Nora/Hermes 与 Tavern。ClawChat 是对话入口，Liveware 是应用入口；两者不等于本地服务进程本身。关闭窗口不等于停止服务。

### 更新

| 对象 | 唯一入口与职责 |
| --- | --- |
| 启动器管理的完整本地系统 | `deployment/update/system-update.js` 管事务，`releases.js` 检查目标版本；调用同一初始化与校验逻辑更新 Hermes、Nora、Tavern、MCP 等，保留用户状态并支持失败恢复。 |
| 旧独立部署的 Tavern | `deployment/update/update.py` 管模块更新、旧数据迁移和恢复；不能替代完全版系统更新。 |
| Git 克隆、npm 启动的精简版 | 按精简版文档拉取源码、安装依赖和重新构建；不是启动器安装。 |
| 桌面启动器应用本身 | 下载对应平台新安装包替换应用，保留安装数据。不是完整系统更新事务内的自替换。 |

它们共享适用的配置、实例定位和校验逻辑，但更新对象不同。不能为了表面上只剩一个“更新”文件，把桌面应用、Agent 运行时和源码检出强行混成同一种升级。

### 卸载

`deployment/uninstall/` 负责确认、停止归属本实例的服务、保留数据或完全清理，以及 Windows 卸载入口。只操作确认的安装根目录，不把用户其他 Hermes 安装当作本实例。

## 为什么发布包仍有 ops

已发布安装器、增量模块清单和运行脚本依赖 `ops/`、`apps/tavern-ops/` 等路径。这是交付兼容协议，不是推荐的源码分类。

`tooling/source-layout.json` 把新的源码路径映射为原来的交付路径。例如：

| 编辑这里 | 构建时交付为 |
| --- | --- |
| `nora/SOUL.md` | `ops/installer/templates/SOUL.md` |
| `nora/AGENTS.md` | `ops/skills/agents-tavern.md` |
| `nora/greeting.md` | `ops/installer/templates/greeting.md` |
| `launcher/ui/index.html` | `ops/installer/launcher-conversation-prototype.html` |
| `deployment/update/system-update.js` | `ops/installer/desktop/system-update.js` |
| `deployment/shared/managed_context.py` | `ops/updater/managed_context.py` |

构建在临时导出目录内完成映射，原文与图像不改写。清单中的 `sourceFiles` 记录源码路径及哈希，`artifacts` 记录实际交付路径及哈希。它们各自可追溯，不要求路径相同。

这次整理不搬迁用户安装目录，也不改变旧发布资产名。**不要重新在源码根目录创建一份 `ops/`**；新增受管文件须通过映射和完整性测试，不能只放进仓库就认为已打包。

内部模块仍使用交付相对路径。开发执行统一通过 `tooling/run.mjs`，详见 [开发说明](../CONTRIBUTING.md)。这是为了保留已部署兼容协议的显式限制，不是所有新路径都可以直接执行。

## 两种开场白

- `nora/greeting.md`：ClawChat 中诺拉首次说的话，按传入语言选择。内容不自行查地址或发卡片，卡片由 Hook 处理。
- `app/engine/sillytavern/src/nora-world-core/builtin/welcome-*.md`：Tavern 内部的新手世界开场白。健康探测不能替用户选择语言，实际页面传入的语言参与初始化。

## 文档与生成物

- 用户入口：[完全版安装](install-nora-tavern.md)、[精简版安装](install-tavern.md)、[更新](update-nora-tavern.md)。
- 当前维护入口：本文、[开发说明](../CONTRIBUTING.md)、各源码目录 README、[领域语言](../CONTEXT.md)。
- 历史依据：`docs/architecture/` 中的日期快照、`docs/adr/` 决策记录、`docs/releases/` 发布记录。历史路径通过映射表追溯，不批量篡改旧记录。
- 生成物：`release/`、`node_modules/`、前端构建输出、MCP dist、Story Profile 快照。除明确受版本控制的快照外，不提交生成物。
- 私人数据：安装根目录、Key、日志、会话、备份均不属于仓库源码；`local-state/` 只保留说明文件。

上游授权文件和第三方声明保持原处。这次目录整理不替代项目顶层许可证选择，也不改变第三方授权。
