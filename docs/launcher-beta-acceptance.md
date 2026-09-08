# Beta 启动器验收记录

日期：2026-09-08。测试分支：`codex/launcher-beta`。
已同步主线 `v2.2.9` 的世界书修复；没有将测试分支合入主线。

## 已发布

- [v2.2.10-beta.1](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.2.10-beta.1)
- [v2.2.10-beta.2](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.2.10-beta.2)

两者均为 Pre-release，每个版本包含 Mac Apple 芯片、Mac Intel、Windows x64 启动器及完整系统组件。
正式版本查询仍返回 `v2.2.9`，Beta 不替代正式发布。

## 技术验收

| 验收项目 | 结果与边界 |
| --- | --- |
| 三平台完整构建 | 两个 Beta 的三平台工作流全部通过 |
| 运行时独立性 | 移走原 Hermes 构建目录后，从压缩包恢复并运行成功 |
| 完整初始化 | CI 实际检查 SOUL、AGENTS、技能、Hook、ClawChat 注册、定时任务执行与 MCP 实例读取 |
| 酒馆运行 | CI 空目录安装后，实际 HTTP 访问成功；测试结束停止测试实例 |
| 下载包完整性 | 本机两个 Mac arm64 ZIP 的 SHA-256 均与 GitHub 资产 digest 一致 |
| 本机首次安装 | 使用下载的 beta.1 应用，通过真实 IPC 安装，返回 `systemReady=true` |
| 重开应用 | 实际窗口恢复到模型配置；Nora 和酒馆两步已完成，不重复显示初次安装 |
| 真实在线升级 | 使用旧 beta.1 应用发现并升级到 beta.2，随后版本检查返回 `current` |
| 更新数据保留 | `.env` 测试配置、自定义 SOUL、Hermes 会话测试文件、酒馆数据测试文件的哈希更新前后完全一致 |
| 用户参与门槛 | 未配置模型或配对时始终为 `setupCompleted=false`，没有假报全部完成 |
| 更新异常处理 | 本地事务测试覆盖替换/验证失败、进程中断、恢复及停止失败；不等同于下载整包的故障注入验收 |

首次安装记录：北京时间 13:00。在线升级记录：北京时间 13:13。
上述本机安装和升级使用真实后台 IPC，不是全程鼠标点击验收，也未使用真实模型 Key。

## 本轮修复的跨平台问题

- Windows 原 PowerShell 解压十分钟仍未完成；改用原生 tar 后，同类 CI 解压约 23–40 秒。
- 重建 Windows venv 启动入口，消除 uv 对构建机 Python 路径的依赖。
- Windows 架构识别不再依赖隔离环境中可能缺失的处理器环境变量。
- 修正 Mac Python 重执行和 Windows Python 父子进程的身份检查。
- 统一 UTF-8 与源文件换行，修正 Windows 构建命令和离线组件检查。

## 仍需人工验收

真实模型配置与对话、实际 ClawChat 配对后的头像昵称、手机 Liveware 游玩，以及真实账号配置下的升级。
资料同步目前通过官方客户端连接本地 HTTP 测试服务验证，没有修改真实 ClawChat 联系人。
Mac Intel 和 Windows 已通过 CI 安装检查，尚未完成普通用户机器上的完整界面验收。
测试包没有正式代码签名和 Apple 公证，不宣称所有系统版本都能无提示打开。

构建记录：[beta.1](https://github.com/LoveMaker-art/noras-tavern/actions/runs/34187850296)、[beta.2](https://github.com/LoveMaker-art/noras-tavern/actions/runs/34188707916)。
