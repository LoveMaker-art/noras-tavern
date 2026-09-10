# 安装 Nora + Tavern

完全版包含诺拉酒馆本体，以及帮你管理酒馆、可以互动的诺拉。只需要酒馆本体，请看 [安装 Tavern](install-tavern.md)。

## 温馨提醒

这是本地部署方案。电脑关机、休眠、断网，或诺拉、酒馆服务停止后，ClawChat 中的对话和应用入口可能无法使用。关闭启动器窗口后，服务可以继续运行；退出前请按需要停止服务。

## 第一步：下载并打开启动器

前往 [GitHub 最新正式版本](https://github.com/LoveMaker-art/noras-tavern/releases/latest)，在 Assets 中下载对应安装包：

| 电脑 | 安装包文件名 |
| --- | --- |
| Mac Apple 芯片 | `Nora-Tavern-Launcher-*-mac-arm64.dmg` |
| Mac Intel | `Nora-Tavern-Launcher-*-mac-x64.dmg` |
| Windows 64 位 x64 | `Nora-Tavern-Launcher-*-win-x64-setup.exe` |

Mac 可在苹果菜单的“关于本机”中查看芯片类型。Windows ARM 暂不作为原生支持平台。

- **Mac**：打开 DMG，将“诺拉·酒馆”拖入“应用程序”，再从“应用程序”打开。
- **Windows**：双击安装程序，按照提示完成安装并打开“诺拉·酒馆”。

当前安装包未经 Apple 公证或 Windows 发行商代码签名，系统可能提示安全警告。请只从本仓库下载，核对发布页的校验信息，不要关闭系统整体安全保护。

## 第二步：安装诺拉与酒馆

在启动器中确认安装目录，点击安装。默认目录：

- Windows：`%LOCALAPPDATA%\NoraTavern`
- macOS：`~/Library/NoraTavern`

需要换位置时，在首次安装界面选择目录。Hermes 和酒馆会放在同一个专属目录中：

```text
NoraTavern/
  hermes/   Hermes、诺拉配置、技能和模型凭据
  tavern/   酒馆本体、Nora MCP、酒馆数据
```

启动器会检查最新正式版本，校验并使用匹配的内置组件，必要时下载新组件。Hermes、Python、Node.js 和核心依赖已随整合包提供，不需要先手动安装 Hermes。

诺拉与酒馆文件安装完成后，界面自动进入模型配置。等待期间无需反复点击安装。

## 第三步：配置模型

1. 选择模型服务。使用中转服务时，选择自定义并填写对应的 API 地址。
2. 填入该服务提供的 API Key。
3. 选择或填写模型名称。
4. 点击“连接并继续”，等待模型验证成功。

模型不可用时，核对供应商、API 地址、Key 和模型名称后重试。配置会写入本次安装的 Hermes，并用于初始化酒馆模型。密钥不包含在安装包中；调用模型时会发送给你选择的服务。

## 第四步：连接 ClawChat

1. [下载 ClawChat](https://clawling.com/zh/chat/#get)，安装并登录。
2. 按照 [获取配对码指引](https://clawling.com/zh/chat/docs/connect-code/) 注册 Hermes Agent，获取配对码。
3. 回到诺拉启动器，粘贴配对码，点击“连接并继续”。
4. 等待启动检查完成。

启动器会处理插件激活和本次实例的 Liveware 注册，不需要另行复制激活命令。配对码过期或已经使用时，请重新获取。

## 第五步：开始使用

- 点击启动器中的“打开酒馆”，在本机进入酒馆。
- 在 ClawChat 联系人中找到诺拉，发送“你好”开始对话。
- ClawChat 中的酒馆入口由后台核验后发送；开场白与入口卡片不保证先后顺序。
- 平时可在诺拉聊天页面右上角的应用菜单中打开 Tavern 或 Story Profile。Story Profile 记录你的喜好，也能修改诺拉的人设。

酒馆内的新手引导与 ClawChat 开场白是两套独立内容。新手引导只在空白实例中初始化，不覆盖已有世界或聊天。

## 配置与更新

启动器管理本次安装目录内的 SOUL、AGENTS、技能、MCP、Hook 和更新提醒任务，不使用另一套独立 Hermes 的配置目录。

`AGENTS.md` 由项目整份管理：首次安装和更新替换全文，不保留旧文件中的附加规则。内容变化时，`AGENTS.md.bak` 只保留上一份；失败时恢复原文件和原备份。该规则不代表整份覆盖其他配置、记忆或用户数据。

项目管理的 ClawChat 开场白随更新刷新；用户自定义的开场白保留，项目示例写入 `clawchat/greeting.nora-example.md`。专属环境的默认 Hermes 人格会初始化为诺拉，自定义人格不因重试而被随意覆盖。

日常使用直接打开启动器，不必重新安装。通过“查看版本”检查更新；诺拉和酒馆可以分别启动、停止。卸载请使用启动器提供的卸载流程，并确认是否保留数据。

更多说明：[更新 Nora Tavern](update-nora-tavern.md)、[安装目录](launcher-install-location.md)、[卸载说明](launcher-uninstall.md)。
