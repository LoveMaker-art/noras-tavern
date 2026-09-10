# 诺拉·酒馆

普通用户请下载 Releases 中对应系统的桌面启动器：

- macOS：选择 Apple 芯片（arm64）或 Intel（x64），打开“诺拉·酒馆.app”。
- Windows：选择 x64 安装包（setup.exe）或便携包（portable.exe）。

启动后点击安装。启动器检查 GitHub 最新正式发布的完整系统清单，
下载并校验所需组件，在独立目录安装 Hermes、酒馆及 Nora 配置。
随后按界面提示配置模型、连接 ClawChat，完成启动检查。

默认目录：macOS 为 `~/Library/NoraTavern`，Windows 为
`%LOCALAPPDATA%\NoraTavern`。密钥与配对信息仅在本机配置，不包含在公开包中。

本目录的 Install 脚本只负责打开同目录内的桌面启动器，不再运行另一套安装流程。
仅有源码、payload 和脚本的归档不是可双击安装的桌面成品。

电脑关机或休眠后，本地 Nora、酒馆和手机连接会停止。首次安装与手机连接需要联网。
