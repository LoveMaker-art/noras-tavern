# 仅启动器发布：实施与验收记录

状态：本轮源码与分项本地验收完成；独立分支未合并、推送、运行远端 CI 或发布。忽略目录中的私有测试快照不作为项目提交或正式发布。当前结论适用于支持新协议的明确私有基线，不代表线上旧版本可直接采用 APP-only 发布。

**最新修正：** Windows 旧测试窗口在端口已空闲时仍显示占用，正常重开也不解除。实际 `installer/state.json` 留有 `resumeTarget=v2.5.5`、`phase=error` 和原启动错误；后续 shutdown 已成功。已确认 APP-only 成功分支未清此缓存，且 `confirmedMaintenanceIdentity` 仍以新产品提交比对未变核心的提交，无法按真实核心身份收尾。源码已改为先核验原封存计划、再取真实核心身份，并仅在核心验证及 helper finalize 均成功后清理呈现缓存。两项回归在原 08a 源码均失败、修正源码通过，208 项相关消费者检查通过。旧错误窗口已正常关闭，端口与进程均确认空闲，数据和失败历史原状保留。当前 3d APP 的 Mac 与 Windows 运行／停服两态均已实际通过；下文 08a 成品证据仅代表修正前来源。新增 CLI 补丁的证据单列，不能与 3d APP 混同。

## 本轮边界

用户要求仅补齐 APP-only 发布流程，验证启动器独立升级、核心及用户数据不变、诺拉不误报核心更新。保留现有按钮、核心更新器、APP helper 和既有事务；不增加通用更新框架，不扩展 Linux 专用分发或改动真实用户安装。

本地验收结论：Mac ARM 与 Windows 各运行／停服两态原按钮升级通过；程序、收据、受检数据与配置严格不变；正常重开和退出通过；实际安装的诺拉检查器不误报核心更新；Windows 当前 CLI 对真实首装记录只验证、不替换的补验通过。正式启用条件见末节，不能把这些分项证据当成最终三平台正式成品和线上兼容证明。

## 必要改动与依据

| 改动 | 不保留会怎样 | 保留的边界 |
| --- | --- | --- |
| 当前产品批次显式绑定原始核心清单 coreRelease | 新 APP 来源提交会被误当成新核心，或者原核心清单被重写 | 原核心版本、提交、原始字节摘要和平台逻辑资源均绑定；不允许嵌套引用或任意 URL |
| 发布工具、系统描述符、APP 描述符分别使用真实身份 | APP 被误标旧核心提交，或者发布门禁始终要求核心升版 | 平台核心清单和校验表保留原字节；APP 使用本次产品源码身份 |
| 消费者解析及既有最终验收核验真实核心身份 | 下载对了仍会因产品提交不同而假失败；同版本核心可能被重新替换 | 固定发布目标不漂移；原有事务、恢复和锁不变 |
| 首次安装入口按平台系统描述符解析旧核心 | APP-only 批次的新 runner 会被当成核心安装 | 旧无引用协议原路径保留；缺少适用核心资源先拒绝写入 |
| 原生 APP-only 证明生产及 CI 分支 | 消费者有门禁，但没有可生成的真实验收证据 | 真实旧 APP 原 main 与原按钮；不通过换 helper、改版本文字或手填 PASS 替代升级 |

## 已取得的技术证据

仅启动器发布沿用既有构建、验收和发布三阶段：构建工作流明确选择 `app_only=true`，指定已认证的 `launcher_baseline_tag`、`acceptance_baseline_tag` 和新的 `publication_tag`。它不会因为仓库有新提交就自行推断核心变化。

1. 从既有发布目录核验原核心三平台清单、系统描述符、原 APP 描述符和归档；保留真实版本、来源提交、大小及摘要。APP 版本必须增加，核心版本保持不变；发布批次标签单独表达，不拿新批次号替代核心版本。
2. 本次 APP／维护 runner 使用新源码身份；系统安装载荷引用原核心原始字节。核心版本不增加，核心归档不重新编译，不靠重写旧清单伪装成新来源。
3. 在明确的交互桌面上，让实际旧 APP 原按钮升级，分别记录运行中和停止起点；程序、收据、数据及配置任一摘要变化均拒绝生成通过证据。
4. 将真实原生证明交给原有来源和最终消费者门禁；缺失、错配、伪造或其他来源的证明拒绝放行。只声明 runner 标签不代表该环境已经存在。
5. 通过后才进入另行授权的正式发布阶段，GitHub／极狐继续消费同一封存资产目录。本轮停在本地验收，不上传或切换正式入口。

- 169 项 JavaScript 消费者回归通过：APP 与核心独立发现、固定计划、原始核心资源解析、篡改拒绝、同版本独立任务不创建替换事务，以及核心最终提交身份和中断续接。
- 27 项 Python 版本查询和下载入口回归通过。正常提醒入口在只有 APP 变化时不调用发送器、不改提醒状态或安装版本；负对照有真实核心版本变化时仍触发发送器一次。网络及发送边界由隔离适配器替代，不声称公网或真实消息送达。
- 发布工具与最终消费者的定向检查 154 项通过，包括原核心绑定、缺失／错配证明拒绝、工作流接线和真实交付内容选择；真实包装器的 4 项流程通过（测试中跳过 npm 编译）。日志 `component/final-tooling-targeted-v4.log`、`component/real-packager-all-env.log`。这些检查不代替原生按钮升级或远端 CI。
- Git 差异格式检查通过。

日志：本地忽略目录 local-state/app-only-release-20261018/root/consumer-tests.log 和 python-consumer-tests.log。

## 当前收尾修正的验收

当前实际测试 APP 来源为 `3d7523a2174f9d3fcfce43a8dc3c2cfa77524beb`，sourceDigest `00569bc49cca74a19e4ebda9c6ab4193b9b3a050dd783e2a9a6b46b8c114cbf5`。APP 2.2.3、批次 v2.5.5 均为私有测试身份；保留原核心 2.5.2 / 6b6，不改变正式入口。`root/statefix-final/root-audit.json` 记录当时的六运行时文件及生产器绑定；随后新增的 CLI 清单修正与生产器合同修正分别记录，不冒称已在 3d APP 内。

更新收尾的两项回归在原 08a 源码下均失败，修正源码下通过；相关消费者检查 208 项通过。发布工具组当前 160 项通过（`component/final-tooling-targeted-v7.log`）。Mac 实际生产器 `335119edf80a3b71e62d4425e85a5df240370f5eb478da19b462d2fc5ece7ab8`，Windows 实际生产器 `3d34f24ccbb7989613b5c194bb8d26e29037493b32fa5bf448effd193457053a`；均在探测前强制检查真实缓存已收尾，并检查检查点后的全部启动任务，拒绝遗漏失败启动的假通过。

| 当前平台／起点 | APP-only 规范任务 | 当前实测结果 |
| --- | --- | --- |
| Mac ARM／运行中 | `5a498538-7f19-4729-92b3-1d9671f7a82d` | succeeded / confirmed；原 Native PID 64592 保持；真实 UI 及退出验收通过 |
| Mac ARM／已停止 | `4e15a24d-3ad2-400a-8744-42208e2e507a` | succeeded / confirmed；任务结果 running=false；原 UI 另发成功 start `f7afba23-d352-464b-bd5b-101106814048`，界面、退出验收通过 |
| Windows x64／已停止 | `22683446-a36a-4e68-8309-cab119e738f3` | succeeded / confirmed；新窗口自动重开，独立 start `fc70236e-4466-46c2-9488-c30f53f01ca3` 也成功；18,623 项程序／收据、908 项受保护数据与配置严格不变 |
| Windows x64／运行中 | `a9509fec-f16e-4b12-8003-d40587bf6c21` | succeeded / confirmed；原 Native PID 15204 保持，18,623 项程序／收据及 908 项数据、配置严格不变，缓存清空，无新增失败启动 |

Mac 两态均由真实旧 APP 原按钮升级到新 APP，界面再次查询显示酒馆 2.5.2、启动器 2.2.3，均无更新。18,579 项程序／收据记录、904 项受检数据文件及配置摘要严格不变；更新后的缓存均为 ready，resumeTarget=null、error/task 为空，无新增失败启动。正常退出后端口关闭、APP／Native／维护 worker 均退出，锁可获取。两态已通过真实 combine，证明 `root/statefix-final/mac-app-only-native-acceptance.json`，原始记录在其 `mac-running/`、`mac-stopped/`；根任务另验原始前后库存及证据文件摘要。

Mac 另按普通方式重开新 APP（没有 self-update 参数），真实窗口进入正常模型设置页，更多按钮可用，缓存无旧续跑目标，数据摘要仍一致；正常退出后再次确认 running=false、无 owned 进程。额外记录 `root/statefix-final/mac-normal-reopen-{proof,closed}.json`，不以这项额外观察追改已封存两态证明。

针对这份新目标，实际安装的诺拉提醒脚本在正常提醒模式下读取固定目录，发送器调用仍为 0，提醒状态、收据和标记不变；证据 `root/statefix-final/installed-nora-app-only-proof.json`。该检查只替换 HTTP 传输和禁止实际发送，不声称公网或真实通知验收。

Windows 停服态也完成正常重开：从真实窗口的原“更多 → 检查更新”再次确认核心 2.5.2、启动器 2.2.3 均为当前；WM_CLOSE 后普通重开仍显示正常页面及可用菜单，缓存为空。再次正常退出后，全库存不变、实例端口离线、受管进程为 0、操作锁空闲。一次 MSAA 默认动作未使菜单展开的失败方法记录保留；后续按实际控件坐标的原生物理点击得到上述真实界面结果，没有用 IPC 替代按钮。

Windows 运行态也完成实际原菜单复查和正常退出。两态原始记录为 `component/windows-sealed-3d7523-final/evidence-{running,stopped}/`，合并证明为其上级的 `windows-app-only-native-acceptance.json`。下载封存包大小 10,715,839 字节，SHA256 `a7b25f106753c39a560f929e24fdc176ca858eb7a6ea228b4534c1f5b7101e2f`；根任务已独立校验包摘要、四个当前用例的原始证据摘要、前后库存、规范任务、缓存、全部新增启动、退出与锁状态，记录 `root/statefix-final/raw-native-audit.json`，并亲自查看 Windows 更新结果及正常重开截图。Windows 为验收保活的父进程、任务和 keep 文件也已精确收尾，实例端口 65244 无监听，记录 `component/post-native-parent-cleanup.json`。

这两处修正防止新流程留下错误缓存；它们不等于已经为最新任务变成 shutdown 的旧受损测试目录增加自动救援。该旧目录和失败历史原状保留，错误窗口已正常关闭；没有手工清缓存后把旧用例改成通过。

### 首装清单的两处不同遗漏

Windows 正常首装会在原清单加入已校验的 `integratedDependencies` 并按既有格式序列化。真实原发行清单 SHA256 为 `16ef8656496588e9504d13891d945d6e0c555d55b53e700b942c79cec92fe650`，真实本地清单为 `2d3f8a300631a1d65673df3cf42e1b1e4f9b13609ea25ba1f61e2512b15c4c7c`。除了这一合法字段及格式，没有其他对象差异。

- **验收合同遗漏：** 原生 producer 和最终 publisher 曾强求本地字节等于原发行字节。现只接受原始字节，或完整原 JSON 加上同平台系统描述符按 SHA／大小认证的精确依赖元数据、按既有首装格式序列化的字节。保留原发行身份，另记本地真实摘要，程序／收据／数据仍须严格前后相等；不修改收据、不删除字段、不接受任意 JSON 等价变体。真实 2d3 正例和篡改负例已核验，Windows 停服态已据此通过。
- **消费者遗漏：** 独立更新器也以原始清单摘要判断“核心已最新”，合法首装清单会丢失只验证、不替换的路径。managed 与 standalone 两条隔离复现均失败。最小修正保留原字节快路；核心版本、提交和健康状态已相符时，从同一固定计划取得并严格验证原核心清单，再校验实际程序文件。它不信任本地补充字段，不修改原清单。该补丁当前在源码，CLI 58 项及相关消费者 181 项检查通过（`root/app-only-first-install-noop-{red,green}.log`、`root/consumer-receipt-fix-tests.log`）；不把 3d APP 的原生通过当成此新增 CLI 补丁的成品验收。

新增 CLI 的 Windows 原生补验也已通过：从已认证 3d updater 归档建立隔离候选执行闭包，只替换当前 CLI（SHA256 `7f2ac8bd91b6bd6a3acdbb0c58cefcc7229dbae8c27dfbf7b75fccf2fec8930a`），明确标记 base3d＋补丁、candidate／dirty；未改实际安装和收据、未重建 APP 或核心。真实 `task.py → capability.stage/validate → 独立 actor → 锁／policy／bridge` 返回规范任务 `72e3d346-2143-4086-a8ef-afcf1ae866c5` succeeded / confirmed、noUpdate=true、effectState=untouched，查询 settled=true / busy=false。真实 2d3 首装收据和严格全库存不变，最终服务停止、端口离线、进程及保活父进程为空、锁空闲。显式 `--allow-candidate` 禁止遥测上传。该候选闭包是当前 CLI 的分项原生证据，不能冒称纯 3d APP 或正式发布成品。

首轮 CLI 补验因本地 GUI 测试运输目录没有平台核心清单而安全失败、未改数据。原固定 catalogue 本身没有该资产，故没有追改或“重试”原计划；完整保留 `85c40b11-6137-4ce8-b52a-296e90b61523` 的失败记录，补齐同一原始核心字节后，以新的完整 catalogue、新请求建立新计划并通过。原 root／APP／核心身份不变。额外封存包 `component/windows-current-cli-noop-proof-final.zip` 大小 3,950,551 字节、SHA256 `6f1a17dab9c2defd627f1f750353548a0b2b1351e76d65eb4b1c02105c6e1d06`；根任务重新校验包、实际 CLI 字节、能力收据、规范任务、原始全库存和收尾事实，记录 `root/statefix-final/current-cli-raw-audit.json`。

## 历史 08a 原生结果

以下是修正前来源的历史证据，不替代上面的当前目标验收。

Mac ARM 的运行中用例已通过完整原生核验。原始旧 APP 从认证归档解出，真实 main 和原“更多 → 检查更新 → 安装更新”按钮执行了 2.2.2 → 2.2.3，自动重开后显示酒馆仍为 2.5.2，两项均无更新。规范任务为 `3778c119-70d5-49b0-8516-72a34a60f637`，状态 succeeded / confirmed。

- 原核心版本、提交、安装清单摘要与更新前一致；18,579 项程序／收据记录、904 项数据文件及配置的严格前后摘要一致。原酒馆服务进程保持。
- 正常退出 APP 后核实实例端口关闭、APP／维护 worker 无残留、操作锁可获取。真实世界与会话读取、Hermes 上下文和 MCP 检查通过。
- 证据为忽略目录 `local-state/app-only-release-20261018/root/mac-running-final/{checkpoint.json,observed.json,finished-status.json,app-case-proof.json}`。原生 producer 固定摘要 `b7b8dbbbc16a7202e3f2ffca9202e15c10f60bef16a4a2e741464ff6c0410651`。
- 本次基线是私有 6b6 原组件和已核验运行环境的明确组合，不能冒称公开已发布产品；范围为 private-frozen-baseline。测试用 APP 版本 2.2.3、批次 v2.5.5 仅用于本地候选，不改变正式版本。

当前已安装的诺拉定时检查脚本也以正常提醒模式读取这份固定目标：核心 2.5.2，APP 2.2.3，发送器调用 0 次，提醒状态、安装收据和版本标记未变。仅 HTTP 传输替换为实际本地目标字节，发送边界禁止真实传输；证据 `root/installed-nora-app-only-proof.json`。这证明提醒判断，不证明公网可达。

以下原生证据中的 APP 代码来自私有冻结快照 `08a35c1dfc7beaf1b393d7482e6d59d2d29efdd6`，sourceDigest `dd2af3fb32b5e47e13dd112810ac051a88314953ad49d79f2e7121ba929c5937`。`root/final-runtime-source-binding.json` 是修正本次收尾遗漏之前的六文件对照；当前 main.js 已改变，该对照不能代表最新源码。后续成品需绑定新的来源和原生证明，不追改旧证明或伪称整棵当前工作区来自 08a；正式产物仍须从最终审定提交重新封存。

Mac 停服起点也已通过：旧 UI 初次打开会按既有 route 自动启动酒馆，因此先等该正常启动完成，再通过真实 NativeRuntime 停止测试服务，APP 保持打开，在停止状态重新取得严格检查点，然后点击原更新按钮。APP 更新规范任务 `63a3d3b9-17ad-4a8f-b949-17128ebab6ef` succeeded / confirmed，其最终结果 running=false；重开 APP 后既有 route 另发独立的成功 start 任务，记录在 observed.json 的 continuationOperations，不冒称“整个 UI 重开后一直停服”。程序、收据、904 项数据和配置摘要仍与运行中用例完全相同，正常退出后端口、进程和锁均核验。

停服用例 producer 固定为 `7ecc45703146acae4667bd5ced26ae6d9954e935d32f74eab306af832a90b21a`；相对前一版仅收敛上述原有 UI 启动行为的归因，并要求规范 APP 更新本身保留原 running 状态，数据断言未放宽。已完成的运行中证据保留其原 producer 身份。两用例经真实 combine 生成 `root/mac-app-only-native-acceptance.json`，未手填通过标记。

Windows x64 的两态 APP 替换与程序／数据核验已封存；停服起点的无干扰界面流程另行补验，均使用固定生产器 `06a59b930cef2a1cb006a323af21489c50105db7ad90be3ed1e28c890af9359d` 和同一份 08a 候选 APP，未重建 APP。

| 平台／起点 | 规范 APP-only 任务 | 实际结果 |
| --- | --- | --- |
| Mac ARM／运行中 | `3778c119-70d5-49b0-8516-72a34a60f637` | succeeded / confirmed；原 Native PID 48091 保持 |
| Mac ARM／已停止 | `63a3d3b9-17ad-4a8f-b949-17128ebab6ef` | 更新结果 running=false；重开后的原 UI 另发独立 start，单独记录 |
| Windows x64／运行中 | `575f9130-d8ae-468c-a0dc-61b745b4d80c` | succeeded / confirmed；原 Native PID 14068 保持 |
| Windows x64／已停止（旧受干扰用例） | `ef39d448-2f69-4113-821d-89e80e645475` | APP 更新 succeeded / confirmed、结果和观察 running=false；另查 UI auto-start 曾被临时探测占用端口，不能作为无错误界面流程通过 |

此前“无后续独立 start 记录”的说法不准确：observed.json 的 continuationOperations 只记录了当时已认可的续接任务，不能代替完整日志。实际日志出现一次由临时 runtimeProbe 与 UI auto-start 并发诱发的 TAVERN_PORT_OCCUPIED。它未改变 APP 升级和严格库存相等的事实，但降低了该用例的界面验收结论；保留原证据，补一条新界面 More 正常就绪后才做运行探测的停止起点用例。

Windows 两态均完成实际原 APP 2.2.2 → 候选 APP 2.2.3，核心保持 2.5.2 / 6b6；18,623 项核心／收据记录、905 项受检用户文件及配置摘要严格不变。真实 HTTP、世界／会话、Hermes 和 MCP 检查通过。正常 WM_CLOSE 后 APP／Native／维护 worker 均退出，端口关闭，操作锁可获取。

Windows 原始证据位于 `component/windows-sealed-06a/evidence-{running,stopped}-final-06a/`，合并证明为 `component/windows-sealed-06a/root/windows-app-only-native-acceptance.json`。下载封存包 `component/windows-app-only-evidence-06a.zip` 大小 10,755,633 字节、SHA256 `12e49b20483c7534ae01dc70d86e89a4dacef8aaa8eae0fde11b0a40a21ffd40`；104 个文件经逐字节摘要核验。根任务再次独立核验了四个用例的原始库存、证据文件摘要、任务状态、PID 和最终退出事实，记录 `root/native-result-audit.json`。

以上为指定私有基线和实例的 APP 单独升级结果，不替代公开旧版兼容验收、最终正式安装器或远端 CI。

## 被拒绝的验收与生产器修正

本轮新建原生证明生产器对环境和探测副作用的初始检查不完整，造成了重复原生验收。以下属于验收工程遗漏，不把它们归为已证实的 APP 更新故障；相关失败证据保留，未忽略新增文件、重写旧检查点或手填通过结果。

- 运行环境：明确使用受管 HOME、解释器及 Node，不让宿主 Liveware 抢占 PATH；服务停止时临时启动真实服务做运行检查，再恢复原状态。
- 初始服务状态：UI 的正常自动 start 必须真实 succeeded / confirmed，之后才建立停服检查点；用有上限的实际任务等待代替固定睡眠。
- HTTP 探测：实际 shell 路由会初始化一个 20 字节 builtin-welcome 标记；所有健康、世界和会话探测共用同一预检，先完成真实初始化，再取严格快照。Windows 已从该标记缺失状态重新验证预检，原标记仅可逆归档；不把它加入忽略表。
- 窗口：Windows 同一 HWND 在加载 Accessibility 后可能从 UIA Window 变为 Pane；驱动仍需唯一受管主进程、真实标题与非零 HWND，限时等待，并保存所选 PID／HWND／类型，不选择其他应用窗口。
- 退出检查：Windows 受管 Node 与 Python venv redirector 会成为当前观察器的父链。仅排除由真实 psutil 父链证明的当前 census → redirector → 明确 producer PID；其他 APP、Native 和维护 worker 不排除。Windows 独立正反预验确认：全停时 census 为空，另启一个受管 worker 时能精确检出，停止该 PID 后恢复为空。

Windows 最终原生证明使用的生产器固定为 `06a59b930cef2a1cb006a323af21489c50105db7ad90be3ed1e28c890af9359d`；Windows UI 驱动为 `84488d905fe5e6bbdff7516402f2cd7817a45fd642bbffc856b483293bac5758`。在再次升级前，实际新 APP 的 operation-lock.probe、真实状态、离线端口和进程 census 已全部独立预验；日志 `component/native-finish-preflight.log`、`component/native-census-green.log`。此前已封存 Mac 证明保留其当时生产器身份，不追溯伪装为最终生产器运行。

## 发布边界

- 本轮不合并、不发布，不改变公网入口。
- 最终正式来源尚未冻结：当前 CLI 和生产器均晚于 3d APP 快照；Mac／Windows 私有证明分别保留实际生产器身份。正式成品需要从最终审定提交统一封存、构建并取得适用的正式验收，不能直接拿混合来源的本地证明放行。Mac Intel 和正式签名安装器未在本轮补验；这是正式成品阶段的证据缺口，不改写本轮分项通过结果。
- 已直接读取 GitHub v2.5.2 的实际 Windows APP 2.2.2（来源 `ea1e35d83f3cfd2ee16b682a7363cdef74d0a22b`，ZIP SHA256 `6a5765fcf2f043e9dc3c56b45450b1903fd5220eca8a097650c150510bd4f4d5`）的原始 ASAR 选择器。仅把传输映射到本地真实候选资源，旧选择器读到批次、root 与 APP 描述符后明确拒绝“目标发布尚不支持启动器组件更新，未修改当前安装。”这不是网络错误，也没有执行文件替换。证据 `component/official-app-2.2.2/official-app-only-admission.json`。因此该公开 Windows 2.2.2 不能直接进入这个 APP-only 批次；首次正式启用须先有支持协议的兼容过渡基线。私有 6b6 的 APP 同样标为 2.2.2，但来源和能力不同，不能混同。
- 从官方已交付 ops 归档按原 manifest 摘要校验并提取的旧诺拉检查脚本，面对同一 APP-only 目录，`--check-only` 实测仍返回 installed=2.5.2、latest=2.5.5、updateAvailable=true：它按批次标签判断，未读取真实核心版本。未发送通知或写通知状态。证据 `component/official-app-2.2.2/official-nora-app-only-check.json`。APP-only 不替换核心中的旧提醒脚本，因此正式启用前的组合过渡必须同时带上已修正的核心查询逻辑；不能只升级 APP 就宣称旧线上诺拉提醒已改变。
- 交互原生验收需要对应平台可用的桌面会话。声明 self-hosted 调度标签不等于已经存在可用 runner。只读查询本仓库 `actions/runners` 返回 `total_count=0`，证据 `root/repository-runner-readonly.json`；未安装 runner 或触发远端 CI。该接口结果不能推广为组织或账号没有其他 runner，当前原生 CI 分支尚未取得远端执行证据。
- Linux 较旧核心更新到 APP-only 批次尚缺平台核心资源闭包；当前明确拒绝核心写入，不把新 runner 安装成不变核心。本轮不扩展新的 generic 分发协议。核心版本提醒的判定与该写入能力分别记录。
