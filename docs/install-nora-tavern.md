# 安装 Nora + Tavern

这是 Nora Tavern 的完全版安装方式。

完全版会把 Nora Tavern 安装到一个独立的本地目录中。安装完成后，你会得到：

- Nora Tavern：诺拉酒馆本体
- Nora：帮你管理酒馆、可以互动的诺拉

如果你只想单独运行 Tavern，不需要 Hermes Agent 管理能力，请看 [安装 Tavern](install-tavern.md)。

## 温馨提醒

Nora Tavern 完全版是本地部署方案。

Hermes、Nora Tavern 和 Nora MCP 都运行在你的电脑上。电脑关机、休眠、断网，或者 Hermes / Tavern 程序退出后，ClawChat 可能无法继续联系 Nora，Tavern 和 Story Profile 入口也可能无法打开。

这不是 24 小时在线的云服务。如果你希望 Nora 和 Tavern 长期可用，请保持运行 Hermes 的电脑开机、联网，并让 Hermes 和 Tavern 服务保持运行。

如果 ClawChat 暂时联系不上 Nora，或 Tavern 入口打不开，请先检查：

- 电脑是否开机并联网
- Hermes 是否仍在运行
- Tavern 是否仍在运行
- 是否刚刚重启或切换网络

## 安装路径

完整流程是：

```text
1. 下载 Nora Tavern Launcher
2. 一键安装 Nora + Tavern
3. 配置第一个模型，并确认 Hermes 可以正常对话
4. 接入 ClawChat
5. 重启 Hermes
6. 第一次让 Nora 检查酒馆
```

首次安装推荐使用 `nora-tavern-launcher.zip` 整合包。后续更新再使用 updater。

## 第一步：下载 Nora Tavern Launcher

下载 Nora Tavern Launcher 整合包：

[下载 nora-tavern-launcher.zip](https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/nora-tavern-launcher.zip)

这个整合包已经放好 Nora Tavern 本体、Nora MCP、Hermes skills、`AGENTS.md` 托管说明和 Nora 初始化模板。它会自动检查并安装 Hermes，但不会包含你的模型 API Key、ClawChat 登录态或配对信息。

首次安装器会把 Nora Tavern 放在一个隔离目录里，不会散落安装到用户主目录。

默认安装目录：

Windows：

```text
%LOCALAPPDATA%\NoraTavern
```

macOS：

```text
~/Library/NoraTavern
```

目录结构：

```text
Nora Tavern/
  hermes/   Hermes、Nora skills、AGENTS.md、SOUL.md、MCP 配置
  tavern/   Tavern 本体、Nora MCP、本地数据、日志、更新缓存
```

## 第二步：一键安装 Nora + Tavern

### Windows

如果你的电脑是 Windows：

1. 解压 `nora-tavern-launcher.zip`。
2. 打开解压后的 `nora-tavern-launcher` 文件夹。
3. 双击 `Install-Nora-Tavern.cmd`。

如果你要换安装目录，打开 PowerShell，进入解压后的文件夹，执行：

```powershell
.\Install-Nora-Tavern.ps1 --nora-home "D:\Nora Tavern"
```

### macOS

如果你的电脑是 macOS：

1. 解压 `nora-tavern-launcher.zip`。
2. 打开解压后的 `nora-tavern-launcher` 文件夹。
3. 双击 `Install-Nora-Tavern.command`。

如果系统拦截脚本，打开终端，进入解压后的文件夹，执行：

```sh
sh ./Install-Nora-Tavern.command
```

如果你要换安装目录：

```sh
sh ./Install-Nora-Tavern.command --nora-home "/Users/你的用户名/Nora Tavern"
```

安装器会完成：

- 检查 Hermes，没有 Hermes 时调用 Hermes 官方安装器
- 校验整合包中的 Nora Tavern 发布文件
- 安装 Hermes 到隔离目录的 `hermes/`
- 安装 Tavern 本体、Nora MCP 和运维文件到隔离目录的 `tavern/`
- 写入 Nora MCP 配置、Hermes skills、`AGENTS.md` 和 `SOUL.md`
- 准备并启动本地 Tavern
- 注册 Tavern 和 Story Profile 的 Liveware 入口
- 安装每日更新提醒任务

安装成功后，终端会输出一段 JSON。重点看：

```text
"status": "installed"
"runtime": {
  "health": true
}
```

如果 `runtime.health` 不是 `true`，说明 Tavern 本地服务没有正常启动。

如果 `liveware.status` 是 `updated`，说明 Tavern 和 Story Profile 入口已经注册或刷新成功。

## 第三步：配置模型并完成第一次对话

Hermes 已经安装在 Nora Tavern 的隔离目录里。接下来配置第一个可用模型。

Windows 打开 PowerShell，执行：

```powershell
$env:NORA_TAVERN_HOME = "$env:LOCALAPPDATA\NoraTavern"
$env:HERMES_HOME = "$env:NORA_TAVERN_HOME\hermes"
$Hermes = "$env:HERMES_HOME\bin\hermes.exe"
if (-not (Test-Path $Hermes)) { $Hermes = "$env:HERMES_HOME\bin\hermes.cmd" }
& $Hermes model
```

macOS 打开终端，执行：

```sh
export NORA_TAVERN_HOME="$HOME/Library/NoraTavern"
export HERMES_HOME="$NORA_TAVERN_HOME/hermes"
if [ -x "$HERMES_HOME/.local/bin/hermes" ]; then
  "$HERMES_HOME/.local/bin/hermes" model
else
  "$HERMES_HOME/hermes-agent/venv/bin/hermes" model
fi
```

按照终端提示选择模型供应商和模型。如果提示输入 API Key，请粘贴对应模型供应商的 API Key。

配置完成后，启动 Hermes 并发送一句测试消息：

Windows：

```powershell
& $Hermes --tui
```

macOS：

```sh
if [ -x "$HERMES_HOME/.local/bin/hermes" ]; then
  "$HERMES_HOME/.local/bin/hermes" --tui
else
  "$HERMES_HOME/hermes-agent/venv/bin/hermes" --tui
fi
```

测试消息：

```text
你好，请用一句话回复我。
```

如果 Hermes 能正常回复，说明模型配置成功。

## 第四步：接入 ClawChat

ClawChat 是你在手机上和 Nora 对话、打开酒馆入口的地方。Nora Tavern 本体仍然运行在你的电脑上。

ClawChat 官方文档：

- [Download and install ClawChat](https://clawling.com/chat/docs/install/)
- [Connect your own Agent](https://clawling.com/chat/docs/connect-your-agent/)

先安装 ClawChat：

- macOS：从 ClawChat 官网下载 DMG。
- Windows：从 ClawChat 官网下载 EXE 安装器。

安装并登录后，在 ClawChat 中操作：

```text
Contacts -> Register Agent -> 选择 Hermes -> 复制激活命令
```

回到运行 Hermes 的电脑，在终端中粘贴并执行 ClawChat 给你的激活命令。

注意：激活命令以 ClawChat App 里显示的为准，不要从别人文档里复制旧命令。Pairing code 是一次性的，过期或用过后需要重新生成。

成功标准：ClawChat 里收到 Hermes Agent 主动发来的 greeting 消息。

## 安装器处理了哪些文件

首次安装器会处理这些 Hermes 侧文件：

```text
<Nora Tavern 安装目录>/hermes/AGENTS.md
<Nora Tavern 安装目录>/hermes/config.yaml
<Nora Tavern 安装目录>/hermes/skills/
<Nora Tavern 安装目录>/hermes/SOUL.md
```

它们分别负责：

| 文件或目录 | 作用 |
| --- | --- |
| `AGENTS.md` | 告诉 Hermes 如何使用 Nora Tavern 的技能和 MCP。 |
| `config.yaml` | 写入 `mcp_servers.nora`，让 Hermes 能连接 Nora MCP。 |
| `skills/` | 安装 Tavern、Tavern Ops、Tavern Updater、Nora CardForge。 |
| `SOUL.md` | Nora 的身份、工作方式和管理边界。 |

`SOUL.md` 默认不会强制覆盖：

- 如果 `SOUL.md` 不存在，安装器会创建 Nora 的 `SOUL.md`。
- 如果 `SOUL.md` 已存在，安装器会保留原文件，并写入 `SOUL.nora-tavern.example.md`。

如果这个 Hermes 环境就是专门给 Nora Tavern 使用，可以选择覆盖 `SOUL.md`。

Windows：

```powershell
.\Install-Nora-Tavern.ps1 --replace-soul
```

macOS：

```sh
sh ./Install-Nora-Tavern.command --replace-soul
```

这个参数需要在第二步首次安装时使用。已经安装完成后，不建议再重复运行首次安装器。

覆盖前，安装器会备份旧的 `SOUL.md`。

## 第五步：重启 Hermes

安装器已经写入 skills、MCP 和 AGENTS 配置，但当前正在运行的 Hermes 会话不一定会立即加载新内容。

请退出当前 Hermes，然后重新启动。

Windows：

```powershell
& $Hermes --tui
```

macOS：

```sh
if [ -x "$HERMES_HOME/.local/bin/hermes" ]; then
  "$HERMES_HOME/.local/bin/hermes" --tui
else
  "$HERMES_HOME/hermes-agent/venv/bin/hermes" --tui
fi
```

如果你主要通过 ClawChat 使用 Hermes，请重启运行 Hermes 的本地进程。重启完成后，ClawChat 中应该能重新看到 Agent 在线。

## 第六步：第一次让 Nora 开口

重新进入 Hermes 或打开 ClawChat 后，发送：

```text
Nora，请检查 Nora Tavern 是否已经启动，读取当前酒馆状态，并告诉我现在可以做什么。
```

正常情况下，Nora 应该能够：

- 识别 Nora Tavern 已安装
- 通过 Nora MCP 读取酒馆状态
- 告诉你是否已有 World、角色或会话
- 引导你创建或导入第一个 World

Tavern 默认本地地址是：

```text
http://127.0.0.1:8799/
```

Story Profile 默认本地地址是：

```text
http://127.0.0.1:8799/_liveware/story-profile
```

如果 Nora 说找不到 Tavern 或 Nora MCP，请先运行：

Windows：

```powershell
& $Hermes doctor
```

macOS：

```sh
if [ -x "$HERMES_HOME/.local/bin/hermes" ]; then
  "$HERMES_HOME/.local/bin/hermes" doctor
else
  "$HERMES_HOME/hermes-agent/venv/bin/hermes" doctor
fi
```

然后检查首次安装器最后输出中的 `runtime.health` 是否为 `true`。

## 后续更新

首次安装完成后，以后更新 Nora Tavern 推荐打开 Nora Tavern Launcher，点击 **更新**。

macOS 如果要用命令行更新，请显式指定隔离目录：

macOS：

```sh
export NORA_TAVERN_HOME="$HOME/Library/NoraTavern"
export HERMES_HOME="$NORA_TAVERN_HOME/hermes"
export TAVERN_DATA_ROOT="$NORA_TAVERN_HOME/tavern"
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --hermes-home "$HERMES_HOME" --install-root "$TAVERN_DATA_ROOT" --apply --confirm
```

更新说明见 [更新 Nora Tavern](update-nora-tavern.md)。

## 常见问题

### 这会安装 Hermes 吗？

会。启动器会调用 Hermes 官方安装器，并把 Hermes 安装到 Nora Tavern 的隔离目录里。

### 这会覆盖我的模型密钥吗？

不会。Nora Tavern 不携带模型密钥，也不会要求你把密钥写入项目仓库。

### 这会覆盖我的 SOUL.md 吗？

默认不会。只有你显式加 `--replace-soul`，才会替换 `SOUL.md`。

### 已经装过 Nora Tavern 还能运行首次安装器吗？

不建议。首次安装器检测到已有安装痕迹会停止。已经安装过请使用 updater。

### updater 和首次安装器有什么区别？

| 命令 | 用途 |
| --- | --- |
| `nora-tavern-launcher.zip` | 首次安装 Hermes 与 Nora Tavern，并注册 Nora Tavern 本地入口。 |
| `install-tavern-updater.sh` | 已安装 Nora Tavern 后更新版本。 |
