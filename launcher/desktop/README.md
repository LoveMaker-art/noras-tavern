# Nora Tavern Desktop Shell

Electron 主进程和 preload 源码在这里。正式 UI 位于 `launcher/ui/index.html`，安装、更新、卸载模块归属 `deployment/`。

本目录 `package.json` 的构建路径描述**生成后的交付目录**。不要在源码目录直接运行 `npm start` 或 `pack:*`；开发命令通过根目录的 `tooling/run.mjs`，打包在发布候选目录中执行。

详见 [开发与发布说明](../../CONTRIBUTING.md) 和 [启动器职责](../README.md)。

## 产品流程

1. 读取安装位置、组件版本和实际服务状态，区分首次安装与日常启动。
2. 首次安装校验完整平台发布包，安装配套 Hermes、Nora 内容及 Tavern。
3. 验证用户模型配置。首次设置通过已有 Tavern 模型配置接口同步初始选择，不另写一套模型业务；后续模型保持各自配置边界。
4. 激活 ClawChat，完成 Liveware 注册和实际就绪检查。
5. 日常界面分别管理 Nora 与 Tavern。关闭窗口不会自动停止服务。
6. 完整系统更新由 `deployment/update/` 管事务；卸载由 `deployment/uninstall/` 管确认、停止和安全删除。

## 发布边界

三种运行时必须在对应平台构建：macOS arm64、macOS x64、Windows x64。发布的图像来自同一份 `launcher/ui/assets/`。Windows 的普通安装入口是 NSIS setup；不能把某平台构建成功当作其他平台通过验收。

源包和候选包不包含真实 Key、会话或开发者安装数据。核心包不包含可选的 Browser Use / Computer Use 组件。未签名或未公证的安装包可能出现系统安全提示。

布局迁移不改变现有本地候选标识、默认数据目录、语言逻辑、开场白或 UI。发布仍需分别完成授权、三平台构建与目标环境验收。
