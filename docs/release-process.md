# Linux 核心构建与交付

当前使用场景是 **Linux 云服务器部署，用户通过 ClawChat 使用**。Hermes 由既有实例提供，本仓维护 Nora、Tavern、MCP、核心部署维护和发布工具。桌面启动器、Windows、macOS 以及三平台原生构建不属于当前发布范围。

## 构建与验收原则

1. 固定干净源码提交、组件版本和共享维护输入，核对产品设计与数据边界。
2. 通用业务、源码投影、制品清单和摘要在固定参考环境验证；进程、安装、更新和恢复以 Linux 实际行为为准。
3. 普通核心发布只生成通用核心 archives/modules，不读取 Hermes 三平台运行时锁，不生成 `core-payload` 或平台 `nora-system` 元数据。
4. 记录通过、失败、跳过和未验收；候选包、本地测试和真实云端用户验收是不同证据。
5. 只发布验收过的同一批文件。推送、创建标签、上传和渠道切换需要明确授权。

打包器只负责构建，manifest 明确记录 `packaging-only`，不把构建成功写成测试通过。

## 当前工作流

### `core-ci.yml`

推送、PR 或手动触发后，只在 **Ubuntu 24.04** 执行 `core-source-gate.mjs`：备份安全、固定输入、源码投影、发行合同、核心 JS/Python 消费者、MCP、Story Profile 和 Tavern 工作流。

它只提供源码与消费者证据，不构建 APP，不运行 Windows/macOS 任务，也不自动发布。

### `core-build.yml`

手动触发后，只在 **Ubuntu 24.04** 执行同一源码门禁，再由 `build-core-components.mjs` 构造轻量核心组件，校验固定输入并复制存量客户端兼容资产，生成 `core-accepted-batch`。

该流程没有 `native` 选项，不执行三平台原生构建。构建产物保留 30 天；超期需要重新构建验收。

### `core-publish.yml`

发布仍只消费成功 build run 中的 `core-accepted-batch`，不重新构建。发布前验证：

- 组件提交、版本、标签和文件摘要；
- 最终密封目录中的 Linux 核心更新选择；
- 存量客户端兼容选择器及固定兼容资产；
- GitHub 与极狐的不可变对象和渠道身份。

验证不声称完成 Windows/macOS 或完整原生安装验收。

## 发布与重试

1. 审查本次版本和兼容声明，完成适用测试，提交干净源码并获得推送与标签授权。核心标签必须与 `app/.tavern-release-version` 一致。
2. 在 GitHub 准备 `JIHULAB_PRIVATE_TOKEN` 和带必要审阅人的 `core-release` 环境。
3. 授权后运行 `core-build.yml`，确认 Ubuntu 构建成功并保留其 run ID。
4. 手动运行 `core-publish.yml`，输入同一提交的 build run ID、远端标签和已审阅发行说明。所有不可变对象验证成功后才切换核心 stable/beta 渠道，不写桌面启动器渠道。
5. 失败时保留原 build run，下载 `core-publication-checkpoint` 和日志。恢复必须绑定同一源码、构建 run、目标、摘要和原目录字节；上传结果未知时先核对远端，不盲目重传。

本地 `publish-release.mjs` 默认 `--stage seal`，只生成计划并校验消费者；`prepare`、`promote` 和 `all` 的远端写入均须明确授权。凭据只来自临时 0600 文件，不进入包、回执或 checkpoint。

## 存量客户端交付兼容

保留 `tooling/release/legacy-app-input.lock.json` 固定的既有客户端描述符和轻量更新 ZIP，是为了避免既有消费者因核心渠道变化而失去更新入口。

这些资产按原字节托管并核验，**不代表当前产品重新承担 Windows/macOS 或桌面启动器开发，也不需要三平台构建**。本仓不重建 APP、不修改其版本、不把旧 APP 与新核心伪装成同一提交。

写入前及渠道切换前，发布器只读检查 APP 独立渠道和 GitHub 发行目录；发现更新版本时停止并重新审查固定输入。核心与 APP 在同一分发站点的发布保持串行，核心不修改 `launcher-stable`。
