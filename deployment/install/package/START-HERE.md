# 诺拉·酒馆

普通用户请从[项目首页的下载区](https://github.com/LoveMaker-art/noras-tavern#下载安装包)选择对应系统的桌面启动器，渠道和安装包以该入口及对应发布的实际附件为准：

- macOS：选择 Apple 芯片（arm64）或 Intel（x64），打开“诺拉·酒馆.app”。
- Windows：普通安装使用 x64 安装包（setup.exe），双击后按向导操作。

便携包是否提供，以对应发布的实际附件为准；Windows 便携版不支持启动器自动替换。需要更换启动器时，按[更新指南](https://github.com/LoveMaker-art/noras-tavern/blob/main/docs/update-nora-tavern.md)保留原安装目录和数据，使用适用的安装版。

启动后点击安装。启动器按配置的正式渠道检查最新稳定版完整系统清单，
下载并校验所需组件，在独立目录安装 Hermes、酒馆及 Nora 配置。
随后按界面提示配置模型、连接 ClawChat，完成启动检查。

安装后，启动器可检查自身和诺拉／酒馆核心版本；启动器只更新自身 APP，核心更新由用户在诺拉对话中授权。首次安装仍部署完整系统，覆盖更换 APP 不会自动升级已有核心。

默认目录：macOS 为 `~/Library/NoraTavern`，Windows 为
`%LOCALAPPDATA%\NoraTavern`。密钥与配对信息仅在本机配置，不包含在公开包中。

本目录的 Install 脚本只负责打开同目录内的桌面启动器，不再运行另一套安装流程。
仅有源码、payload 和脚本的归档不是可双击安装的桌面成品。

电脑关机或休眠后，本地 Nora、酒馆和手机连接会停止。首次安装与手机连接需要联网。
