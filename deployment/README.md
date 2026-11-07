# 安装与更新职责

产品职责以[共同更新与恢复规则](../docs/product/README.md#shared-update)为准：已有安装的核心更新与 APP 自更新分别执行，首次安装完整版仍部署核心及配套环境。

| 目录 | 负责 | 不负责 |
| --- | --- | --- |
| `install/` | 新实例初始化、安装位置、重试清理 | 世界业务和 UI |
| `update/` | 核心版本检查、独立任务、程序更新与历史恢复 | APP 自替换、首次模型输入界面 |
| `uninstall/` | 数据保留选择、停止服务、安全删除、NSIS 接入 | 清理其他实例 |
| `shared/` | 模型与 Nora 配置、实例校验、进程锁、Liveware、上下文 | 第二套 World 数据模型 |
| `runtime/` | 实例命令、服务启动、版本定时检查 | 构建平台安装包 |

## 更新对象

- `update/releases.js`：发布渠道、版本和本平台清单校验。
- 诺拉／酒馆核心：用户在诺拉对话中授权后，技能经 `update/task.py` 提交独立核心任务；`task_backend.py`、`update.py` 与 `recovery.py` 按实例绑定处理准备、程序替换、验收及恢复。桌面与无 APP 部署共用这一入口，不要求启动器安装、打开或代执行。
- `update/bootstrap.py`：官方独立接入入口，取得并校验执行代码后交给同一核心任务；可核验带桌面安装标记的原目录。来源、实例及运行依赖仍须满足对应合同。
- 桌面 APP：由 `launcher/desktop/launcher-update.js` 和 `replace-launcher.py` 替换启动器自身。核心与用户数据保持原状态，APP 交接不提交或续接核心更新。
- 历史兼容：`update/system-update.js`、旧桌面编排及恢复模块继续处理其受支持的存量记录。新任务不再创建联合更新；APP 只恢复已开始的 APP 替换，核心效果由核心执行器处理，历史结果和备份保留。

用户操作见 [更新说明](../docs/update-nora-tavern.md)。

## 内容与用户数据

内容原文来自 [nora](../nora/README.md)，不在本目录再保存一份。

- `shared/managed_context.py` 统一全量 AGENTS 替换；只保留紧邻上一份 `.bak`，失败事务恢复其原状态。
- SOUL 初始化逻辑识别默认内容；已有自定义内容按现有保护策略处理，不把目录整理当成强制恢复出厂。
- 项目受管 greeting 可随版本刷新；自定义 greeting 保留，新模板作为参考文件提供。
- 用户模型、Key、会话、Story Profile 数据与项目运行文件分开；更新保留用户状态，不把旧运行时二进制覆盖回新环境。
- 安装目录隔离不等于操作系统沙箱，不能据此声称 Agent 永远无法访问用户其他文件。

## 执行与兼容

Linux云端及桌面的产品要求统一见[部署平台与实例边界](../docs/product/README.md#deployment-support)。共用技能、模型管理、安装／更新与外部入口状态使用同一实例定位，按实际Hermes、解释器、酒馆／数据及服务控制关系工作，不以操作系统、桌面收据或固定父子目录作为核心资格。非默认路径配置见[实例映射](../docs/install-nora-tavern.md#非默认目录怎么处理)；源码、原生实测、未验范围和发布分别记录于[N-D04](../docs/product/nora.md#differences)及[实施记录](../docs/launcher-reliability-plan.md#cloud-core-instance-20261031)。桌面APP自身及桌面集成环境的三平台构建矩阵继续保留，不能拿它代替核心业务的支持范围。

源码已按职责归类，发布布局维持已有 `ops/` 和 `apps/tavern-ops/` 协议。部署内部相对导入按交付布局解析；开发时通过 `node tooling/run.mjs ...` 执行，不能直接运行被移动的内部模块。

包含诺拉的核心更新与单独酒馆更新按实际安装形态选择范围，共享适用的实例、配置和内容管控实现。APP 自更新与核心任务分别处理自身结果，并继续遵守同实例的维护互斥。执行机制见[安装、核心更新与启动器自更新](../docs/launcher-unified-update.md)。
