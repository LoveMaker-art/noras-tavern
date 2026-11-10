# 统一更新流程（2026-09-10 历史设计）

此文记录当时的实现与验收，不是当前维护方案。当前APP与核心的更新职责及恢复边界见启动器安装、更新与恢复（原修订 `09b9895:docs/launcher-unified-update.md`），构建和发布操作见[现行发布流程](../release-process.md)。

## 范围

首次安装、界面、模型配置、配对、诺拉与酒馆的独立运行按钮不变。
本次只更改已安装实例的更新执行路径，不移动用户目录，也不覆盖用户自定义人格。

## 执行路径

- 首次安装：启动器 -> 首次安装器。
- 本地更新：启动器下载并校验目标发布 -> 保存完整恢复快照 -> 必要时替换 Hermes 环境 -> 目标发布的 `bootstrap.py` -> `update.py`。
- 云端更新：更新命令 -> 同一份 `bootstrap.py` -> 同一份 `update.py`。

更新器共用发布校验、程序替换、技能/AGENTS/开场白/Hook 更新、世界保护及回滚逻辑。
本地适配额外调用现成 Nora 初始化检查和技能注册函数，不再执行 `first_install.install`。
首次安装模块中可复用的解压、备份及生命周期函数仍是单一实现。

完整桌面快照负责覆盖 Hermes 环境替换、更新中断和启动器最终验收失败。
更新器内部事务负责应用文件、受管配置和世界数据。两层的责任不同；
当前仍保留各自最近一份备份，不声称已实现最小磁盘占用或跨发布差量下载。

## 路径与实例

云端继续从现有安装、MCP 及显式参数核对真实路径，不套用本地首次安装默认目录。
本地允许用户选择隔离根目录；其下仍是 `hermes` 与 `tavern`。
本地适配必须提供隔离根目录，并同时满足：

1. `nora-instance.json` 中根目录、Hermes、Tavern 和端口有效。
2. 实例路径与 MCP、环境变量、调用参数一致。
3. 完整 Nora 安装记录存在，启动器恢复日志处于 `applying`。
4. 诺拉已停止；更新器通过现有跨平台生命周期入口停止酒馆。

不满足条件时拒绝更新，不创建一个新实例“兜底”。
普通单体更新命令仍不能绕过启动器事务覆盖完整本地系统。

Windows 文件读写使用扩展路径；调用 Node 世界校验时转换回盘符或 UNC 路径。
不能将文件系统专用前缀直接作为 Node 脚本入口，否则模块加载可能在盘符处报 `EISDIR`。
转换仅发生在进程调用边界，不修改保存的实例绑定。

## 数据与运行状态

- 保留密钥、配对、Hermes 会话、用户自定义 SOUL、世界及聊天记录。
- AGENTS 全量受管，继续使用共享替换函数，旧文档只留前一份。
- 按共享策略更新项目开场白；自定义开场白不强行覆盖。
- 更新完整技能、Hook、脚本、定时任务及 MCP，重新执行 Hermes 加载与 MCP 读取检查。
- 验收在原端口运行，保留首次配置是否完成的记录。
- 本地不在更新期间重复注册/发送入口；由恢复运行时的原有 Hook 接管。
- 正常完成后恢复原先运行的服务组合；验收失败先恢复数据，再尝试恢复原服务组合。
- 进程中断后仍使用启动器已有的恢复日志；不能停止进程时不覆盖运行中的数据。

## 发布边界

这次必须发布新启动器，版本为 0.3.4，并将新完整发布最低启动器版本设为 0.3.4。
之后普通酒馆、技能等更新继续走更新发布流程，不要求每次重新构建三端 DMG/EXE。
启动器本身或环境依赖发生变化时仍需对应的平台构建。
发布清单目前仍要求附件在同一个 Release；本次不改变这个下载协议。

## 验证

- `test_update_target.py`：本地/云端目录、冲突拒绝、事务许可与世界保护。
- `test_managed_update.py`：同一更新事务更新完整 Nora 配置，注入失败后恢复数据与配置。
- `test_launcher_shared_logic.py`：启动器执行目标发布的已校验更新器，不调用首次安装。
- `launcher_system_update.test.cjs`：完整环境回滚、进程中断恢复、用户配置及实例绑定保留。
- `launcher_product_refactor_smoke.cjs --payload <正式包 payload> --update-release <本地候选更新目录>`：隔离安装正式包，再实际执行新更新器，不使用模型密钥。

2026-09-10 两轮 macOS Apple 芯片真实演练通过：从 v2.3.0 正式安装内容更新至本地
候选代码；3 个世界、11 个受保护文件通过核对，Hermes 加载、MCP 读取、自选端口均通过。
这是本机后端更新演练，不是 Windows/Intel 原生验收，也不是 GitHub 已发布。

最终定向检查：98 项 Python 测试中 96 项通过、2 项按平台条件跳过；
22 项更新器/下载/回滚 Node 测试、19 项发布与目录契约测试通过。
Electron 界面测试因本机缺少 Playwright 未能启动，本轮未改动 UI。
测试实例已停止并删除，用户已有安装及单独保存的 Key 未改动。

### 正式标签验收

本机另一次 v2.3.0 -> v2.3.2 正式标签内容更新通过：3 个世界、11 个受保护文件、
原端口及实际 Hermes/MCP 读取检查均通过。测试实例已停止并清理。

[三平台构建记录](https://github.com/LoveMaker-art/noras-tavern/actions/runs/34466664970)
使用同一提交 `e785b02`：Mac Apple 芯片、Mac Intel 与 Windows x64 的真实首次安装及
已安装实例更新验收均已通过；Windows 测试明确设置 `LongPathsEnabled=0`。
三端此项测试是从当前包安装后再执行同版本受管更新，用于验证原生更新事务，
不等同于三个平台均完成旧版桌面 UI 点击升级；旧版本迁移的真实演练在本机 Mac 完成。

验收曾拦截发布测试样例缺少组件清单，以及 Windows Node 入口不接受扩展路径的问题，
两项均修正后重跑，未跳过世界保护或发布校验。真人 API 调用、IM 配对与跨 Hermes
版本的完整环境替换仍不在本轮原生冒烟测试的覆盖范围内。

2026-09-10 三端安装包与最终发布校验全部通过，
[v2.3.2 正式版](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.3.2)
已公开。启动器及最低支持版本均为 0.3.4；旧版本用户保留数据、更换一次启动器即可。

<a id="legacy-release-delivery-paths"></a>
## 旧组件交付与启动器0.3.4接入说明

本节整理原 `RELEASE-CHANNELS.md` 的历史技术边界。引文保留当时的术语与约束，不是当前发布步骤，也不新增验收结果。当前变更分类、构建、制品封存、上传和正式切换只按[现行发布流程](../release-process.md)执行。

<a id="legacy-release-workflows"></a>
### 当时的两类交付输入

当时区分复用环境的酒馆、MCP、诺拉技能／人格／开场白及独立更新器变更，与需要平台构建的启动器、随包集成、依赖锁或运行环境变更。旧说明对共用实现的记录为：

> Both paths use `package-release.mjs`, `writeSystemRelease`, the same release
> verifier and `publish-release.mjs`. They do not introduce another client update
> protocol or change users' data directories. A shared Actions concurrency group
> prevents the two paths from publishing the same tag concurrently.

组件构建通过 `--components-only` 生成公共app、MCP和更新器归档，不在这一构建阶段安装Hermes或生成Electron、DMG／EXE及启动器ZIP。它先核对三个平台基线清单中的源码指纹；启动器、集成代码、依赖清单／锁及环境打包输入改变、指纹缺失或无法匹配时，原方案要求完整构建，内嵌桌面的helper同样受此保护。旧流程中直接公开latest及删除失败草稿重跑的步骤已被现行分阶段发布与固定计划恢复取代，不作为操作指令保留。

<a id="legacy-component-release-assets"></a>
### 环境复用与同Release附件

旧方案在核验大小和SHA-256后，逐字节复用基线的Hermes／Python／Node及依赖归档，不解包或重建未变环境；变化的是应用内容及目标发布身份。以下保留旧协议与本地缓存边界原文；后续跨Release资产协议的条件按现行流程核对，不从这份历史记录推定：

> The existing launcher's `nora-system/v1` contract requires referenced files to
> exist **in the same GitHub release**. Therefore unchanged environment archives
> are copied into the new release. This still uses upload/storage bandwidth, but
> does not rebuild a large installer. Changing this to cross-release references
> would require a separately planned client protocol migration. Do not omit those
> attachments while claiming old clients can update.
>
> The existing client reuses a bundled/cache file when its hash matches. This
> avoids downloading an unchanged environment in that case, but is not a promise
> that every user will never download it: missing or mismatched local files still
> require a verified download.

<a id="legacy-installer-downloads-034"></a>
### 0.3.4接入与安装器身份

下列最低版本与下载入口描述限定于旧0.3.4接入阶段，不是当前发布最低版本声明或用户操作指令。原说明同时保留Bootstrap摘要与完整安装器身份约束：

> Launcher 0.3.4 switches installed systems to the common updater. The first full
> release carrying this change requires `minimumLauncherVersion: 0.3.4`; older
> shells must be replaced once, without uninstalling their data. Subsequent
> component releases inherit that minimum from the verified full baseline.
> Both full and component payloads include `tavern-updater-bootstrap.py`, pinned
> by the target release manifest. Do not remove it from the desktop payload.
>
> Release notes contain only the current version's changes, fixes and relevant
> notices. Do not append recurring download tables, installation instructions or
> collapsed installation guides; README owns the download entry points.
> `component-release.json` retains the actual full installer tag,
> the runtime baseline tag and reused hashes. Chained component releases retain
> the original installer links and check they still exist. No old installer is
> renamed or presented as newly built.
>
> README's direct download links stay pinned to the actual full installer release.
> When a full installer release is intentionally built, update those links to its
> verified assets. New installations use the launcher's existing latest-system
> resolution; installed users continue using the existing version/update controls.

<a id="legacy-release-verification-scope"></a>
### 原测试范围与证据限制

以下保留原测试职责描述，不把合同覆盖当作新增通过或原生验收结果：

> `tests/component-release.test.mjs` exercises all three manifest variants using
> the unchanged launcher download/validation implementation, including reuse of
> local matching archives, missing remote assets, dependency changes, corrupt
> archives, full-build requirements and verification without installer binaries.
> `tests/launcher-release-notes.test.cjs` checks summary preservation, absence of
> automatically added installation guidance and installer identity validation.
> These are packaging/contract tests, not three-platform native installation tests.
>
> The component workflow also runs world-preservation and rollback regression
> tests. Full platform installation tests remain in the full-installer workflow.
