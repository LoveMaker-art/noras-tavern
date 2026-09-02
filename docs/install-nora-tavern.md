# 安装 Nora + Tavern

这是 Nora Tavern 的完全版安装方式。

完全版会把 Nora Tavern 安装到本地 Hermes 环境中。安装完成后，你会得到：

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
1. 安装 Hermes
2. 配置模型，并确认 Hermes 可以正常对话
3. 接入 ClawChat
4. 安装 Nora Tavern 到本地 Hermes
5. 确认 Nora 初始化文件
6. 重启 Hermes
7. 第一次让 Nora 检查酒馆
```

首次安装请使用 `install-nora-tavern`。后续更新再使用 updater。

## 第一步：打开终端并安装 Hermes

Nora Tavern 依赖 Hermes Agent 运行。请先安装 Hermes。

Hermes 官方文档：

- [Hermes Installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- [Hermes Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)

### Windows

打开终端：

1. 点击 Windows 开始菜单。
2. 搜索 **PowerShell**。
3. 打开 **Windows PowerShell** 或 **Windows Terminal**。

执行 Hermes 官方安装命令：

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

安装完成后，关闭 PowerShell，再重新打开一个新的 PowerShell。

检查 Hermes：

```powershell
hermes doctor
```

### macOS

打开终端：

1. 打开 **访达**。
2. 进入 **应用程序**。
3. 进入 **实用工具**。
4. 打开 **终端**。

执行 Hermes 官方安装命令：

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

重新加载 shell：

```sh
source ~/.zshrc
```

检查 Hermes：

```sh
hermes doctor
```

## 第二步：配置模型并完成第一次对话

Hermes 安装完成后，先配置一个可用模型。

```sh
hermes model
```

按照终端提示选择模型供应商和模型。

如果提示输入 API Key，请粘贴对应模型供应商的 API Key。

配置完成后，启动 Hermes：

```sh
hermes --tui
```

或者：

```sh
hermes
```

发送一句测试消息：

```text
你好，请用一句话回复我。
```

如果 Hermes 能正常回复，说明模型配置成功，可以继续下一步。

## 第三步：接入 ClawChat

ClawChat 是你和 Hermes Agent 对话的入口。Nora Tavern 本体仍然安装在运行 Hermes 的本地机器上。

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

回到运行 Hermes 的那台机器，在终端中粘贴并执行 ClawChat 给你的激活命令。

注意：激活命令以 ClawChat App 里显示的为准，不要从别人文档里复制旧命令。Pairing code 是一次性的，过期或用过后需要重新生成。

执行完成后，重启 Hermes：

```sh
hermes --tui
```

或者：

```sh
hermes
```

成功标准：ClawChat 里收到 Hermes Agent 主动发来的 greeting 消息。只看到终端显示激活完成还不够，必须以 ClawChat 里真的收到消息为准。

确认 ClawChat 能和 Hermes 对话后，再继续安装 Nora Tavern。

## 第四步：安装 Nora Tavern 并注册入口

确认 ClawChat 已经能和 Hermes 对话后，回到运行 Hermes 的那台电脑，打开终端，直接执行 Nora Tavern 首次安装命令。

首次安装器会把 Nora Tavern 安装到 Hermes home。默认 Hermes home 通常是：

```text
~/.hermes
```

### Windows

如果运行 Hermes 的电脑是 Windows，在 PowerShell 中执行：

```powershell
$installer = Join-Path $env:TEMP "install-nora-tavern.ps1"
iwr https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer --apply --confirm
```

如果你的 Hermes home 不是默认位置：

```powershell
$installer = Join-Path $env:TEMP "install-nora-tavern.ps1"
iwr https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer --apply --confirm --hermes-home C:\path\to\hermes-home
```

### macOS

如果运行 Hermes 的电脑是 macOS，在终端中执行：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.sh | sh -s -- --apply --confirm
```

如果你的 Hermes home 不是默认位置：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.sh | sh -s -- --apply --confirm --hermes-home /path/to/hermes-home
```

安装器会完成：

- 下载 Nora Tavern 最新正式发布包
- 安装 Tavern 本体到 `$HERMES_HOME/apps/tavern-runtime`
- 安装 Nora MCP 到 `$HERMES_HOME/apps/nora-mcp`
- 安装运维文件到 `$HERMES_HOME/apps/tavern-ops`
- 安装 Hermes skills
- 写入 Nora MCP 配置
- 合并 Tavern 的 `AGENTS.md` 托管块
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

## 第五步：确认 Nora 初始化文件

首次安装器会处理这些 Hermes 侧文件：

```text
$HERMES_HOME/AGENTS.md
$HERMES_HOME/config.yaml
$HERMES_HOME/skills/
$HERMES_HOME/SOUL.md
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
$installer = Join-Path $env:TEMP "install-nora-tavern.ps1"
iwr https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer --apply --confirm --replace-soul
```

macOS：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-nora-tavern.sh | sh -s -- --apply --confirm --replace-soul
```

覆盖前，安装器会备份旧的 `SOUL.md`。

## 第六步：重启 Hermes

安装器已经写入 skills、MCP 和 AGENTS 配置，但当前正在运行的 Hermes 会话不一定会立即加载新内容。

请退出当前 Hermes，然后重新启动：

```sh
hermes --tui
```

或者：

```sh
hermes
```

如果你主要通过 ClawChat 使用 Hermes，请重启运行 Hermes 的本地进程。重启完成后，ClawChat 中应该能重新看到 Agent 在线。

## 第七步：第一次让 Nora 开口

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

```sh
hermes doctor
```

然后检查首次安装器最后输出中的 `runtime.health` 是否为 `true`。

## 后续更新

首次安装完成后，以后更新 Nora Tavern 使用 updater：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

更新说明见 [更新 Nora Tavern](update-nora-tavern.md)。

## 常见问题

### 这会安装 Hermes 吗？

不会。请先按 Hermes 官方文档安装 Hermes。

### 这会覆盖我的模型密钥吗？

不会。Nora Tavern 不携带模型密钥，也不会要求你把密钥写入项目仓库。

### 这会覆盖我的 SOUL.md 吗？

默认不会。只有你显式加 `--replace-soul`，才会替换 `SOUL.md`。

### 已经装过 Nora Tavern 还能运行首次安装器吗？

不建议。首次安装器检测到已有安装痕迹会停止。已经安装过请使用 updater。

### updater 和首次安装器有什么区别？

| 命令 | 用途 |
| --- | --- |
| `install-nora-tavern.sh` / `install-nora-tavern.ps1` | 空白 Hermes 环境首次安装 Nora Tavern。 |
| `install-tavern-updater.sh` | 已安装 Nora Tavern 后更新版本。 |
