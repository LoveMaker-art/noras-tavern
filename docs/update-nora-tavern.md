# 更新 Nora Tavern

这份文档只用于已经完成首次安装的 Nora Tavern。

如果你还没有安装，请先看 [安装 Nora + Tavern](install-nora-tavern.md)。

## updater 是做什么的

updater 只负责更新已经安装好的 Nora Tavern。

用户始终使用同一条更新命令。updater 会自动选择：

- Python 1.x 安装：下载完整 2.x 程序并迁移数据。
- 已安装的 2.x：按文件哈希只下载发生变化的模块。
- 无法可靠复用的安装：自动使用完整发布包修复程序，用户数据仍保留。

2.x 更新中，依赖锁文件没有改变时会复用已安装依赖，不会重复执行 `npm ci`。
只更新 MCP、技能或运维文件时，Tavern 不停服。

它会更新：

- Tavern 本体
- Story Profile 运行快照
- Nora MCP
- Tavern 相关 Hermes skills
- `AGENTS.md` 中的 Tavern 托管块
- Nora MCP 配置

它不负责：

- 安装 Hermes
- 首次初始化 Nora
- 强制覆盖 `SOUL.md`
- 重新配置模型或 API Key

首次安装和后续更新是两条不同流程：

| 场景 | 使用 |
| --- | --- |
| 空白 Hermes 环境第一次安装 Nora Tavern | `install-nora-tavern` |
| 已经安装 Nora Tavern 后升级版本 | `install-tavern-updater` |

## 更新前

更新前请确认：

- Hermes 已经安装。
- Nora Tavern 已经完成首次安装。
- Tavern 中没有正在生成的对话。
- 你没有手动删除 `$HERMES_HOME/apps/tavern-runtime`、`$HERMES_HOME/apps/nora-mcp`、`$HERMES_HOME/apps/tavern-ops`。

默认 Hermes home 通常是：

```text
~/.hermes
```

## 执行更新

macOS 用户，在终端中执行：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

如果你的 Hermes home 不是默认位置：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm --hermes-home /path/to/hermes-home
```

更新器会在更新前创建备份。备份通常位于：

```text
$HERMES_HOME/tavern-backups/
```

更新成功后，终端会输出结构化结果。重点看：

```text
"status": "installed"
```

如果结果中出现 `partial`，通常表示程序已经安装成功，但部分旧数据需要后续人工处理。

## 更新后

更新完成后，请重启 Hermes 会话。

如果你在终端中使用 Hermes：

1. 退出当前 Hermes。
2. 重新启动：

```sh
hermes --tui
```

或者：

```sh
hermes
```

然后发送：

```text
Nora，请检查 Nora Tavern 是否已经更新成功。
```

## 失败时

如果更新失败，请先不要手动删除安装目录。

请保留：

- 终端完整输出
- `$HERMES_HOME/tavern-backups/`
- `$HERMES_HOME/config.yaml`
- `$HERMES_HOME/AGENTS.md`

如果新版 Tavern 无法启动，updater 会尝试恢复更新前的备份，并在终端输出中报告恢复结果。

## Windows 用户

当前首次安装器已经提供 Windows PowerShell 入口。

后续 updater 目前以 macOS 的 shell 入口为主。Windows 用户如果需要更新，建议先等待 Windows updater 入口发布。
