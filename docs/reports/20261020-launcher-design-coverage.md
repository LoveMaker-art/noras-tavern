# 启动器全部产品行为覆盖审计

日期：2026-10-20。设计版本：1.15。类型：文档与源码静态覆盖核对，不是新功能、原生验收或发布证明。

## 范围与固定来源

用户要求完整覆盖启动器全部产品设计，原 1.14 只有既有重点规则归位。本次保持用户行为、代码、数据与发行状态，只扩展[启动器设计](../product/launcher.md)，同步共同设计版本及相关入口。

源码基点为主线 `65a2a7a`（已发布产品提交 `4907f85917c5796db210743e208bc15d323bbcf7` 的后续文档提交）。文档分支 `codex/product-design-modularization-20261020` 未修改产品源码。原项目目录位于较早的发布提速分支；本次不使用其旧主进程代替已发布实现，也不将提速代码合入。

盘点范围：正式 UI 静态结构与内联公共交互、真实控制器全部路由与事件、preload 暴露接口、main 的启动／退出／设置／卸载／更新处理，以及目录、模型、网络来源、日志诊断、历史技能接收和安装器配置。只读源码、文档与现有测试，不读取用户私有配置、聊天或真实 Key，不操作浏览器／测试机。

## 设计覆盖矩阵

各设计章节明确入口、条件、执行、反馈、返回／重试、保护范围与验收。下列测试为已有相关证据入口，本轮未重跑产品测试，不表示覆盖全部新列举的条件。

| 编号与功能 | 唯一设计位置 | 固定源码证据 | 已有相关测试入口 |
| --- | --- | --- | --- |
| L-01 页面与路由 | [设计](../product/launcher.md#pages) | [launcher/ui/launcher-controller.js L537](../../launcher/ui/launcher-controller.js#L537) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-02 公共导航与更多弹层 | [设计](../product/launcher.md#navigation) | [launcher/ui/index.html L345](../../launcher/ui/index.html#L345) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-03 平台安装包、初始化与重复启动 | [设计](../product/launcher.md#package-entry) | [launcher/desktop/main.js L1380](../../launcher/desktop/main.js#L1380) | [launcher_diagnostics.test.cjs](../../tests/deployment/launcher_diagnostics.test.cjs) |
| L-04 目录查看、选择、取消与旧位置 | [设计](../product/launcher.md#location) | [deployment/install/install-location.js L24](../../deployment/install/install-location.js#L24) | [launcher_location.test.cjs](../../tests/deployment/launcher_location.test.cjs) |
| L-05 首次安装、里程碑与设置续接 | [设计](../product/launcher.md#first-use) | [launcher/ui/launcher-controller.js L390](../../launcher/ui/launcher-controller.js#L390) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-06 诺拉／酒馆独立启停与重启、停止全部 | [设计](../product/launcher.md#daily-use) | [launcher/ui/launcher-controller.js L416](../../launcher/ui/launcher-controller.js#L416) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-07 打开酒馆与 ClawChat 客户端 | [设计](../product/launcher.md#daily-use) | [launcher/ui/launcher-controller.js L468](../../launcher/ui/launcher-controller.js#L468) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-08 服务、Key、地址、认证与列表 | [设计](../product/launcher.md#model) | [launcher/ui/launcher-controller.js L948](../../launcher/ui/launcher-controller.js#L948) | [launcher_model_config.test.cjs](../../tests/deployment/launcher_model_config.test.cjs) |
| L-09 验证保存、部分结果与继续同步 | [设计](../product/launcher.md#model) | [launcher/ui/launcher-controller.js L1026](../../launcher/ui/launcher-controller.js#L1026) | [launcher_model_recheck.test.cjs](../../tests/deployment/launcher_model_recheck.test.cjs) |
| L-10 下载、帮助、配对、重配与冷却 | [设计](../product/launcher.md#pairing) | [launcher/ui/launcher-controller.js L1083](../../launcher/ui/launcher-controller.js#L1083) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-11 状态刷新、未知与页面保留 | [设计](../product/launcher.md#state) | [launcher/ui/launcher-controller.js L1215](../../launcher/ui/launcher-controller.js#L1215) | [launcher_ui_feedback.test.cjs](../../tests/deployment/launcher_ui_feedback.test.cjs) |
| L-12 任务、进度、等待、取消与监视 | [设计](../product/launcher.md#tasks) | [launcher/ui/launcher-controller.js L712](../../launcher/ui/launcher-controller.js#L712) | [launcher_shutdown.test.cjs](../../tests/deployment/launcher_shutdown.test.cjs) |
| L-13 后台与手动版本查询、单／双更新、来源与下载 | [设计](../product/launcher.md#desktop-update) | [launcher/ui/launcher-controller.js L1128](../../launcher/ui/launcher-controller.js#L1128) | [launcher_update_sequence.test.cjs](../../tests/deployment/launcher_update_sequence.test.cjs) |
| L-14 错误动作、两类恢复、旧记录与部分完成 | [设计](../product/launcher.md#recovery) | [launcher/ui/launcher-controller.js L562](../../launcher/ui/launcher-controller.js#L562) | [launcher_ui_feedback.test.cjs](../../tests/deployment/launcher_ui_feedback.test.cjs) |
| L-15 实时日志、复制、跟随、缺失与返回 | [设计](../product/launcher.md#logs) | [launcher/ui/launcher-controller.js L49](../../launcher/ui/launcher-controller.js#L49) | [launcher_diagnostics.test.cjs](../../tests/deployment/launcher_diagnostics.test.cjs) |
| L-16 只读安装信息与打开目录 | [设计](../product/launcher.md#installation-info) | [launcher/ui/launcher-controller.js L1203](../../launcher/ui/launcher-controller.js#L1203) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-17 QQ、Discord、B站及复制反馈 | [设计](../product/launcher.md#community) | [launcher/ui/index.html L486](../../launcher/ui/index.html#L486) | 未找到覆盖全部交互的专门断言；保留验收要求，未宣称已测 |
| L-18 人物点击、键盘、本地气泡与动效 | [设计](../product/launcher.md#portrait) | [launcher/ui/index.html L390](../../launcher/ui/index.html#L390) | 未找到覆盖全部交互的专门断言；保留验收要求，未宣称已测 |
| L-19 诊断选择、基础统计、存储与投递 | [设计](../product/launcher.md#diagnostics) | [launcher/ui/launcher-controller.js L12](../../launcher/ui/launcher-controller.js#L12) | [launcher_telemetry.test.cjs](../../tests/deployment/launcher_telemetry.test.cjs) |
| L-20 布局、对齐、滚动、焦点与可达性 | [设计](../product/launcher.md#interaction) | [launcher/ui/index.html L291](../../launcher/ui/index.html#L291) | [launcher_controller.test.cjs](../../tests/deployment/launcher_controller.test.cjs) |
| L-21 Windows／Mac 关闭、退出和重开 | [设计](../product/launcher.md#close-and-disconnect) | [launcher/desktop/main.js L1099](../../launcher/desktop/main.js#L1099) | [launcher_shutdown.test.cjs](../../tests/deployment/launcher_shutdown.test.cjs) |
| L-22 两类卸载、取消、覆盖与重装 | [设计](../product/launcher.md#uninstall) | [launcher/desktop/main.js L1448](../../launcher/desktop/main.js#L1448) | [launcher_uninstall.test.cjs](../../tests/deployment/launcher_uninstall.test.cjs) |

## 静态、动态及桥接逐项对账

已从源码提取并逐项映射：8 个静态管理动作、14 个真实控制器 view 值、30 个桥接方法、24 个静态 DOM 标识和32个动态 DOM 标识。DOM 标识含结构区域与反馈字段，不把它们冒充功能或测试数量。映射 JSON 与源文件 SHA256 保存在忽略目录 `local-state/launcher-design-coverage-20261020/coverage.json`。

| 静态管理动作 | 设计 |
| --- | --- |
| `claw` | L-10 |
| `community` | L-17 |
| `logs` | L-15 |
| `model` | L-08 |
| `settings` | L-16 |
| `stop-all` | L-06 |
| `uninstall` | L-22 |
| `update` | L-13 |

| 真实控制器 view | 设计 |
| --- | --- |
| `loading` | L-01 |
| `welcome` | L-05 |
| `model` | L-08 |
| `model-pending` | L-09 |
| `claw` | L-10 |
| `daily` | L-06 |
| `monitor` | L-12 |
| `task` | L-12 |
| `error` | L-14 |
| `recovery` | L-14 |
| `update` | L-13 |
| `settings` | L-16 |
| `community` | L-17 |
| `uninstall` | L-22 |

| 桥接方法 | 设计／入口性质 |
| --- | --- |
| `status` | L-11 |
| `telemetry` | L-19 |
| `install` | L-05 |
| `start` | L-06 |
| `stop` | L-06 |
| `restart` | L-06 |
| `pair` | L-10 |
| `openInstallDirectory` | L-16 |
| `chooseInstallDirectory` | L-04 |
| `checkUpdate` | L-13 |
| `update` | L-13 |
| `repair` | L-14；底层能力保留，真实“修复当前安装”按钮当前走 update 路由，不虚构独立入口 |
| `recover` | L-14 |
| `operationSnapshot` | L-11；内部任务查询能力，普通页面状态由 status 带回，不虚构任务管理器 |
| `operationLogs` | L-15 |
| `resumeOperation` | L-14 |
| `recoverOperation` | L-14 |
| `recheckOperation` | L-14 |
| `recoverLauncher` | L-14 |
| `cancel` | L-12 |
| `modelProviders` | L-08 |
| `modelOptions` | L-08 |
| `saveAndTestModel` | L-09 |
| `resumeModelSetup` | L-09 |
| `openClawChat` | L-10 |
| `openClawChatApp` | L-07 |
| `openLogs` | L-15 |
| `openSettings` | L-16；当前普通“安装信息”页不调用此配置文件打开接口，不增加“编辑配置”按钮 |
| `uninstall` | L-22 |
| `openExternal` | L-07；同时服务版本说明、下载等链接，普通锚点另经窗口拦截交系统打开 |

额外动态控件按所属函数逐项阅读：服务两行的重启／启停、打开酒馆与客户端、安装位置、安装／继续安装、继续版本升级、任务取消、错误页允许动作、APP／核心恢复与详情、模型服务／认证／密钥可见性／列表／提交／继续同步、配对重提与冷却、版本页安装／重查／说明／返回、日志返回／复制／跟随、社区复制及链接、隐私开关。

HTML 内联还保留了无桥接／mock 的演示流程；正式桌面由 `launcher-controller.js` 接管。旧 `runtimeState` 和 `stop` 元素在真实控制器中移除，不能作为正式底部停止按钮登记；正式停止入口是服务行和更多菜单。人物、社区和更多弹层的公共交互仍来自内联脚本，不因主流程被接管而漏掉。

## 实现参数与平台事实

以下为固定源码快照，不新增长期产品策略或公网可用承诺：

- 主窗口内容尺寸 1120×680，禁止调整大小；CSS 仍含窄宽／短高适配。真实 DPI、工作区小于窗口、系统辅助功能与原生弹框效果未在本次复测。
- 正式默认数据目录：Mac `~/Library/NoraTavern`；Windows `%LOCALAPPDATA%/NoraTavern`。已有合法位置记录优先，自定义环境路径和 Beta／候选有独立范围；安装开始后更改位置不是搬迁功能。
- 正式默认端口 8799，Beta 18998，普通本地候选18999；真实实例仍须读取和验证绑定。安装信息页没有更改端口入口。
- 预置模型服务为 OpenRouter、DeepSeek、Anthropic、OpenAI、Google Gemini 与自定义，当前真实表单的 DeepSeek 默认名为 `deepseek-v4-flash`；内联演示里的旧值不是正式默认依据。具体模型能否调用需相应服务实测，不能从名称或候选列表证明。
- 当前资源配置依次优先极狐、GitHub，再到已有 SourceForge 备用配置。v2.5.5 实际发布选择为 GitHub＋极狐，未补传 SourceForge，因此不能将配置存在表述为该渠道所有版本完整。
- QQ 群号904830926，仅复制号，当前邀请 URL 为空；Discord 与 B站分别是 `https://discord.gg/2fxP9uYvpV2`、`https://space.bilibili.com/484690448`。这些是本次本地来源核对，未浏览验证外部入口或群有效性。
- Windows setup 为非一键向导并允许更改 APP 安装目录；Windows还可构建portable/ZIP，但卸载入口要求唯一setup卸载器。其余由安装器默认生成的页面、快捷方式和系统交互须在原生成品逐页验收，不能从未显式配置的值推出支持承诺。
- Mac 空闲关窗与完整退出不同；Windows 关窗走停服退出。Mac `close` 与完整 `requestQuit` 的状态检查范围存在待核验差异。Windows 菜单启动卸载器后 APP 退出，取消卸载不承诺自动重开；覆盖升级时 NSIS 的 `isUpdated` 分支绕过普通数据清理。
- 状态轮询约5秒、日志追读约1秒、配对冷却显示约250毫秒刷新；下载三分钟无字节与非下载二十秒无业务事件为提示，不是统一失败判定。
- 日志显示区有记录／容量上限；复制另读仍保留的本次记录，达到复制上限或缺失时明示部分。未执行真实系统剪贴板、客户端协议或外链打开。
- 正式详细诊断默认选择与已有关闭选择分别处理，基础统计不受该开关控制。详细证据有界投递、脱敏和送达确认不等于业务成功；当前开关标签的理解问题保留为待确认。

## 设计差异与未验范围

[启动器末节](../product/launcher.md#differences)保留 D-01 自动启动默认策略、D-02 固定窗口支持边界、D-03 本机 APP 版本展示来源、D-04 Mac 关闭保护分支、D-05 诊断开关说明和 D-06 普通外链反馈路径。产品选择统一登记在[总览决策表](../product/README.md#decisions)，其他条目保留技术核验性质；不全部标为已确认 Bug，也不擅自改代码。

本轮未执行 Windows／Mac 原生安装、浏览器或 ClawChat 真实打开、真实模型调用、真实配对、卸载或公网升级。现有源码测试文件只用于核对保护目标，来源版本此前的验收仍按原报告读取。社区复制／人物互动缺少本次全分支交互证明；这不阻止记录规格，不能因此标为已验收功能。

## 本次文档检查

| 本轮检查 | 实际结果 |
| --- | --- |
| 功能／入口覆盖 | 22 类产品能力、8 个静态管理动作、14 个真实路由、30 个桥接方法、24 个静态及32个动态 DOM 标识均有定位；其他计算生成的按钮按实际函数另行人工对账 |
| 原规则保留 | 原 PR-01～PR-14 的用户目标和验收结果共28段保留；启动器原 PB-03／04／06／08 正文及旧 HTML 锚点保留。新增描述区分规则、现状及未确认／核验 |
| 链接与导航 | 15份相关文档的401个本地链接／锚点、旧基线27个标题锚点检查通过；既有 `tests/docs-navigation.test.cjs` 7项通过、0失败、0跳过 |
| 源码与工作区 | 文档分支只有 Markdown 变更；同步回原项目时核对本轮开始的文件摘要，仅更新本次文档，原发布工具、工作流、测试及其他改动保留 |
| 范围与状态 | 文档覆盖和静态核对完成；未提交、合并、推送、构建或发布，未实测平台／账号／视觉流程，不将文档验收冒充产品实测 |

自动清单仅证明上述明确源码集合均有对应位置；人工检查负责动态条件和跨模块语义，不声称工具可发现所有未来功能或策略漂移。
