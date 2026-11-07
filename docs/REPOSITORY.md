# 仓库导航

产品行为以[产品总览与三份模块设计](product/README.md)为准；本文说明源码归属，不替代产品规则或证明功能已经发布。

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
  bridge.py            UI 操作到部署逻辑的桥接

deployment/            桌面与云端部署的安装维护生命周期
  install/             首次安装、目录选择、失败残留清理
  update/              独立核心任务、组件更新与历史恢复
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

<a id="shared-implementation-boundaries"></a>
## 一个业务，一份实现

启动器负责交互、传参和任务编排，注册、配置和运行复用下表的公共实现。

- 酒馆的世界、会话与资源操作由 `app/engine/sillytavern/src/nora-world-core/` 和相应 HTTP 接口负责。启动器与 MCP 不另写一套世界逻辑。
- Story Profile 在 `story-profile/` 修改，生成 `app/story_profile_runtime/` 运行快照；快照不是第二套可独立编辑的源码。
- Nora 内容只在 `nora/` 维护。安装器和更新器读取同一份发布内容。
- 主界面只有 `launcher/ui/index.html`。已退出使用的设计预览通过 Git 历史回溯。

<a id="implementation-owners"></a>
## 当前代码职责与入口

| 职责 | 维护入口 | 文件保留依据 |
| --- | --- | --- |
| 启动器页面与通信 | `launcher/ui/index.html`、`launcher-controller.js`、`desktop/preload.js` | 正式页面、交互状态和 IPC |
| 桌面编排 | `launcher/desktop/main.js` | 实例路径、窗口、启动退出和维护操作派发 |
| 操作资格、证据与恢复 | `operation-state/result/policy/inspection/history`、`operation-lock/worker/delegate`、`os-lock`、`evidence-store`；Python `operation_control/cli/evidence` | 维护锁、执行身份、结果核对、重试和恢复权限 |
| 首装与运行时准备 | `runtime.js`、`runtime-worker.js`、`runtime-transaction.js`、`deployment/install/bootstrap.py`、`first_install.py` | 运行时闭包、首次安装和 `FirstInstallJournal` 恢复；旧测试专用恢复 helper 已退出 |
| 独立核心更新与恢复 | 诺拉更新技能 → `deployment/update/task.py`；`task_backend.py`、`updater-task.js`、`update.py`、`recovery.py`；官方接入用 `bootstrap.py` | 固定同一核心目标，由独立任务处理准备、停服、程序替换、验收和恢复；不经 APP 代执行 |
| 桌面应用更新 | `launcher-update.js`、`replace-launcher.py` | 替换 APP、验证交接及保留本地系统数据 |
| 历史安装兼容 | `legacy-recovery-worker.js`、`deployment/update/system-update.js`、`prepare-state.mjs`、`python-*` | 实际历史事务恢复和旧数据迁移入口 |
| 实例绑定、状态与内容配置 | `deployment/runtime/nora-instance.py`、`deployment/shared/nora_system.py`、`nora_profile.py`、模型配置、`managed_context.py` | 程序、数据与解释器绑定；历史／严格验收；AGENTS 与问候文件的共用策略 |
| 酒馆模型初始化与同步 | `deployment/shared/model_config.py`、`app/native_model_config.py::NativeSettingsClient.configure` | 首次配置先判断是否允许同步，再调用公共写入函数；读回校验、凭据写入与失败回滚共用实现 |
| Liveware 与 ClawChat 集成 | `deployment/shared/liveware_integration.py`、`liveware_notice.py`、`clawchat_greeting_patch.py` 及 `clawchat-greeting-order.patch` | 身份、隧道、入口注册／重试，核验后的卡片通知与去重，以及构建预应用、安装时核对的问候补丁 |
| 服务与进程归属 | `app/native_lifecycle.py`、`deployment/shared/runtime_process.py`、`runtime_lock.py`、`service_manager.py`、`services.py` | 实际服务生命周期、归属和关闭证明；存在动态调用 |
| 卸载 | `deployment/uninstall/uninstall.js`、`uninstall-offline-check.js`、`uninstall.nsh` | 保留／彻底清理、数据范围和 Windows 安装器入口 |
| 下载与故障诊断 | `release-network.js`、`release-sources.js/json`、`local-release.js`；`deployment/shared/error_diagnostics.py`；`diagnostics`、`telemetry`、`fault-packet`、`lifecycle-diagnostics`、`operation-log-delivery` | 来源和字节校验；桥接、首装、更新及酒馆 CLI 共用有界异常类型、调用位置和原因链投影；跨进程接收、远端脱敏、持久队列和接收确认分别核验 |
| 酒馆后端与界面 | `app/engine/sillytavern/src/nora-world-core/`、Nora HTTP endpoints、`public/scripts/nora-*`、`app/native-extensions/nora-ui/` | 唯一 World／Story Session 业务、HTTP 接口、界面与兼容绑定 |
| Agent 工具接口 | `nora-mcp/src/server.ts`、`nora-control-plane.ts`、`st/inspection-plane.ts`、共享 HTTP 客户端；`deployment/update/update.py::render_mcp` | 工具调用已有后端；首装生成 MCP 配置复用同一函数并显式传入端口；旧 ST 索引器和无人消费的错误类已退出 |
| 档案、内容与兼容运行时 | `story-profile/`、`nora/`、受管 Helper／EJS／MVU | 手写档案与内容源、经过校验的交付副本、现有卡片和脚本运行能力 |
| 构建、验收与发行 | `tooling/source-layout.json`、`layout.mjs`、`run.mjs`、`tooling/release/`、`tooling/runtime/`、`tests/` | 唯一源码投影、固定制品身份和各自独立的验收合同；启动器依赖只维护 npm 锁 |

当前逐文件索引由仓库根目录的 `node tooling/checks/index-project.mjs` 生成，输出为忽略的 `.codebase-memory/project-index.json`。该索引记录路径、职责、状态和摘要；引用调查仍需覆盖动态调用、交付映射、CLI、构建以及外部兼容用途。

<a id="instance-contexts"></a>
### 实例上下文与配置边界

模型、安装、更新、档案和 Liveware 共用 `nora-instance.py` 的实例定位；无标记查询复用既有绑定，有标记的故障查询保留独立 JSON 读取。普通 Hermes 的公共脚本沿用 `HERMES_HOME`／`TAVERN_DATA_ROOT` 和原有默认目录；启动器专属实例显式传入隔离的 Hermes、Tavern 目录和端口。

两种上下文共用整份 AGENTS 替换，只保留一份前版 `.bak`，不维护受管片段模式；SOUL、自定义问候和用户数据按各自策略处理。首次模型同步不将 Hermes、酒馆与 MVU 永久绑定，已有酒馆模型不随日后 Hermes 模型修改而被覆盖。锁与恢复代码闭包的交接见[维护机制](launcher-unified-update.md#maintenance-locks)。

## 安装、启动、更新、卸载

### 首次安装

启动器确认发布身份和平台完整组件，解压配套 Hermes 运行时，调用 `deployment/install/first_install.py`；同一流程配置 Nora 内容、技能、Hook、任务、MCP 和 Tavern。模型与 ClawChat 需要用户参与，组件文件齐全不等于完成全部首次设置。

<a id="startup-order"></a>
### 日常启动

启动器读取既有安装和配置状态，分别管理 Nora/Hermes 与 Tavern。ClawChat 是对话入口，Liveware 是应用入口；两者不等于本地服务进程本身。关闭窗口不等于停止服务。

完整启动 Nora 与 Tavern 时，先启动本地酒馆并独立检查健康，再启动 Hermes 网关并确认 ClawChat 连接。公共注册任务随后核对当前身份、注册／验证入口并发送卡片通知；它不等待模型开场白，模型问候也不查找或发送卡片地址。

本地健康不证明 ClawChat 入口已经注册；入口未就绪时本地酒馆仍可用。入口 URL 经公共 `verified_entry` 校验，不使用历史会话地址代替。启动器模式的注册任务不自行重启已停止的酒馆，酒馆停止后退出等待或重试；停止酒馆与注册互斥，单独停止 Nora 不终止本实例 Liveware。普通 Hermes 的启动钩子仍由公共流程先启动本地酒馆，不依赖启动器。Hermes 网关归属和进程管理由 `deployment/shared/services.py` 负责，与酒馆生命周期实现分别管理。

### 更新

产品范围和验收要求以[现行产品基线](product/README.md)为准。[可靠性交付执行与证据导航](launcher-reliability-plan.md)登记当前任务、未完成范围及历史证据，不另立产品规则。已完成任务保留日期和原验收范围，不作为仍待执行的计划。

当前执行机制见[安装、核心更新与启动器自更新](launcher-unified-update.md)。技术说明与特定制品的目标平台验收分别记录。

| 对象 | 唯一入口与职责 |
| --- | --- |
| 完整版首次安装与共用维护协议 | `operation-state.js` / `operation-policy.js` 提供操作记录和策略；`runtime-transaction.js`、`first_install.py` 保存首装事务。APP 与核心任务共用适用的原生互斥，各自验证和结束，不合成联合更新。 |
| 诺拉对话发起的核心更新（桌面及无APP部署） | 技能通过`deployment/update/task.py`交给同一独立核心任务；`task_backend.py`、`update.py`和`recovery.py`按实际绑定处理更新、旧数据迁移及恢复，不要求或唤起桌面APP。 |
| Git 克隆、npm 启动的精简版 | 按精简版文档拉取源码、安装依赖和重新构建；不是启动器安装。 |
| 桌面启动器应用本身 | `launcher-update.js` / `replace-launcher.py` 只替换APP并验证同一操作交接，确认其程序效果后结束自身任务；历史未确认的恢复仍保留。完整安装器也可覆盖更换APP，保留原数据目录。 |
| 存量联合更新及旧 JS 事务 | 按原记录核验已发生的程序效果；APP 只恢复已开始的 APP 替换，核心由对应执行器处理。`system-update.js` 等历史兼容模块继续保留，不作为新联合任务入口。 |

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
- 当前维护入口：本文、[文档分类入口](README.md)、[开发说明](../CONTRIBUTING.md)、各源码目录 README、[领域语言](../CONTEXT.md)。
- 架构决策与技术方案：[ADR 状态索引](adr/README.md)区分有效和已取代的决策；[技术方案索引](design/README.md)区分现行说明、专项计划和历史评估。
- 历史依据：[架构快照](architecture/README.md)、[执行报告](reports/README.md)、[验收证据](verification/README.md)、[发行记录](releases/README.md)保留各自日期、源码和实际验证范围。历史路径通过映射表追溯，不批量篡改旧记录。
- 生成物：`release/`、`node_modules/`、前端构建输出、MCP dist、Story Profile 快照。除明确受版本控制的快照外，不提交生成物。
- 私人数据：安装根目录、Key、日志、会话、备份均不属于仓库源码；`local-state/` 只保留说明文件。

上游授权文件和第三方声明保持原处。这次目录整理不替代项目顶层许可证选择，也不改变第三方授权。
