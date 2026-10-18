# 共用独立更新器验收记录

日期：2026-10-16。分支：`codex/fix-pairing-standalone-update`。未合并、推送或正式发布。本文记录证据，不替代[职责合同](../updater-ownership-contract.md)或维护第二份实施计划。

本次最新范围见末尾“独立更新器方案确认后的补验”：用户已确认保留独立更新器及按钮接入，保留原按钮和操作步骤，仅补齐指定结果的实测。此前已删除无调用的 Python 备用执行路径，并撤回更新期间的退出放行。早期原生事务证据对应各自冻结候选，不能替代当前源码的验收。

## 用户要求和实际变化

普通诺拉/酒馆更新不要求桌面启动器安装或在线。诺拉技能、启动器按钮、官方独立入口以及能取得新 runner 的旧 bootstrap，均提交同一个独立 Node 任务；继续使用原有 OperationController、原生互斥、程序文件事务、数据保护和失败恢复。没有增加另一套文件事务或另一个成功记录。

接管后任务使用私有、清单校验的运行代码快照和独立输出句柄；确认短命提交进程退出后再替换程序。调用方退出不取消任务。桌面 APP 自身更换仍独立判断，不因普通系统更新顺带更换 APP。相同版本且实际文件一致时只核验现状，不重复替换或重启。

## 已完成的原生程序验收

以下实际文件事务使用冻结候选 `candidate-db17f67290f4-1792154891891`，源码基点 `db17f67290f4e2b4b6a21d36b7451f37158e2fd7`，sourceDigest `37328d22c5055610945bd5ad18d84e1edde7015e1c4abf0eefc8857d8419b50a`。它是未提交分支源码的组件测试产物，不是正式 Release 或最终安装包。

| 环境和入口 | 直接观察的结果 | 数据证据 |
| --- | --- | --- |
| Mac ARM，桌面管理的原 2.4.3，真实源码 Electron 窗口按钮 | 原生点击更新；更新中退出 GUI，任务继续成功；重开后能检查版本并返回配置页 | 153 个受检用户文件未变，模型选择和凭据保留 |
| Mac ARM，GUI 关闭后的已安装诺拉技能 | 实际调用共用 task；候选组件更新成功；相同候选再次请求得到 noUpdate、untouched，原服务 PID 不变 | 同一组 153 文件未变，`.env` hash 不变，模型选择语义保留，健康 HTTP 200 |
| Windows，无桌面 APP 的真实原版 2.4.3 | 停止真实旧 Node 后替换；端口占用导致启动失败，自动恢复旧版并达到 rolled-back/confirmed；解除故障后再次更新成功 | 154 个用户文件零变化，世界/会话读回，聊天、角色卡、世界书、模型、配置和 `.env` 保留 |
| Windows，更新调用方退出 | 正向核对 PID/出生时间后结束真实 Python 宿主和 venv wrapper，独立任务仍完成 committed/succeeded/confirmed；重复请求未重复执行 | 最终 worker 结果、原生锁释放、测试进程及端口清理均确认 |
| Linux，无 APP 的真实原版 2.4.2 缓存 bootstrap | 逐字节核对旧入口后直接调用它；接管后 SIGKILL 调用方，独立任务继续成功 | 380 个受检用户文件零变化，世界/会话/模型/`.env` 保留，HTTP 健康，原生锁释放 |
| Linux，原失败任务恢复收尾 | 原 operation `8d5c6b62-8323-4b97-8c23-b52d1874e1cb` 从 failed/recovery-required 收尾到 rolled-back/restored/confirmed；没有删除历史 | 仍是原 2.4.2 和原数据；不是新建操作伪装恢复 |
| Linux，启动失败后再次更新 | 端口占用失败后原任务自动 rolled-back/confirmed；解除占用后 `0190c624-a72a-4b32-88e6-a8adfb4239f0` succeeded/confirmed/committed | 两次均核对 380 文件零变化；原世界/会话、模型、凭据及 HTTP 健康正确 |

程序验收中的本地候选资源只改变固定分发来源，不模拟程序替换、进程停止、文件事务或世界读取。Mac 使用源代码 Electron 窗口，不是最终 DMG；Windows 的调用方是实际 CLI 宿主，不是 ClawChat 真人对话。测试模型使用占位配置，未调用真实外部模型。

## 验收发现并修正的问题

1. 独立 Native 停服只枚举 `/proc`，Windows/macOS 不能据此证明服务已结束。改用既有跨平台 NativeRuntime 的正向归属与停服机制，并再次确认本实例进程离线。
2. Windows 正常读取任务 JSON 也可短暂阻止原子替换。普通 Node 500ms 读取对照中，原代码出现 208 次 WinError5；窄范围修正后同条件 10540 次写入零错，5ms 密集读取亦零错。仅针对 Windows sharing/access 临时拒绝，最多两秒；源或目标变化、非指定错误和持续拒绝仍失败，不原地截断或强行覆盖。
3. 旧文件和服务已实际恢复时，原失败任务可能因只读 DTO 不提供 recover 而无法收尾。现在允许显式同任务恢复，在原生锁内重新核验后写入 rolled-back；只读观察不会直接改终态。
4. 旧 bootstrap 的临时 bundle 会在提交返回后被清理。正式目标按固定 tag/commit/manifest SHA 由任务继续取得，运行代码在接管前封存；显式候选不得引用旧入口自动清理的 install-* 目录。
5. 版本检查不再向诺拉返回完整内部发布清单。实际正式源查询成功，公共结果为版本、来源、检查时间与兼容结论。

## 查询收尾验收

文件事务成功或回退的上述证据已独立确认 worker 最终结果和锁释放。公共 status/wait 随后修正为：真实原生写者仍持锁时返回 `in-progress / busy=true / settled=false`，等待不提前结束；不能核验时明确报错，保留任务，不无限等待或伪报成功。只读查询继续校验原任务的目录归属、来源清单、代码与原生依赖，不要求仍保留已替换的旧安装/Python；写者从不接受这项只读放宽。

追加查询验收对应冻结候选 `candidate-db17f67290f4-1792156239197`，sourceDigest `8a36c8a2625ecddc942cde3f1ea8e560545220f9342b113118ec107a7b728ba9`，清单 SHA256 `956732202cd1b45a95f745a2dbcdb24d6007b54c9b89034bc9de82df5e45c951`。实际事务和追加查询的身份分别保留；没有把旧事务改记为重新安装了查询候选。

| 补验 | 结果 |
| --- | --- |
| Windows 原故障/成功任务，公共 `task.py --status/--wait`，无 NODE_PATH | 原 operationId 准确；分别返回 rolled-back/succeeded、settled=true、busy=false；九项安装和历史文件 hash 未变 |
| Windows 真正 Electron 38.8.6 / Node 22.22 读取原 Node 24 写者任务 | 只读角色正常，未把读者误当原写者；不表示已完成 GUI 点击验收 |
| Windows 真实控制器、原生 lease、临时 raw failed | 持锁时公共状态仍为 in-progress，wait 不早返；同控制器自动恢复并释放锁后才返回 rolled-back |
| Linux 读取原三条真实任务 | 成功 status/成功 wait 返回零；更新回退 wait 返回非零并准确表示 rolled-back，不冒充升级成功 |
| Linux 在原成功任务持有真实原生锁 | wait 不提前返回；释放后读回同一 succeeded；canonical 逐字节未改 |
| Mac 旧 actor 完成更新后，新技能读取该旧任务 | 实际升级到最终查询候选；新技能在 Python `-I -S` 无 site-packages 下读回同一 `41b8392a-c393-4188-9a9b-65c4f1c6659a`，succeeded/settled=true/busy=false，未创建替代任务 |

聚焦合同检查覆盖真实 native guard、旧协议任务迁移、损坏 Python 下查询、不同读者进程、无 NODE_PATH、闭包篡改拒绝和只读标志不能降级写者；相关 Node/技能 18 项、Python 13 项通过。其他原生与发布组件合同分别保存原日志，不将重复运行次数累加为产品覆盖率。

## 清理与当前结论

Windows、Linux、Mac 自有测试服务/进程已停止，历史、数据、日志及校验结果保留。Linux 原 `/opt/data` 仍为 2.4.2、HTTP 200，SSH 长连接保留。用户正常安装未被替换。已测的共用入口、调用方退出续跑、失败恢复与后续再次更新通过；下列未验范围仍明确保留，未执行正式发布。

## 保留的边界

- 没有正式发布候选，实际候选资源为本地固定来源；正式公网新版本端到端下载尚未发生。
- 没有新最终安装包、Mac Intel、Windows 原生 GUI 点击或真实 ClawChat 真人对话验收；不能由 CLI 或源码 GUI 结果推断它们已经完成。
- 历史 2.4.2、2.4.3 的实际结果不等于所有 1.x Python 布局和任意手改部署都已兼容。
- Mac 上一次针对仅变更 ops 的候选尝试按“旧服务退出后占端口”注入故障，旧服务无需重启，注入未触发；该次实际更新成功，不计为 Mac 失败恢复通过。
- 原始 Windows 两份安装和 Linux `/opt/data` 未修改；用户正常 Mac 安装未用于替换或清理。只操作登记的私有测试实例。

原始证据位于本分支忽略目录 `local-state/shared-updater-native-20261016/`、`local-state/updater-independent-windows-20261016/`、`local-state/updater-core-acceptance-20261016/`。关键索引为 `mac-managed/mac-shared-update-proof.json`、Windows `WINDOWS-ACCEPTANCE.md` / `PUBLIC-QUERY-ACCEPTANCE.md`、Linux `linux-final-query-evidence.json` 与各原 operation 结果。这些目录不是发行资源。验收后仅补齐本文及合同/进度文档，不再修改已冻结运行代码。

## 审查修复后的补验（本轮，仍未发布）

本节追加前述候选审查后发现的缺口与实际补验；前文的旧候选通过结果不能替代本轮结果。入口审查候选为 `candidate-db17f67290f4-1792159404622`，sourceDigest `bfa31a2a6e27b88e4ef8925001840d86eebb291d2841105de80366657debf1ea`，清单 SHA256 `5669555c528aa54496e3e389a61042c64fc1f85ed6bd7fc83eb0ff8f3d5ca305`。原生程序故障和回退还使用了前一冻结候选 `candidate-db17f67290f4-1792158845295`，sourceDigest `8ab8639d0a9126f92e08151a7c4bc39371baa55e78a95196bd5b2d250c9694f1`；候选身份分别记录，bfa31a 另经真实 ops 更新和查询核对。

Mac 最后补验发现受管事务已自动恢复、上层却汇总为 untouched 的缺陷后，仅修订 `operation-policy.js` 的恢复结果汇总及对应回归。最后冻结组件候选为 `candidate-db17f67290f4-1792160981972`，sourceDigest `a316e697210f2475e06bb1aca08bb85752cc974e9f603a37f0b02e8316480c70`，清单 SHA256 `5f7cac35ca499c131783c1aafa4e003baf694e1f008aa25645fa298a4ee60496`。相较 bfa31a，除该代码、测试及本文外没有其他源码变化；Mac 实际替换、自动回退及同任务重试直接使用此候选。Windows/Linux 下表的 bfa31a 结果不改记为安装了 a316e6。

### 本轮已实现的收敛

- 重试从原任务恢复不可变请求；根据独立任务的持久关联判断归属，版本查询未完成也不回退到 GUI 的旧内容更新执行器。若 canonical 已提交而关联文件尚未发布，只允许匹配原 requestId、kind=update 的原提交记录重新关联；损坏或冲突记录仍拒绝。
- 酒馆更新继续共用独立任务；GUI 单独发现启动器本体更新，只有本体需更新时沿用既有 APP 交接。启动器元数据获取失败不会否定已核验的内容更新计划。
- 只读检查不再创建可被误认成更新的任务目录。提交者和工作进程记录出生身份；失去写者的提交明确报告 interrupted 或 inspection-required，不能永久伪装“正在提交”。关闭 GUI 使用同一异步查询判断任务归属。
- 独立部署将安装归属、程序健康和数据边界分开检查。已确认归属的旧程序单文件损坏可进入现有更新事务，保留目标资源、事务和数据校验。
- 诺拉的 Python 查询只负责可信入口选择和协议适配，任务发现与状态判断交回 Node。读者启动时核验自身闭包并固定依赖，持续查询不再反复读取原 Node 二进制。Mac 实测首读约 3.836 MiB，后续每次约 0.015 MiB，原 Node 读取量均为零；这只证明该现场查询开销下降，不解释历史公网下载耗时。

原生补验还发现了两处交接边界：bootstrap 提供的外部 runner 清单未用于查询依赖初始化，导致未注入 NODE_PATH 时缺少原生依赖；较慢接管超过短提交等待窗口时，GUI 把非终态误报为失败。前者已改为验证显式 runner 清单后加载锁定依赖；后者返回带 requestId 的明确 submitting/settled=false，GUI 继续等待同一任务，不宣称已完成。聚焦回归覆盖无 NODE_PATH 的真实子进程、提交中止、缺失指针、损坏指针、慢接管、失败拒绝与锁释放。

### 直接观察的结果

| 现场与入口 | 已取得的证据 |
| --- | --- |
| Mac ARM，真实源码 GUI：版本元数据失败后重试 | 同一 operation `31b47e6f-96cc-4a38-8f1b-6d9af1c53ec7` 继续独立任务并成功安装 8ab863 候选；153 个用户文件零变化，`.env` 保留。证据 `mac-review-gui-metadata-retry-proof.json`。 |
| Mac ARM，真实源码 GUI：已封存目标下载失败后重试 | 同一 operation `eb643f68-9f70-4aa4-bc37-20cb192f364b` 保持原固定请求，实际安装最终 bfa31a；同时验证缺失 admission 指针后的关联恢复，原指针随后恢复。153 文件零变化，模型/凭据保留、HTTP 200。证据 `mac-review-gui-download-retry-proof.json`。 |
| Mac ARM，GUI 关闭后的实际已安装诺拉技能 | operation `e787d717-3eb9-4547-8646-16a1bc7c7601` 从 8ab863 更新到最终 bfa31a，succeeded/changed/confirmed；153 文件零变化，模型/凭据保留、HTTP 200。使用固定本地候选，不代表正式公网下载。证据 `mac-review-nora-proof.json`。 |
| Windows，无 APP 的真实原版 2.4.3 | 旧程序单文件损坏后实际替换目标程序；真实端口故障后原任务 `655bacda-2b74-4cd3-854c-0305043bf1c9` 回退至健康旧版，再沿同一任务重试，杀掉真实调用宿主及 wrapper 后仍升级成功。最终 bfa31a ops 更新亦成功，154 用户文件零变化；公共 wait 均确认终态及锁释放。完整限制、分次候选身份和 SSH Job 对照见 `WINDOWS-REVIEW-ACCEPTANCE.md`。 |
| Linux，无 APP 的真实原版 2.4.2 | 8ab863 更新期间 SIGKILL 调用者，独立任务成功，380 用户文件零变化。另一实例端口故障后，外部占用在恢复阶段仍存在，产品保留现场并报告 recovery-required；解除占用后，同一 `ac0b01bf-6eb1-4da8-bd61-09ab86ca95a2` 显式恢复为 rolled-back/restored/confirmed，随后重新更新成功。本项不能记为自动回滚通过。 |
| Linux，最终安装与公共读取 | 已安装更新器继续安装最终 bfa31a，仅 operations/updater 改变，事务目标只有 ops。四条历史/最终任务的公共 status/wait 均 settled=true、busy=false；持有真实原生写锁时 wait 不提前返回，canonical 字节未改。实际已安装诺拉技能的 status 同样正确。380 文件及模型/凭据、世界和会话身份保留；自有服务已停止、37783/55693 关闭，`/opt/data` 保持 2.4.2，SSH 长连接保留。 |
| Mac ARM，最后 a316e6 候选的实际程序回退与重试 | 原 2.4.3 的 app 已实际替换后，占用私有端口使新版启动失败；恢复开始前解除占用。operation `f7da569a-b5f1-4094-ac06-138a2543ab96` 自动达到 rolled-back/restored/confirmed/restored-and-verified，旧 2.4.3 HTTP 200。再沿同一 operation、同一固定目标重试，实际安装 a316e6，succeeded/changed/confirmed、2.5.2 HTTP 200。两次均核对 153 文件零变化，模型和凭据保留；两个请求的公共 status/wait 均 settled=true、busy=false。 |

Linux 注入器原来把 transaction.status 的 recovery-failed 当作 recoveryPlan.phase 判断，因而没有及时释放外部占用。该次保留为真实 recovery-required 和显式恢复证据，未改写成自动恢复成功，也未据此修改产品代码。Windows 曾有观察器解析失败、SSH Job 清理停止测试服务的现场，均在其原生验收记录单独保留，未当作完整成功覆盖。

Mac 的两次前置注入分别没有占到端口、在替换前就触发停服保护，均不能证明程序回退。随后在 app=applied 后注入，确认真实程序已恢复而任务被误记 failed/untouched；对应现场保存在 `mac-review-auto-rollback-result-regression`。真实控制器回归先复现 failed 而非 rolled-back，再修订结果汇总；已经确认自动恢复时不重复交换文件。最后原生补验通过。隔离服务已停止、57991 关闭，历史与备份保留，用户正常 Hermes 网关 PID 81890 仍运行。

### 技术检查、当前缺口与边界

入口审查聚焦 JavaScript 209 项、Python 36 项通过；最后恢复结果汇总修订的受影响策略、控制器、CLI、GUI 路由回归 158 项通过（与前述有重叠，不累加为覆盖数量）。较早两处导出测试上下文缺少当前入口依赖的夹具已补齐并聚焦验证；这不表示整套稳定性 gate 已通过。整套 gate 当前仍被卸载检查阻断：基线未变的原生卸载归属保护会拒绝本机正在运行的正常 Hermes 模块网关 PID 81890，相关测试先得到 UNINSTALL_SERVICES_UNCONFIRMED，尚未抵达预期的后续检查。保护代码与卸载测试的 SHA256 均与源码基点相同；未停止用户正常网关或绕过保护换取通过。

本轮两入口共用、调用者退出续跑、失败恢复与再更新的上述实测已完成。启动器 APP 本体替换的新增发现/路由已有技术回归，不能替代最终安装包的本体更新验收。没有正式 EXE/DMG、Mac Intel、Windows GUI 点击、真实外部 ClawChat 对话、新版本正式公网分发验收；整体 gate 仍有上述阻断，因此不能据此认证可合并或正式交付。没有合并、推送或发布。

本节新增原始证据仍只存于既有忽略目录：Mac 的 `local-state/shared-updater-native-20261016/mac-review-*-proof.json`、`mac-review-cleanup.json`、`mac-auto-rollback-{red,green}.log`、`mac-auto-rollback-candidate-identity.json`、`review-query-performance.json`；Windows 的 `local-state/updater-independent-windows-20261016/WINDOWS-REVIEW-ACCEPTANCE.md` 及其列出的 JSON；Linux 的 `local-state/updater-core-acceptance-20261016/audit-*-result.json`、`same-operation-recovery-candidate-audit-final-2-result.json`、`linux-audit-handoff-query-evidence.json`、`linux-audit-final-delivery.json`、`linux-audit-nora-status.json`、`linux-audit-cleanup-result.json`。私有实例重新准备时把原程序与任务目录移入同目录 `mac-pre-review-*` 归档，保留数据和历史，不把这些证据作为发行资源上传。

## 全局规则落地后的范围复核

本节保留撤回前的审查依据；两项建议的后续执行结果见文末。

### 需求与基线

用户此次授权：写入全局 AGENTS.md，并重新核对本次更新器改动，明确必须保留与可以撤回；不合并发布。本次只修改规则和审查记录，不执行产品代码撤回，不构建安装包、不改用户运行目录。

原始产品结果为：诺拉更新不依赖启动器是否安装或打开；两入口仍能正常更新并共用更新器；调用方断开后任务继续；失败可恢复并重试；保留聊天、角色、世界和配置。更新中允许 GUI 关闭、改用某种语言执行、重做启动器自身更新策略，不是这些结果唯一决定的方案。

固定基线为 `db17f67290f4e2b4b6a21d36b7451f37158e2fd7`，审核该基线至当前未提交工作树，包含新文件。旧 `nora/skills/system/tavern-updater/scripts/update.py` 的 `managed_request` 要求 endpoint 存在且在线；旧 `launcher/desktop/main.js` 的 skill receiver 最终调用按钮同用的 `runAction(...action:'update')`。它们已经共享底层备份、替换与恢复程序。此前“这次才统一为同一个更新器”的说法错误；“按钮也必须更新”是把当前接管实现的依赖当成用户需求的推导错误。

### 保留清单：必要行为与当前实现分开

以下“保留”表示在当前已实测方案中不能直接删除；不主张只有这一种技术实现。

| 变更组及位置 | 对应结果、不保留的后果与证据 | 判断 |
| --- | --- | --- |
| 诺拉技能直接进入更新入口；`bootstrap.py`、旧 `update.py` 接入新任务 | 旧技能必须经在线启动器提交；直接删回旧路径会恢复该依赖。历史 bootstrap 的临时资源清理窗口也有原生证据。 | 必须保留独立入口及接入能力。 |
| 更新器自身身份、清单及资源校验；`updater-capability.js`、`operation-cli.js`、`releases.js` | APP/asar 凭据与更新器执行资格分开，仍核验目录、Node/Python 和程序摘要。删掉此适配会重新要求 APP；直接删安全校验又无法证明维护对象。 | 必须保留。部分文件位于 `launcher/desktop`，但它们是被 updater 组件交付的共用控制代码，目录名不等于桌面界面功能。 |
| 独立任务接管、可靠状态和同一把写锁；`updater-task.js`、Linux 进程出生身份与锁适配 | 调用者退出后任务继续、不能并发写入、恢复中不能提前报告结束。Windows/Linux 的真实调用者退出及公共 wait 证据已记录。 | 必须保留这些行为；复用现有 Node OperationController 是当前实现选择，不能以“简化”名义再新建一套控制器。 |
| 无 APP 安装的状态/恢复适配；`task_backend.py`、`updater-policy.js`、`update.py` 的 guarded 分支与既有 journal | 保留原 2.4.2 等独立部署的真实文件事务、服务归属与显式恢复。删掉适配会丢失无桌面实例的执行/恢复入口。 | 对已确认的独立部署更新范围必须保留。 |
| 原目标重试、恢复收尾；`operation-state.js` 的 closurePending、`operation-policy.js` 的 systemRestored、CLI 固定请求 | 已定位“旧程序恢复但任务不能正确收尾”；Mac 最新原生自动回退、同任务重试及 Linux 原任务显式恢复证明该行为。 | 必须保留；配对相关 hunks 分开列账。 |
| Windows JSON 原子发布窄重试、跨平台归属停服、数据/设置备份保护 | 原生证据包括临时读取与原子替换冲突；旧 /proc 停服不能证明 Mac/Windows 离线。配置与原数据的恢复验证属于用户要求。 | 保留对应故障修正，不削弱校验换取测试通过。 |
| 更新器依赖随组件封存、发布 allowlist 与协议标记；`release-source.mjs`、`package-release.mjs`、`system-release.mjs` | 独立 Node 执行需要自己的锁/semver 依赖，不能偷偷依赖 APP node_modules。真实无 NODE_PATH 的 bootstrap 曾失败。 | 必须保留可执行组件及其验证；这些是交付内容改动，不等于必须当场构建三个安装包。 |
| 聚焦回归及现有 gate 中加入对应场景 | 防止同一资格、同任务恢复、调用方退出和状态错误再次遗漏。 | 保留与保留代码相对应的回归；整仓其他故障单独记载。 |

### 可以撤回、成组拆分和不得误删的部分

| 位置/行为 | 复核依据 | 撤回建议与依赖 |
| --- | --- | --- |
| `update.py:311` 的 `standalone_execution`，以及 `standalone_run:345–383` 的非 guarded Python 子进程执行备用分支（撤回前行号） | 对 deployment、launcher、nora 和 deployment tests 做 AST 调用扫描，`standalone_execution` 无调用点；所有可达独立事务设置 guarded=True，并委托既有 operation_control。证据 `scope-audit-call-sites.json`。 | 建议删除未接入的备用控制路径。保留 guarded_standalone_execution、原安装文件锁及 Linux 暂存依赖准备。不能顺便删 signal/subprocess 导入，其他旧程序停服与入口仍使用它们。后续已按授权删除并通过指定回归，详见文末。 |
| `main.js:1087–1093` 放行退出、窗口 close 的 detachedUpdate 提前放行及对应只服务于关窗的状态 | 允许更新时关窗是可选行为；该放行还存在已隔离复现的保护回归，详见下节。 | 建议撤回此可选放行，恢复安装/模型保存的等待保护；更新器脱离诺拉调用方运行仍必须保留。GUI 遇到独立更新时可提示等待，不能另起停服任务。不是删除全部退出保护。 |
| 按钮 `runSharedUpdate`、`sharedUpdateJob`、进度/同任务恢复接入 | 将按钮切到新提交方式是当前方案；旧基线已共用底层更新器，不能仅凭“共用”证明必须这样改。 | 可作为独立一组拆出，先仅交付自主更新修复。不能只撤一行按钮路由，遗留恢复/状态入口继续指向另一种任务。旧 APP + 新更新组件共存尚未实测；拆出后必须补这项直接相关验证，不能沿用当前新源码 GUI 的通过结果。当前保留已测整组，不擅自回退。 |
| `launcherDiscovery`、`launcherOnly` 及 preload/UI 的相应透传 | 内容查询改用 updater 身份后，不再自动取得 APP 更新计划；这些分支保留了“酒馆已最新而 APP 较旧”时原有 APP 更新能力。 | 保留 GUI 接入方案时不能单独删，否则可能丢失原有 APP 更新入口。只有连同 GUI 适配成组拆出并恢复原入口时才可一起撤；不新增 APP 更新策略。 |
| preload 的错误结果传递 | Electron Error 丢失自定义字段会使 UI 拿不到同任务恢复动作；它也服务于此前授权的配对重试修复。 | 不作为解除自主更新依赖本身的必需项，但也不能只为缩小 diff 直接删除；随所服务的 GUI/配对功能一起核对。 |
| 配对重试、倒计时与原失败日志修正 | 属于此前明确授权的另一故障，不由更新器解耦推导。 | 单独列账并保留，不在本次审查顺手回滚或继续扩展。 |

### 隔离复现的退出保护回归

`updater-task.writerBusy()` 只查询本实例共用写锁是否被占用，不证明占用者就是更新器。查询历史已成功的更新时，若另一项模型/安装操作持锁，public status 也会返回 in-progress/busy=true。`requestQuit` 在检查 activeRun/modelBusy 之前就据此设置 quitReady 并退出。

使用当前交付布局的真实原生 writer lease、实际 requestQuit 函数和隔离 VM 状态复现：锁由 `different-model-operation` 持有，历史 update 的 canonical 仍为 succeeded；分别设置 modelBusy 和 activeRun。基线均保持窗口并提示等待，当前代码均调用 quit、没有等待提示。证据为 `scope-audit-quit-proof.json` / `scope-audit-quit.log`。这是实际控制流复现，不等于执行了真实 GUI 模型保存，也没有证明用户数据已经损坏。

因此不能保留当时的可选关窗放行并宣称其他操作退出安全。此前“更新中关窗”通过只证明更新场景，不能覆盖此场景。它是可选 GUI 适配引入的回归，不推翻已取得的独立更新、文件恢复和数据保留证据；后续已按授权撤回并重新检查，详见文末。

### 复核时结论和执行边界（撤回前）

已完成全局规则写入和本次范围复核；没有改动运行代码，没有执行上述撤回，没有合并、推送、构建或发布。源码与已冻结 a316e6 候选的差异应仅为审查文档。卸载整仓检查、最终安装包、Intel/Windows GUI 等仍按其原证据等级单独保留，不作为此次“写规则及范围核对”未完成的理由。

若继续代码收敛，明确建议只处理两项：删除无调用备用 Python 执行路径；撤回存在回归的可选关窗放行并保持原退出保护。按钮接入与启动器自更新兼容适配作为一组保留，或作为一组拆出并补旧 APP 共存验证；不能从静态分析直接宣布拆分已验证。此段是审查建议，不是新增已获批准的实施计划。

## 按授权撤回两项设计

用户后续明确要求“两个建议撤回的先撤回”，产品设计另行讨论。本次只改动 `deployment/update/update.py`、`launcher/desktop/main.js` 及对应三份回归测试；同步本文和职责合同。没有修改独立任务实现、按钮提交及同任务重试/恢复逻辑，没有合并、推送、构建或发布，也没有替换测试机或用户运行文件。

| 撤回项 | 当前行为 | 保留内容 |
| --- | --- | --- |
| 无调用的 Python 备用执行 | 删除 `standalone_execution` 和非 guarded 的原始 Popen 分支。`standalone_run` 只允许在既有任务管控下委托维护子进程；无有效上下文时拒绝执行。 | guarded 上下文、原文件锁、Linux 暂存依赖准备、同一事务及恢复。 |
| 更新时的退出放行 | 删除 detachedUpdate 标记、窗口 close 提前放行及 requestQuit 中直接 quit 的分支。先执行安装、模型保存、选目录的原退出保护；独立更新忙碌或状态未确认时提示等待，不另行停服。任务结束后可正常执行原停服退出流程。 | 更新器独立于诺拉调用方执行，按钮现有提交、进度、重试和恢复接入。Mac 原有“关闭空闲窗口不等于退出应用”的平台行为保持。 |

### 本次直接验证

- 撤回前新增检查已复现：无 guarded 上下文仍可能进入原始子进程备用路径；更新忙碌/其他写者持锁时直接退出，绕过等待保护。原始日志保留为 `two-rollbacks-python-red.log`、`two-rollbacks-js-red.log`。
- 撤回后，`launcher_shutdown`、`launcher_shared_update_routes`、`launcher_skill_update`、`updater_process_identity` 的聚焦 JavaScript 检查 37 项通过。覆盖任务期间拒绝退出且不停止服务、任务结束后正常退出、安装/模型保存/目录选择保护、原按钮任务与重试路由，以及真实 Node 的原生进程出生身份。
- `test_updater_task_backend`、`test_standalone_update_entry`、`test_standalone_update_recovery`、`test_update_dependency_materialization` 的 Python 检查 32 项通过。覆盖所有维护子进程仍委托原任务、无效备用上下文拒绝、独立入口、数据/配置保护与失败恢复、Linux 临时依赖准备。日志为 `two-rollbacks-{js,python}-green.log`。
- 用实际原生 writer lease 和当前 requestQuit 函数重做原场景：另一模型操作持锁，历史更新记录为 succeeded，公共查询仍为 in-progress/busy=true。activeRun、modelBusy、selectingLocation 三种状态均不退出、无停服尝试并提示等待；基线与当前结果一致。证据 `two-rollbacks-quit-proof.json` / `two-rollbacks-quit.log`。这是本机隔离控制流验证，没有执行真实 GUI 模型保存。
- 首次绿色回归尝试中，新增 Mac close 分支检查缺少窗口对象，报 `win is not defined`；只在该测试上下文补齐窗口对象后全部通过，没有为此改产品逻辑。

以上证明两项撤回的源码行为及相关技术回归；未重新封装组件或安装包、未做撤回后 Windows/Mac 原生 GUI 验收。此前 a316e6 等候选仍是历史证据，不能标记为已安装本次撤回后的源码。当前两项撤回没有遗留的定向检查失败；按钮接入产品设计仍待讨论，不在本次继续更改。

## 独立更新器方案确认后的补验

用户已确认独立更新器方案，保留原按钮与操作步骤。接受条件为：诺拉自主更新与按钮更新使用同一更新器；调用方断开不终止已接管任务；失败后可重试、可恢复并继续正常操作；聊天、角色、世界和配置保留。只处理这些结果的直接缺口，不扩展安装、卸载或新的界面行为，不合并、推送或正式发布。

本轮先固定当前源码并生成本地组件验收资源，不制作正式安装器、不上传分发入口；仅在已登记的私有测试目录实测。原生日志和数据核对保存在既有 `local-state/shared-updater-native-20261016/` 下的新补验目录，避免覆盖旧证据。结果完成后追加。

### 本轮结果与冻结身份

本轮指定结果在下列隔离场景中通过，没有新增产品功能或修改按钮步骤，也没有继续改动运行源码。沿用已收敛的独立任务、同一 OperationController、原生写锁和原文件事务；两项已撤回的设计保持撤回。测试驱动及证据均留在忽略目录。

- 本地冻结候选：`candidate-db17f67290f4-1792164179415`，源码基点 `db17f67290f4e2b4b6a21d36b7451f37158e2fd7`，包含独立分支未提交修改，不等同该 Git 提交或正式发行版。
- sourceDigest：`f6227828ef52b154438f96dddb95b4c926eab247bd3d31280f259f730914f178`；清单 SHA256：`a19277b9ae08d8d8da990552d43a99fa54d076b8c612a509816467dfa59daaae`。测试版本标记沿用酒馆 2.5.2、启动器 2.2.2，没有创建新正式版本。
- 25 个候选文件约 30.3 MiB；远端逐项核对 SHA256SUMS 的 24 个条目。Mac、Windows、Linux 的最终 installed.sourceDigest 均为上述冻结值。Mac 自主更新从已安装 a316e6 更新器接入，再通过当前已安装 f622 更新器检查同版本无替换行为；其余当前 runner 身份在对应记录保留。

| 接受条件 | 本轮实际执行与结果 | 关键证据（均相对于本节忽略目录） |
| --- | --- | --- |
| 诺拉自主更新 | Mac 完全关闭隔离启动器后，调用实际已安装诺拉技能，a316e6 → f622，任务 succeeded/confirmed。当前 f622 技能再次请求同一候选，noUpdate/untouched；公共 wait 确认 settled=true、busy=false。只替换本地候选资源通道，不模拟文件事务。 | `confirmed-mac-nora-{submit.log,proof.json}`、`confirmed-mac-nora-noop-proof.json` |
| 原按钮与操作步骤 | Mac 真实源码 Electron 窗口，通过原“更多 → 检查更新 → 安装更新”操作。2.4.3 → 2.5.2；进度、失败与重试均走同一任务。 | `confirmed-mac-gui-proof.json`；本次 CUA 原生界面操作记录 |
| 调用方断开后继续 | Windows 真实旧 2.4.3 在失败恢复后重试；selecting 阶段核对出生身份，结束 Python 调用宿主及 wrapper，独立任务仍成功。Linux 真实 2.4.2 的原缓存 bootstrap 接管后 SIGKILL 调用方，任务继续成功。SSH 验收宿主会话保持，避免测试机器的 SSH Job 清理另行杀掉整个测试进程组。 | `confirmed-windows-evidence/review-same-task-retry-result.json`、`confirmed-detach-242-cached-result.json` |
| 下载失败后重试 | Mac 任务接管后临时禁止读取本地候选的 updater 模块；界面显示无法访问文件、本次未替换程序，并提供原“重新尝试更新”。恢复权限后原 operation `ed280844-6255-42cf-a502-e955c004aae5`、相同固定目标重试成功，随后再次检查更新显示当前 2.5.2。 | `confirmed-mac-archive-failure.json`、`confirmed-mac-gui-proof.json` |
| 程序失败恢复与再更新 | Mac 确认 app 目标实际 applied 后占用私有端口，启动失败，恢复前解除占用；`cd982c5f-706e-4789-a5ab-ac43bd7cae4e` 自动 rolled-back/restored/confirmed，旧 2.4.3 HTTP 200。沿同一任务、同一目标再次更新成功至 f622。Windows `0dc02a95-abf1-439f-8711-32f2ed7080aa` 同样自动恢复健康旧 2.4.3 后重试成功，并确认目标不变。 | `confirmed-mac-rollback-proof.json`、`confirmed-mac-after-rollback-retry-proof.json`、`confirmed-windows-evidence/{review-fault-result,confirmed-result}.json` |
| 任务结束后可继续使用 | Mac 公共 wait 确认同任务终态与锁释放；重新打开真实窗口能进入原配置页，再点检查更新，正常返回“暂无正式版更新”。Windows 重试后实际停止并重新启动服务，世界与会话接口仍正常。 | `confirmed-mac-final-public-proof.json`、`confirmed-mac-cleanup.json`、`confirmed-windows-evidence/confirmed-result.json` |
| 保留聊天、角色、世界和配置 | Mac 153、Windows 154、Linux 380 个受检用户文件均零变化；发行方管理的扩展与缓存不计为用户文件。世界及会话身份由实际接口读回，模型选择和凭据语义保留，`.env` hash 不变。 | 各 `confirmed-*-proof/result.json` 中的数据、配置、世界与健康字段 |

Mac 在真实更新重试期间按退出快捷键，实际看到“任务尚未结束，暂不能退出启动器”；确认后任务继续，未另行停止服务。完成后的正常退出、恢复后的重开与再次检查均通过。保留了原按钮和操作路径，没有新增更新入口或后台页面。

### 技术检查、清理与剩余边界

本轮受影响的按钮路由、退出、受管/独立策略、任务资格、真实进程身份等 JavaScript 检查 82 项通过；任务后端、独立入口、恢复、任务提交、Linux 依赖准备等 Python 检查 33 项通过。日志为 `confirmed-final-{js,python}.log`，用于说明覆盖范围，不以数量替代上表原生结果。没有运行无直接关联的整仓卸载验收来扩大本次任务。

Mac 隔离窗口和 Native 服务已正常退出，57991 关闭，153 文件再次核对无变化；正常 Hermes 网关 PID 81890 仍在。Windows 私有新副本 `C:\Users\admin\NoraUpdater-20261016-b72b964d\confirmed-f622-243` 已停止、52574 关闭，历史与数据保留。Linux 私有 `confirmed-detach-242` 已停止、32977 关闭；公共 status/wait 均 settled=true、busy=false；原 `/opt/data` 未用于替换，版本仍 2.4.2，原 SSH master 保持。清理证据为 `confirmed-mac-cleanup.json`、Windows 驱动最后的 `confirmed-cleanup`、`confirmed-public-cleanup.json`。

本次确认的更新范围没有剩余定向检查失败或流程阻断。证据等级为指定隔离环境的用户流程实测；不是正式发行验收：未制作最终 EXE/DMG、未做 Windows GUI/Intel 安装包点击、未测试新版本公网分发，未用真实外部模型或 ClawChat 真人对话。调用方断开采用结束实际调用进程验证，不把它写成已经完成 ClawChat 真实网络断线测试。少量旧版本结果也不扩展为任意历史安装均兼容。

没有合并、提交、推送或正式发布。运行源码与冻结候选保持一致，收尾仅更新本记录、职责合同和既有进度文档；最终差异校验证据为 `confirmed-final-source-proof.json`。
