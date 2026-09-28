# 启动器与公共业务实现边界

同一业务只保留一份实现。启动器负责交互、传参和任务编排，不复制酒馆的注册、配置和运行逻辑。

## 实现归属

| 业务 | 唯一实现 | 启动器接入方式 |
| --- | --- | --- |
| 酒馆安装、启动、停止和状态检查 | `app/native_lifecycle.py` | 传入实例目录和端口 |
| Liveware 身份、隧道、入口注册和重试 | `deployment/shared/liveware_integration.py` | 调用公共启动钩子 |
| 经过校验的入口卡片通知与去重 | `deployment/shared/liveware_notice.py` | 由公共注册流程调用 |
| ClawChat 开场白补丁 | `deployment/shared/clawchat_greeting_patch.py` 及同目录 `.patch` | 构建时预应用，安装时校验 |
| Nora MCP 配置生成 | `deployment/update/update.py::render_mcp` | 首装调用同一函数，显式传入端口 |
| 酒馆模型凭据及设置写入 | `app/native_model_config.py::NativeSettingsClient.configure` | 首次配置策略先判断是否允许同步，再调用公共写入函数 |
| 本地文件锁 | `deployment/shared/runtime_lock.py` | 安装、注册和服务停止使用同一跨平台锁实现 |
| AGENTS 与问候文件策略 | `deployment/shared/managed_context.py` | 首装、更新共用 |

Hermes 网关的进程管理属于 `deployment/shared/services.py`，不是酒馆进程管理的第二套实现。
完整系统更新负责协调 Hermes 与 Tavern 的备份、安装和回滚，不代替 Tavern 单体更新器的内部业务。

## 两种安装上下文

- 普通 Hermes：公共脚本保留 `HERMES_HOME` / `TAVERN_DATA_ROOT` 和原有默认目录。
- 启动器专属 Nora：显式传入隔离的 Hermes、Tavern 目录和端口。
- 两条流程共用完整 AGENTS 替换，只保留一份前版备份；不再维护受管片段模式。SOUL、自定义问候和用户数据另按各自策略处理。
- 已配置过的酒馆模型不随日后 Hermes 模型修改而被覆盖。读回校验、凭据写入和失败回滚共用同一函数。

## 启动顺序与状态

1. 启动本地酒馆，独立检查本地健康状态。
2. 启动 Hermes 网关并确认 ClawChat 连接。
3. 公共注册任务校验当前身份、注册入口、验证入口并发送卡片通知；不等待模型开场白。模型问候独立进行，不再查找或发送卡片地址。

本地服务就绪不等于 ClawChat 入口已注册。入口未就绪时本地酒馆仍可使用；入口 URL 通过公共 `verified_entry` 校验，不能拿历史会话中的旧地址替代。

启动器模式的注册任务不得自行重启酒馆；酒馆停止后退出等待或重试。停止酒馆与注册互斥，停止 Nora 不终止该实例的 Liveware 服务。
普通 Hermes 的启动钩子仍由公共流程先启动本地酒馆，不依赖启动器。

## 构建约束

开场白补丁先应用到受审核的 ClawChat 源码，然后生成运行时文件哈希和补丁版本摘要。
组装整合包时拒绝混用旧运行时和新补丁；用户安装时不需要 Git 来应用预置补丁。
不能只替换启动器 UI 或 Python 脚本后继续复用旧运行时包。

## 历史验证说明

以下记录对应该共享逻辑合入时的验收，不代表后来每次目录迁移都重新完成了三平台真实发布。当前维护入口见 [仓库导航](REPOSITORY.md)。

- 本地自动化覆盖公共注册顺序、独立目录、非默认端口、停止期间取消注册、模型同步、回滚和组件校验。
- 主线补丁已在运行时锁定的 ClawChat 提交 `8651f7078916e60ed1da9f78ec4d1278fef49dd9` 上验证可应用。
- 本轮未构建或发布三个平台的安装包；真实 Hermes 安装验收和 Windows 原生长路径用例仍需在对应运行环境执行。
- 保留现有启动器 UI、诺拉图片、卸载流程及用户数据，本轮不操作 GitHub 发布。

此边界用于减少重复实现和合并分歧，不保证今后修改公共模块时永远不会发生 Git 文本冲突。
