# Nora Tavern Desktop Launcher

这是诺拉酒馆启动器的桌面壳源码。正式版本采用整合包分发：Hermes、Python、Node.js、ClawChat 插件、Liveware、Tavern 和必要依赖随平台安装包交付。首次安装联网确认 GitHub 最新正式版本；匹配的包内组件直接复用，不匹配的组件下载并校验。模型验证、ClawChat 配对和手机入口注册也需要联网。

Chromium、Browser Use、Computer Use 和 ffmpeg 不进入核心整合包，后续作为可选组件安装。模型 Key、会话、缓存和用户配置禁止进入发布包。

## 开发预览

本地桌面候选验收可运行 `node ops/scripts/package-local-launcher.mjs <候选目录>/nora-tavern-launcher`。
它只为当前主机生成带独立 appId 的“诺拉·酒馆测试版”，把候选系统清单的 SHA-256 固定到包元数据。
安装前仍校验全部文件，但不要求先公开发布 GitHub；窗口明确标识本地候选测试，不冒称远端最新版。
测试数据使用 `NoraTavern-Tests/launcher-<buildId>`，与主目录和旧测试数据分开。
没有 `noraLocalTest` 构建元数据的正式包不会启用这个入口。此测试版不能作为正式发布包。

`ops/tests/launcher_packaged_install.test.cjs` 验证真正的打包应用：首次打开、点击安装、进入模型配置、停止与重开继续。
测试不使用真实 Key 或配对码；完成后清理它自己创建的安装目录。
首次打开不再借用系统 Python，安装前状态读取由 Node 完成，安装后只用包内 Hermes Python。

```bash
cd ops/installer/desktop
npm install
npm start
```

`npm run dev:real` 使用定稿的对话式 UI 和真实后台，修改界面或 controller 后自动刷新，不需要打包。它会实际写入安装目录；测试首次安装时设置一个新的 `NORA_TAVERN_HOME`，不要删除已有用户数据。

开发安装可将 `NORA_LAUNCHER_PAYLOAD` 指向整合包的 `payload` 目录，作为已校验组件的本地来源。只有开发模式读取此变量；正式包使用自身资源。两者都先确认最新正式发布，不会把候选包伪装成最新版。缺少发布组件不会退回可能修改系统环境的在线 Hermes 安装脚本。

`npm run dev:mock` 仅用于交互预览，不安装、不保存 Key、不连接服务。直接用浏览器打开 HTML 也是模拟预览。正式桌面壳的通信层加载失败会显示错误，不会切换成模拟成功。

## 真实流程

1. 启动时读取安装文件、已验证模型配置、配对凭据、进程归属和连接状态。
2. 首次点击安装后，锁定最新正式 Release 的版本和 commit，读取对应平台的完整系统清单，准备全部组件后安装 Hermes 和 Tavern。自动写入 Nora SOUL、AGENTS、完整技能及 MCP 配置；MCP 使用实际实例路径和端口。Hermes 默认 SOUL 会替换并备份，用户自定义内容不会因重试被覆盖。
3. 在对话区域输入模型服务、Key、模型名；直接请求该模型服务验证响应成功后，通过 Hermes 配置 API 保存。测试不会启用 Agent 工具，也不会使用旧凭据或备用模型兜底。支持自定义 OpenAI-compatible 接口。
4. 在 ClawChat 联系人中注册 Hermes Agent，输入配对码。启动器启用官方插件并激活，配对码不写入启动器日志。
5. 初始化使用 Hermes 的真实 prompt/skills 加载器检查 SOUL、AGENTS 和技能，并通过实际 MCP stdio 客户端读取当前实例。只有这些检查通过才记录系统已安装。随后自动准备并登录 Liveware、启动 Hermes Gateway 与 Tavern、注册手机入口；模型、ClawChat 和启动检查全部通过才保存 `setupCompleted`。安装阶段的 Tavern HTTP 健康检查不能标记整个流程完成。
6. 后续打开直接进入日常启动界面；断网不清除安装完成记录。打开酒馆会检查并启动缺失服务；停止按钮停止本安装管理的 Hermes 与 Tavern，保留数据。

每次打开在后台检查一次 GitHub 正式版本，保留手动检查入口。区分最新、有新版、本机高于正式版、版本未知和网络失败；后台查询不阻塞本机启动。旧安装可读取本体版本文件，但不据此声称初始化完整。社区地址仍为作者要求的占位符。

当前完整系统提供版本检查与“查看发布”，不把旧 Tavern updater 暴露为整套 Nora 升级。Hermes 跨版本迁移、用户自定义技能合并及启动器自更新尚未实现；已有运行环境与目标清单不匹配时停止并保留配置，不自动覆盖。普通独立 Tavern 更新器仍单独维护。

### Nora 托管配置

首次安装同时配置 SOUL、AGENTS、四组 Nora 技能、五组 ClawChat 技能、MCP、启动 Hook、首次问候及每日版本检查任务。ClawChat 技能通过插件自身的 seeding API 注册，不改写官方插件源码。已有自定义 SOUL 和问候保留。

`hermes/nora-instance.json` 记录本实例的目录和端口，不包含 Key。Hook、服务入口和定时检查读取同一实例。Hook 使用 Hermes Python，恢复已保存的手机入口；首次创建入口由启动器负责。Liveware 注册用实例锁串行执行，避免启动器与 Hook 同时修改绑定。

每日任务使用 Python 而非 Bash，在 Hermes 配置时区的 09:00 执行，非 Agent 模式，不调用模型。任务注册失败会使首次安装失败；回滚覆盖原有 cron/jobs.json、托管脚本、Hook、技能、问候及配置。只有 ClawChat 配对且电脑运行时才可能收到通知，注册成功不等于通知已经送达。

初始化验收检查 Hook 加载、任务唯一且启用、实例端口、技能搜索路径及插件注册。缺失或损坏的托管组件不会被标为安装完成。公开包构建前还检查必需文件清单，避免源码存在而交付归档缺失。

启动器中的模型配置只配置 Nora 使用的 Hermes 主模型；酒馆聊天模型及 MVU 模型保持独立，不会隐式复制 API Key。

## 完整系统发布契约

`ops/scripts/package-release.mjs` 在带 Hermes 运行时构建时生成 `system-assets/`，包括：

- `nora-system-darwin-arm64.json`、`nora-system-darwin-x64.json` 或 `nora-system-win32-x64.json`（每次构建只产生自身平台）。
- 带平台前缀的 app、ops、MCP、Hermes、依赖包及原有校验文件。不同平台不会覆盖同名资产。
- 系统版本、源码 commit、启动器版本、最低启动器版本、每个组件的下载资产名、大小与 SHA-256。

同一次正式 Release 必须包含目标平台的完整资产集合；从版本标签手动运行 CI，完成真机验收后再发布。候选构建明确标记 candidate，不能用于生产首次安装。CI 只上传构建产物，不自动公开发布。

客户端只解析一次最新 Release，后续始终从该 tag 获取全部文件；缺包、版本不符、校验失败或网络错误都会阻止首次安装，不静默降级。下载临时文件不会被当作完成；重试复用已校验完整组件。SHA-256 校验依赖受信任 GitHub 发布来源，不是独立代码签名。

安装成功后原子写入 `tavern/tavern-updates/installed.json`、`installed-manifest.json` 和 `nora-system.json`。这些记录不包含 Key。后者记录技能校验、真实加载证据及首次配置状态；文件缺失、实例配置错误或版本记录不一致会使系统退出就绪状态。

## 隔离与边界

- 默认根目录：macOS 为 `~/Library/NoraTavern`，Windows 为 `%LOCALAPPDATA%/NoraTavern`。
- Hermes、Tavern、缓存、Electron 用户数据、配置及运行记录均放在这个根目录下；子目录越界和符号链接逃逸会被拒绝。
- 这是安装目录隔离，不是操作系统级 Agent 沙箱。用户授权给 Hermes 的工具仍可能访问其他文件。
- Hermes 进程通过 PID、创建时间、命令行核实归属。不会接管或终止其他方式启动的 Gateway。
- Key 仅保存在本机配置中，测试请求会发给用户选择的模型服务；不能把已使用的 Hermes Home 直接当发布素材。
- 核心解压在独立进程完成，不阻塞 Electron。文件替换阶段不允许强制取消；可取消的任务有超时和失败反馈。关闭窗口不等于停止服务，停止需使用停止按钮。

## 构建平台整合包

运行时包必须在目标系统和目标架构上构建，Python 虚拟环境不能跨平台复用。下面以已经安装完成的 Hermes 隔离目录为例：

ClawChat 来源必须与 `../clawchat-bundle.lock.json` 中的官方仓库和完整 commit 一致，且工作树干净。更新插件时先审核完整源码扫描结果，再更新 lock 与 CI checkout 的 ref。不要关闭 `plugins.scan_on_install`，也不要给用户安装命令添加无条件 `--force`。

当前锁定 `8651f7078916e60ed1da9f78ec4d1278fef49dd9`。构建使用 Hermes 的原始扫描器；扫描器版本、判定、44 项结果指纹任一变化均中止构建。接受的是这个版本的已检查提示，不是信任今后所有版本。SSH 提示来自禁止发送凭据路径的注释；角色提示来自首次连接问候；其他高等级提示涉及说明文档、显示设置、问候和显式配置步骤。这是安装风险判断，不是全面安全审计或操作系统沙箱认证。

```bash
node ops/scripts/package-hermes-runtime.mjs \
  --hermes-home "$HOME/Library/NoraTavern/hermes" \
  --clawchat-source /path/to/clean/clawchat-plugin-hermes-agent \
  --output release/hermes-runtime-darwin-arm64

node ops/scripts/package-release.mjs \
  --candidate \
  --hermes-runtime-manifest release/hermes-runtime-darwin-arm64/nora-hermes-runtime.json
```

生成的候选目录包含平台 Hermes 运行时和 Tavern/Nora MCP 生产依赖。进入候选目录的 `nora-tavern-launcher/desktop/` 后构建桌面包：

构建强制包含 ClawChat 源码、Liveware 和文件校验清单，仅复制插件的 Git 已跟踪文件。依赖版本、插件实际注册、适配器导入、Liveware 执行任一失败均中止构建。解压安装后会再次执行同一检查，期间 Python 网络调用被禁止，不需要 Key 或配对码。旧的 Hermes-only 包会被拒绝，不能再把缺少插件的状态显示为安装完成。

配对阶段只启用内置插件并激活，不再运行在线 `plugins install`。构建检查通过不代表 ClawChat 账户配对、手机访问或模型对话已经通过。

- `payload/`
- `launcher-conversation-prototype.html`
- `launcher-controller.js`
- `launcher_bridge.py`
- `launcher_services.py`
- `assets/`
- `package/`

```bash
cd nora-tavern-launcher/desktop
npm install
npm run pack:mac:arm64
```

窗口尺寸固定为 `1120 x 680`，桌面壳负责本机命令，页面只负责 UI 状态。

## 平台覆盖

- macOS Apple 芯片：在 arm64 Mac 上构建 `pack:mac:arm64`。
- macOS Intel：在 x64 Mac 上构建 `pack:mac:x64`。
- Windows x64：在 x64 Windows 上构建 `pack:win:x64`。
- Windows ARM：官方 Liveware 暂未提供原生包，完整流程不列为已支持。

`.github/workflows/build-integrated-launcher.yml` 提供前三个平台的同架构构建任务。插件来源修订会记录到运行时包，Liveware 在构建时下载并随运行时校验和封装。发布前需冻结并审查第三方源码修订。

推荐分发：

- Mac 用户按 Apple 芯片或 Intel 下载对应 `arm64` 或 `x64` 的 DMG。
- Windows 普通用户下载 `Nora-Tavern-Launcher-*-win-x64-portable.exe`。

公开发布前还需要：

- macOS 使用 Apple Developer ID 签名并 notarize，否则下载用户可能遇到 Gatekeeper 拦截。
- Windows 使用代码签名证书，否则下载用户可能遇到 SmartScreen 提醒。

## 验收范围

自动化测试位于 `ops/tests/launcher_*.test.cjs` 与 `ops/tests/test_launcher_*.py`。UI 流程测试通过可控 bridge 验证状态转换；Electron 测试在临时目录验证真正的 preload/IPC 与后台状态读取。这不等于外部服务端到端验收。

`node ops/tests/launcher_bundle_smoke.cjs /path/to/candidate/nora-tavern-launcher/payload` 会在全新临时目录使用真实运行时，验证插件离线注册、Tavern 安装、Hermes 的 Nora 上下文加载、MCP 读取实际实例以及版本和未配对状态，随后停止并清理测试服务与目录。CI 在生成桌面包前执行，不使用模型 Key 或配对码。开发时可加 `--source-installer`，使用当前源码安装器和已有密封程序包测试初始化，无需重打整个桌面包；这不验证远端最新发布下载。

发布前必须在干净 Mac 和 Windows 上实际完成：安装、有效 Key 测试、ClawChat 配对、手机收到 Nora 回复、手机打开 Liveware 酒馆、停止及重新启动、断网重连、更新和失败恢复。当前代码接入不能替代这些真机与账户验收。
