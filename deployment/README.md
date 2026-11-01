# 安装与更新职责

| 目录 | 负责 | 不负责 |
| --- | --- | --- |
| `install/` | 新实例初始化、安装位置、重试清理 | 世界业务和 UI |
| `update/` | 版本检查、系统事务、独立酒馆更新与恢复 | 首次模型输入界面 |
| `uninstall/` | 数据保留选择、停止服务、安全删除、NSIS 接入 | 清理其他实例 |
| `shared/` | 模型与 Nora 配置、实例校验、进程锁、Liveware、上下文 | 第二套 World 数据模型 |
| `runtime/` | 实例命令、服务启动、版本定时检查 | 构建平台安装包 |

## 更新对象

- `update/system-update.js`：识别和安全恢复受支持的旧 JS 系统更新事务。
- `update/releases.js`：发布渠道、版本和本平台清单校验。
- `update/update.py` 与 `update/recovery.py`：执行当前完整系统更新，以及适用的独立 Tavern 更新、旧数据迁移与恢复。完整系统路径由 `launcher/desktop/system-update-executor.js` 经 `launcher/bridge.py` 和 `update/bootstrap.py` 调用，绑定托管实例并恢复更新前服务状态；独立更新入口拒绝覆盖托管完整系统。
- 桌面程序升级：替换平台启动器应用，保留系统安装根目录，不由上述事务自替换。

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

独立酒馆更新和整套系统更新在事务范围上不同，但共享适用的实例、配置和内容管控实现。不要把一个修复分别复制进两条流程。
