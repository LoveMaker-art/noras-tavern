# 可靠性交付执行与证据导航

现行规则只在[产品设计1.45](product/README.md)及三份模块设计维护；本文件记录当前任务与证据导航。已完成迭代归入[截至2026-11-01的历史记录](reports/20261101-reliability-history.md)，原锚点继续可达。历史测试、未提交及未发布状态保留其原日期，不能直接当作当前状态。

## 当前源码与已知缺口

- 本轮开工基线为本地main e61a79c，已整合云端实例定位、无APP启停、跨语言写锁及旧事务准入修复；该历史合并本身不代表推送或部署；本轮核心Beta交付状态及证据见下文。
- 完整程序／用户数据回滚分离和现场归因继续登记为L-D07／L-D08；全新Linux首装、真实模型驱动MCP、外部认证及最终桌面安装器等缺口见[N-D04](product/nora.md#differences)。旧未验项不会因归档消失。

<a id="release-pipeline-stability-20261102"></a>
## 2026-11-02 发布流程稳定性与执行收敛

**最新范围校正：**用户要求清掉偏离发布提速目标的Linux空目录安装及旧版构造路径。适用PB-05／06／08／09及共同交付规则：删除新增Python执行器、Node的cloud命令／消费者和三项专属测试，不再从零安装旧版源码、补写发行收据来模拟既有部署。两个Node文件与加入该执行器前的`2285d4c`逐字一致，保留原包重验、三平台首装／两态升级、失败恢复、卸载及数据保护合同；既有Linux核心／独立更新／恢复测试不删。正式数据不变，不运行真实CI，不推送、合并、打包或发布。真实Linux升级缺少可信旧安装的完整证据，继续记为未验，不将取消的夹具失败作为本轮阻断。

此前仅移除fresh场景时的49项本地结果保留在忽略目录`remove-linux-fresh.tap`，不作为现已删除执行器的可用证明。此次清理只撤回新增执行路径，不回退原包复用、失败重跑、入口审计或上传续传改动；关联验证结果在本节补记。

清理验证：5份直接关联的组件消费者、原包来源、工作流、计划及文档检查共232项通过，0失败／跳过，约15.28秒，日志为忽略目录`remove-cloud-harness.tap`。当前入口审计再次通过：5个工作流、315个测试文件、307个自有脚本及73个Python引用；已无被删除执行器、Node导出或cloud命令的源码／工作流引用。原有Linux源码组和三平台关键验收未修改，原始Linux负向证据归档保留；本次未连接云端、安装实例、运行真实CI或写入远端。这证明清理及相关工具合同，不代表真实更新和首次总耗时已验收。

**继续执行的本地收尾：**用户要求持续处理已授权工作。清理已固定在`50f0904`，随后发现组件流程仍将历史升级基线用于改动比较。现于大包准备前核对已发布版本，将改动比较与升级验收基线分别固定；原包重验保留原升级身份，源码检查点绑定比较基线并拒绝换用。原始红灯为2项：工作流缺少独立选择、检查点未拒绝错误比较基线；修正后关联251项通过（约14.99秒），含实际执行工作流命令的正常／原包重验／过期基线拒绝，本地API输入为合成，不计真实CI。仅对4段已核对完整命令更新精确测试步骤指纹，不放宽未知构造输入。

此前将“普通后端仍走完整组”笼统列为未完成，判断过宽：统计模块实际写派生缓存，存储模块写用户内容，保守扩大符合既有规则。本次只将已核实无持久化写入的首屏语言渲染纳入酒馆合同及最低维护组；新增组合反例确保维护／存储变化不能随其降级。实际语言、欢迎世界与聊天保留14项通过。最初从仓库根直接运行用例，先因配置、后因默认图片CWD前提失败；未修改产品或断言，临时模块路径改动已撤回，按原引擎工作目录通过。这是执行方法问题，不登记产品Bug。原始红灯及正确入口结果均保留。

shared已按方案停止启用并保留legacy，不扩展修改旧客户端或提高最低版本；这仍意味着尚未实现跨版本大对象免重复分发。三平台真实阶段重跑、首次总耗时和公网传输依然待独立授权，本地阶段不以它们尚未运行为由停止关联验证。Linux只使用既有合同测试和私有临时文件，不再构造酒馆首装或补写安装收据；当前分支对照1.45，合并前仍须保留另一个任务已更新的main 1.48规则。

固定提交`fa3efc0`对2.6.4的计划核对先被正确拦为review-required：新比较命令已核对，但旧版同一计划生产者的完整命令未成对登记；这仍会让纯工具修改误走产品准备。已补旧命令的精确指纹和旧／新两种比较输入的验证反例，不接受任意改参或新增构建命令。该问题在计划阶段发现，没有构建产品、升版本或上传资产；最终固定提交另行核对。source selection从Node stdin导入时触发旧工具CLI识别的路径前提，后续采用普通文件／eval入口，不扩大修改工具的解释器身份校验。

**执行进度校正：**此前将“第一阶段完成”用于描述前置CI，表述过宽。已经完成的是固定提交`4b74567`的前置入口和工具验证；方案阶段1要求的完整夹具去留核对尚未闭合，阶段2也只证明了已覆盖的分流场景。108秒的前置CI不是三平台成品验收或发布总耗时的测量。

阶段3在这些核对尚未闭合时已交叉推进，包含原包重验、来源绑定、检查点及失败诊断的联动修改。续接后先补齐下述入口／去重／分流核对，再通过原包恢复、隔离工作者解封和最终发布消费者的完整离线CLI测试；原生安装及真实阶段重跑仍未通过本轮验收。此批修改没有推送，不属于`4b74567`的CI结论。新增Linux安装执行器已撤回；已有部署实际升级、阶段6综合验收仍未证明，阶段5的shared兼容未通过，继续保留legacy。

续接时停止扩展实现，保留已有工作，先对照原方案补齐阶段1／2的去留和影响核对，再关闭阶段3的离线完整链路验证；不以增加局部断言代替原生阶段完成，不将后续未验事项登记为通过。主分支、产品版本、正式渠道和用户数据保持原状。

### 续接核对：夹具去留和检查分流

**入口范围：**实际三个根工作流及两个本地调用工作流、源码组／focused入口、备份安全入口，以及酒馆`npm run test:nora`的通配测试和动态契约。原审计遗漏了PowerShell等自有脚本和npm间接入口，现补入同一构建前审计；契约发现复用原执行器的`noraContractFiles`，不再维护第二份名单。缺失脚本故障先红后绿；间接入口审计只读取源码，不启动浏览器或产品。每文件来源摘要、直接消费者、内联工厂及重复候选保存在忽略目录的`fixture-inventory-current.json`、`fixture-review.json`。静态闭包是人工去留核对的线索，不证明所有运行时分支均执行过。

| 夹具／辅助代码 | 保护结果及实际消费者 | 环境、来源与清理 | 处理 |
| --- | --- | --- | --- |
| `published-v2.4.4` | 旧发布元数据；release-consumer、launcher_release_plan、operation_policy | 冻结原格式及来源证明，不随当前版本更新；只读 | 保留 |
| `clawchat-greeting-before` | 原问候顺序；liveware_greeting_order、launcher_shared_logic | 固定历史插件副本，临时home，测试清理 | 保留 |
| `component-acceptance-fixture.mjs` | 汇总器解析、缺项／篡改拒绝；component-native-acceptance及publication-source | 合成2.5.5／2.5.4协议样本，不冒充当前正式基线；调用方临时目录清理 | 保留 |
| publication-source的ZIP构造 | 真实CLI的摘要、布局及报告完整性 | 合成文件，由独立Python zipfile生成；使用选定测试Python，临时目录清理 | 四处构造集中为同文件一个辅助函数；拒绝断言保留 |
| `nora-library`／`nora-preset-presentation`重复预设用例 | 同一适配器、相同输入和完整断言，同由test:nora调用 | 保留专项文件的明确中文locale；没有HTTP或原生行为差别 | 删除library中的完全相同副本及无用import；7项通过；注入脚本过滤失效后，保留用例明确失败 |
| 相同`self.transaction()`包装 | managed_update、update_partial_repair、update_target | 三个类调用各自不同事务构造，分别覆盖完整安装、缺件、旧目标；各自临时数据 | 保留，不能按一行函数体相同合并 |
| publication-source的相同循环回调 | 不同篡改字段、不同报告种类及命名输入 | 回调相同，输入集合不同 | 保留各独有拒绝条件 |
| `launcher_test_lifecycle.cjs` | 实际子进程就绪、错误、管道close及取消 | 持有ChildProcess，有限就绪／关闭截止；不以exit代替close | 保留 |
| `launcher_owned_test_actor.cjs` | 真实维护租约、ACK、关闭和归属拒绝 | 绝对入口、单实例临时根、真实lease取消；不任意杀PID | 保留 |
| `launcher_operation_test_lock.cjs` | 任务提交／陈旧事件的隔离单元合同 | 内存锁，不证明原生进程安全；原生锁用例另行保留 | 保留，与原生锁检查不是重复 |
| `launcher_test_environment.py`及JS环境检查 | 真实解释器、Node非shim、工具／依赖／平台前提 | 清除干扰环境，实际子进程核验；临时锁／链接探测清理 | 保留；目标平台仍需实际执行 |
| `test_nora_native_model`被其他模型测试引用 | loopback、网络限制及真实Hermes构造 | 按模块引用或引用常量，不重复导入TestCase为顶层别名；无真实Hermes不算验收通过 | 保留；不能把fixture方法调用误当重复收集 |
| storage／locale辅助文件 | 备份／世界存储和既有中文UI合同 | 临时世界和记忆目录、进程级环境隔离及退出清理；不恢复到正式目录 | 保留 |
| `verify_launcher_update`／`uninstall-mac-smoke` | APP包验证、卸载helper真实路径 | 调用者明确成品／平台前提；普通源码导入成功不代替原生运行 | 保留 |
| 自有PowerShell／shell／打包／运行工具 | 工作流真实入口存在及前提顺序 | 审计普通文件，排除node_modules及生成dist；不执行这些脚本 | 新增构建前缺失拒绝；语法和目标系统行为另验 |
| 本轮新增Linux安装执行器及专属测试 | 未接入CI；构造旧版、补写收据不能证明真实既有安装 | 按用户要求取消，不接入发布门禁；原始负向日志保留 | 删除执行器、Node命令／消费者及专属测试；既有Linux更新／恢复保护保留 |

没有仅凭日期、文件名或测试数量删除历史／原生保护。未发现非零字面量listen端口不是“没有端口冲突”的证明；现有随机端口、进程清理和有限截止继续保留。Windows PowerShell／路径、真实Chromium、跨文件系统和报告布局的原生证明仍属于对应平台阶段，不能由静态清单放行。

**分流复核：**纯工具／夹具保持verification-only，不构建产品；UI／普通创意技能Markdown／酒馆前端选择各自附加组及最低维护组；可执行技能、维护技能、AGENTS、持久化、安装／更新／恢复／卸载、环境／锁文件及未知影响继续完整相关组。组合变化取并集。这里没有把缺乏调用边界证据的后端业务强行降级为focused。

组件Linux构建入口原有手写4项＋另一步6项列表，与统一选择器产生漂移；现改为直接调用`verify-launcher-stability.mjs`。原10个Python模块保留，追加统一入口既有3个云端路径模块及cloud_core_release，去掉第二份手写列表。Mac／Windows完整组、三平台首装／运行及停止态升级组合、备份与卸载要求不变。分流和入口关联166项通过；Linux所选源码组在本机Mac执行，JS通过、Python154项中150通过／4前提跳过；这只证明便携执行，不算Linux原生、完整安装或全部数据保护验收通过。跳过涉及实际打包进程库／第二个可写文件系统，须在具备条件的目标阶段补验。

历史错误的前置覆盖对应现有用例：缺入口／Python成员／错误平台／依赖次序见release-workflow；SystemRoot、UTF-8、解释器及依赖见launcher-test-environment；归档链接／权限／错上游及跨attempt见build-stage；多路径归档、原包证明／同名元数据和原始报告缺项见publication-source与component-native-acceptance；进程关闭和并发见launcher_test_lifecycle及真实operation_lock。保留已有负向用例，不为每个历史错误重新构建完整产品。当前没有证据声称所有历史平台失败已在本轮目标环境重放。

**本轮原包重验的实际验证：**真实CLI在独立临时Git仓库比较固定产品和验证提交，恢复成功构造、原生失败的原任务ZIP，解封到另一个工作目录，再由发布消费者独立读取API夹具和原始报告。最终回执保留原产品提交／包字节，另记验证提交及三个源码生产者；取消显式重验、把停止态报告的数据保护改为异常、将源码资格绑定到另一个delivery ID均拒绝，失败不产生有效source-receipt。发布消费者确实使用嵌入原ZIP，没有再次请求原大包。该测试约4.9秒，API和原生报告为合成输入，不声称执行了真实安装。关联7份工具组251项通过（约18.1秒），其余19份下游工具／来源／兼容／文档组382项通过（约32.5秒）；两个文件组不重复执行。这是当前代码的本地合同证据，不覆盖真实Actions交接、原生VM和公网传输。

契约发现执行器保留全部原契约并由正常`tooling/run.mjs`映射入口通过；最终文档导航8项通过。第一次直接从源码运行契约执行器因不存在交付布局`ops/scripts/runtime.sh`失败，随后按贡献说明的真实映射入口通过，归类为本轮执行方法错误，未修改产品或断言来放行；原失败日志保留。不把直接入口失败算作产品Bug，也不声称该直接入口受支持。

交付状态继续分开：保留的源码实现与上述本地技术验证已具备；本轮新增代码未推送，主分支未合并，产品未打包或发布。实际前置CI仍只对应下文旧验证提交。已有Linux安装的升级证据、三平台真实阶段恢复／原包重验、首次关键路径与传输对照仍缺；shared兼容只阻止启用shared，不阻止继续保留legacy验证其他流程。

### 历史Linux探索与本地续传实测（新增安装执行器已撤回）

用户明确选择“暂不运行真实CI，只完成本地代码与Linux隔离验收”。本轮没有新增GitHub推送、CI派发、公开资源或渠道切换；前置CI仍只对应旧提交。曾新增Linux执行器在临时目录构造实例，该路径现按用户要求完整删除；下面仅保留历史结果及证据边界，不作为现行执行步骤。没有修改任何产品运行代码、Key或正式数据，main上的其他任务不混入本分支。

Linux机器20655仅使用`/tmp/nora-release-qualification-20261102-2285d4c`；实际Python3.13.5／Node26.5.1，复用其Hermes程序。不是此前固定24.19.0／3.11.9的三平台CI，不借用其工具身份或成功状态。输入为GitHub正式2.6.0（`928d9d8`）与2.6.4（`8241b79`）共享资源，按原SHA256SUMS及archive摘要核对，分别16397251／16427660字节，不是重新构建的候选。

| 实测 | 结果与边界 |
| --- | --- |
| 已取消场景的历史观察：2.6.4共享资源在空目录首装 | 原结果失败，5.326秒，`RESOURCE_INCOMPLETE`。first_install向NativeRuntime.install传入禁止现场准备依赖，而共享包不含本机预装依赖；安装回退，端口关闭。用户随后明确取消该场景；日志保留，不再作为本轮更新或流程优化的阻断 |
| 源码夹具准备 | 原源码首装可启动，约52.553秒；收据为`local-source`，不满足本次正式版升级的身份前提。最初`UPDATER_IDENTITY_INVALID`保留为夹具入口／前提失败，不据此认定真实旧正式用户都无法更新 |
| 已还原2.6.0程序基线→2.6.4 | 升级失败，1.267秒。先核对实际安装的1312个声明程序文件，再由原first_install收据生产者绑定该基线；不声称走通旧正式安装器。更新器枚举首装遗留的UUID目录，目录内只有`first-install`事务、没有外层`operation.json`，直接`ENOENT`；更新事务未开始。没有删除、改名历史或伪造成功结果放行 |
| 失败后的用户数据与可用性 | 世界、聊天／候选、角色PNG、合成`.env`、USER.md／MEMORY.md哈希保持；原2.6.0世界与聊天通过真实HTTP snapshot读取。配置补验确认合成模型、用户偏好和酒馆用户名保留；未调用模型。测试服务停止，端口关闭 |
| 停止态及依赖重建 | 最终冻结结果为未执行：共同更新准入已失败。早期单独尝试同样卡在该层，日志保留，但不把它们当作完成这些业务阶段 |
| 恢复日志合同 | 原2.6.4恢复实现于Linux `/tmp`和`/dev/shm`两个真实文件系统运行4项，2.764秒通过，无跳过，覆盖中断后的恢复及归属清理。这是恢复日志合同，不是完整版本升级／服务恢复成功 |
| 执行器截止与清理 | Mac合同及Linux补验均实际启动持有的sleep子进程，超时后确认关闭；共享预算耗尽不再启动演员。全部测试实例清理前未发现仍在运行的所属进程，原酒馆HTTP仍为200 |

Linux结果仅证明了所列构造基线下的失败，不外推全部既有云端部署；此次没有修复产品首装依赖或历史遍历逻辑。新增首装及旧版构造执行器均已删除，这些历史夹具失败不再作为本轮阻断。更新前的目录失败未排除基线构造影响，不能直接认定真实用户Bug，也不能靠删历史或伪造收据放行。真实既有Linux安装的升级仍缺完整证据，不因撤回执行器而记为通过。

当前工具及消费者关联回归117项通过，无跳过；一次新增云端校验放置到桌面prepare函数的实现错误被原22项断言抓住，已将条件限定回云端入口后通过，没有改旧断言放行。初始Linux运行没有在启动前记录完整harness SHA，不能作为严格固定验证提交的完整资格；原包SHA、命令及失败结果仍有原始证据，后续执行器已补启动时源码摘要。Linux配置与子进程补验另存结果，不改写前次安装／升级失败。

本地HTTP续传演练直接调用原publication-state，只替换远端适配层为回环HTTP服务：16MiB应用对象、640KiB元数据及目录正文，模拟完整写入后确认丢失。两来源共接收34865813字节正文；第一次失败339ms，原计划恢复211ms，已准备对象复核213ms。每对象只创建一次，恢复新增PUT正文0字节、产品构建0、渠道切换0，原计划摘要保持。它验证保留的续传能力及新增观察，不是本分支新创造的续传，不证明GitHub／极狐公网速度或首次发行提速，TCP流量未测。

完整原始结果、输入与脚本、恢复日志及本地传输计数保存在本工作区忽略目录`local-state/release-pipeline-stability-20261102/`；Linux证据只归档直接日志／摘要，不复制整份实例。曾误用逐文件scp回收整个失败目录，已停止，只取必要证据；不将该执行耗时混入产品安装或发布传输结果。后续清理须先回读本地证据SHA并确认测试进程关闭，再删除本轮临时程序／依赖与缓存；不触碰正式实例。

清理已执行：本地回读25088字节／59项证据，SHA256 `4145cafc2df85ab3539b271e07ae2dbd882b2145413c8ea7a90318fd465f7456`。8份实例结果均确认停止，进程复查无本轮活动演员；删除本轮临时实例、核心副本、依赖、恢复测试目录及缓存，保留证据归档／索引与必要脚本，原酒馆HTTP200。中断的本地整目录副本也删除，原始日志归档与固定输入保留。没有推送、合并、构建新产品或发布。

用户授权按[执行方案](design/release-delivery-execution-plan-20261102.md)实施，最终进入主分支及 GitHub 实际工作流；不升级产品版本、不正式发布、不调用子智能体。起点 main `e1c21f527c2a7fe8736cbcebc8ba354abd66246c`，在 `codex/release-pipeline-stability-20261102` 集中实施；已删除的旧流程分支不恢复，其他工作区及正式数据保留。

适用产品设计 1.45 的 PB-05／06／08／09、N-18、L-13／L-22。范围为夹具去留和真实执行前提、检查分流、组件阶段恢复、原包重新验收、Linux 核心验收、资源引用兼容及耗时／字节核对。安装、更新、恢复、卸载及数据保护分别留证，不用测试数量或一次绿色构建作为完成依据。现有来源、大小／SHA、失败状态、渠道锁及上传检查点保护保留。

先完成无需产品构建的原入口／夹具验证，再派发固定输入的目标环境验收。代码实现、技术验证、实际流程、主分支合并／GitHub 启用分别登记；测试资源的公网写入和正式通道切换遵守方案的独立授权条件。未知影响或兼容失败时报告具体阻断，保留有效原包，不增加 skip 或连续抬高产品版本。

当前已实现并完成定向技术验证：Linux／桌面源码入口分配、创意技能说明的内容范围、真实入口与具名成员审计、计划基线和升级基线分离、纯工具不构建分流、组件同提交源码检查点与发布消费者校验，以及有界上传观察。18份关联文件的479项工具断言通过，无跳过（约11.23秒）；这是工具合同验证，不是479次安装，也不是三平台成品验收。故障重放日志与当前入口清单保存在本工作区忽略目录`local-state/release-pipeline-stability-20261102/`。

夹具处理：保留桌面完整组、原生首装／两态升级、恢复／卸载／数据保护断言；修正Linux误用桌面夹具的分配；将工作流测试中重复的入口／Python AST审计合并到可由构建前直接调用的同一检查器。历史`published-v2.4.4`和`clawchat-greeting-before`继续冻结，不因日期旧删除。没有依据不足的功能夹具删除；入口存在性清单不冒充全部夹具语义审查。

仍未达到方案完整完成条件：原包重验协议与最终消费者已有本地离线证明，但干净三平台实际阶段中断／恢复、新增准备／下载开销、已有Linux安装升级及真实公网传输仍未验。新增Linux安装执行器不再列为必须实现项。shared兼容未通过，保持legacy；局部检查不代替上述结果。当前没有主分支合并、测试资产上传或正式发布，产品版本及用户数据不变；后续真实CI及公网演练仍需独立授权。

真实前置CI已获单独授权并通过：[41419456899](https://github.com/LoveMaker-art/noras-tavern/actions/runs/41419456899)，固定验证提交`4b74567cb5fc6344019fb3550cc0f1d6fb21756e`。总跨度108秒，preflight任务101秒，工具组54秒；原始任务与步骤时间保存在忽略目录的`ci-run.json`／`ci-jobs.json`／`ci-observations.json`。`target=preflight-only`独立禁止产品构建及Windows成品复用，实际package-check／reuse-windows／build均为skipped；仅生成430188字节的`nora-release-plan`诊断artifact，没有安装包、发行资产或渠道修改。源提交与原树经GitHub API逐项核对后上传验证分支；本机Git HTTPS和SSH443传输失败未被计为CI或产品失败。主分支仍未合并。此结果只证明这次干净Linux前置入口，不证明Mac／Windows成品、阶段恢复、跨提交原包重验或首次发布总时长。

<a id="cloud-updater-npm-20261102"></a>
## 2026-11-02 独立核心更新的依赖准备修复

用户要求立即修复已发布2.6.0在旧云端部署上准备依赖时的失败，暂停此前交付机器的后续操作；本轮直接执行，不使用子智能体。在main `a3b87c8`的独立分支`codex/cloud-updater-npm-20261102`实施；该阶段不合并、推送、打包或发布，不修改正式实例。

后续用户明确授权立即合并、推送及正式发布，修复已快进合并本地main；首轮失败候选见[2.6.1记录](reports/20261102-v2.6.1-release-preparation.md)，修正组件CI后的后续候选见[2.6.2记录](reports/20261102-v2.6.2-release-preparation.md)，实际发行范围和结果在[2.6.3记录](reports/20261102-v2.6.3-release-preparation.md)继续登记，保留前阶段结果及未验边界。

适用1.45基线PB-02／05／06／07／08、N-18及T-26。用户结果是：既有依赖不能复用时，独立核心更新通过原维护进程通道准备锁定依赖，不再将npm误判为非法Python命令；依赖准备失败时保留原程序、数据和服务。维护锁、进程身份、实际关闭、固定清单、禁用依赖安装脚本、先准备后停服及数据保护均保留，不放开任意外部命令。

已定位：`standalone_dependencies()`将npm直接交给只接受Node／Python的`OperationDelegate.popen()`，触发`OPERATION_CHILD_UNSUPPORTED`。现场发生在替换前，原程序未修改；最小真实进程接口探针复现同一拒绝。原依赖单元测试模拟`standalone_run`成功，未覆盖两层接口的实际组合。

验收顺序：先补实际维护锁／Python委托／Node子进程／离线npm的失败回归，再修正为固定Node执行其npm CLI；覆盖准备成功、npm失败、缺少对应npm、依赖脚本拒绝、旧程序和锁文件不变及真实子进程关闭。执行关联依赖、维护控制与独立更新恢复回归；本机验证、Linux实测和已发布状态分别报告，不以重新安装完成替代更新修复。

实施结果：只修改独立更新的npm命令构造；由现有任务固定的Node运行真实npm CLI，优先查找该运行时入口，并保留原PATH中独立安装的npm发现方式，经CLI文件名及包身份确认后仍交给同一个受管Node。没有增加任意命令放行、shell、外部未委托子进程或目录迁移要求；原维护控制器、锁、超时、禁用安装脚本、清单比较和替换顺序未变。产品1.45规则不变。

- Mac Node24.20.0：先用真实维护锁及Python委托复现旧版`OPERATION_CHILD_UNSUPPORTED`；修复后同一测试实际执行离线npm，成功及npm真实失败两条均通过，所有维护子进程已确认身份并关闭。依赖／独立任务／恢复关联37项通过；控制器、增量及云端路径58项执行，57通过、1项Windows扩展路径条件跳过；原生维护锁26项和文档／布局25项通过。
- Linux Python3.13.5／Node26.5.1：在另一已授权环境的独立临时目录执行修复前后对照，旧源码稳定复现同一拒绝，最终修复源码37项全部通过。该环境正式配置、环境凭据、安装收据及服务PID／出生时间均未变；测试进程关闭，临时目录已清理。没有操作此前用户要求暂停处理的交付机器。
- 保留执行层失败：最初本地测试路径仅按目录存在判断，误选投影中只含依赖的空路径；改为检查实际模块文件后才得到产品红灯。首轮Linux扩大回归的传输夹具漏带两个原生源码文件，并设置了与恢复夹具冲突的安装根环境；修正传输与隔离环境后通过，未修改产品来迁就夹具。最终输入和红绿日志保存在本机忽略目录`local-state/cloud-updater-npm-20261102`。

当前结论仅为独立分支源码修复及Linux／Mac该失败路径、关联合同验证通过。没有重跑三平台完整安装包、没有发布修复后的目标版本，也未证明旧2.3.16经公开新资源完成完整更新。已有公开2.6.0资源未覆盖；需按后续明确授权合并和交付新版本，不能称线上用户已经修复。

<a id="main-prepush-function-check-20261101"></a>
## 2026-11-01 完整主分支推送前功能检查

用户授权检查本地main，将启动器改动一并纳入，功能检查后推送GitHub；另明确允许隔离浏览器验收。范围以1.45产品基线为准，保留现有功能及用户数据，不打包、不派发构建、不发布、不调用子智能体。

固定main `071aa16`、远端main `c65d44b`，相差34个提交／181个文件；核心运行源码已含Beta修正，无需重新合并Beta。完整维护源码、启动器模型与UI、原生Hermes接口、酒馆、MCP／备份及档案检查完成；修正两份缺少新控件／实例定位文件的旧夹具，原断言保留并补强，未修改产品运行代码。失败、条件跳过、具体结果及推送准入见[本轮记录](reports/20261101-main-prepush-function-check.md)。通过的输入及文件摘要留证，实际GitHub同步以最终提交和远端回读为准。

本轮不将源码功能通过当作新三平台安装包或正式发行完成；L-D07／L-D08及外部账号、原生平台未验项继续保留。其他工作区和既有发行资源保持。

<a id="cloud-core-beta-delivery-20261101"></a>
## 2026-11-01 清理与云端核心Beta交付

用户授权按审计顺序修正文档、清理确认无用代码，再推送云端酒馆／诺拉相关内容并发布Beta，在指定云服务器更新及测试稳定性。不推送桌面启动器独有修改，不改变正式稳定通道，不使用子智能体。

适用PB-02／05／06／07／08／09、N-17／18及当前部署实例边界。保留用户聊天、角色、世界、偏好、历史档案、模型与认证配置，以及安装、更新、恢复和数据保护的有效断言。

执行与验收顺序：

1. 更新云端／桌面维护边界、源码测试命令、发布基线示例和失效引用；历史归档保留原文与旧锚点，现有文档检查纳入活跃技术说明。
2. 删除两处无生产调用的私有函数；核对并迁移旧资源接口测试到实际入口，再删除确认无消费者的旧导出。生成快照按唯一来源同步，不删兼容恢复层。
3. 形成独立核心交付分支，逐文件核对相对远端的排除清单。用户已确认允许云端必需的共享维护代码，桌面界面、应用二进制和独有修复不交付。
4. 初始版本为2.5.8-beta.1；后续目录查询修正使用独立2.5.8-beta.2，不覆盖旧资源。必须固定最终提交、核心清单及资源摘要。构建前关联检查、目标Linux私有副本的更新／故障恢复通过后才发布，不把旧候选认定为新包通过。
5. 发布GitHub预发布资源，不切换stable或发布桌面安装器。对已授权云实例先备份，再按已发布字节执行更新；核验原世界与配置、HTTP／MCP、维护结束、合法后续操作及失败恢复。
6. 稳定性检查包含重复启停与读取、至少10分钟运行观察及新增错误核对；保留SSH、Liveware和其他Hermes实例。短期通过只证明该时段，不外推长期稳定。

清理阶段结果：四个无生产用途函数已删除，资源相关断言迁移至实际浏览器清单／版本化路由；档案快照已同步。活跃文档检查仍为原8项，覆盖扩大到20份入口；全量210份文档／1185个本地链接检查无失效。档案87项、原生关联23项及资源接口12项通过。首次误指定不存在的test_native_runtime模块，保留失败日志；实际原有60项执行中59通过、1平台跳过，正确原生组23项补验通过，不将命令错误归为产品失败。

核心交付在独立分支 `codex/cloud-core-beta-2.5.8-20261101` 收敛，基于远端核心分支4ed362c；不将包含桌面改动的本地main历史整体推送。云端共享实例、原生启停、安装／更新／恢复、写锁、诺拉模型及技能按当前实现交付。桌面bridge、UI、Electron main／preload、模型表单／概览、服务重试交互、桌面卸载独有修复及APP包版本均保持远端原值。Beta.1的launcher路径差异为updater-capability.js内5行核心实例绑定分支，供独立更新执行器核验真实根目录。Beta.2另同步共享目录来源、URL及条件校验合同，见后文；没有界面或APP替换行为。

构建前关联检查：共享维护输入变化，因此选择完整既有源码维护组；另执行酒馆test:nora／资源合同、Story Profile、文档与源码布局、Linux实例及原生模型关联组。发布继续采用既有package-release.mjs的components-only模式生成共享核心归档和冷启动入口，不构建或上传Electron APP／桌面安装器；不使用三平台桌面组件工作流的成品资格冒充Linux验收，也不放宽它的门禁。核心版本为2.5.8-beta.1，启动器版本仍为2.2.7；兼容声明只描述协议，不替代桌面实机证据。

远端再核对：当前GitHub仅有main c65d44b和核心分支4ed362c，本Beta以两者为祖先，包含此前已推送的技能库、资料库交互、阅读控制和诺拉原生模型配置；没有选择性遗漏这些既有核心提交。Beta.1相对远端main，launcher路径只新增前述5行共享绑定；Beta.2追加的5个共享文件只服务核心目录查询。

构建前维护组980项JS通过（154.199秒）；Python执行400项（27.457秒，392通过、8项平台／原生条件跳过）；补充真实Hermes关联74项通过，owned lint通过，Story Profile87项通过。酒馆完整回归先发现旧夹具漏接角色列表事件和HTMLFormElement.elements，导致7个叶用例失败及其父用例失败；没有生成产品包。修正这两处夹具，保留六种格式真实HTTP导入、MCP、原数据及删除保护断言，并加入选文件预览不提交导入的断言。失败日志和修正后结果分别保留，不能将原失败记成通过。

酒馆用例修正后执行1560项：1543通过、17项需要外部服务等条件的用例跳过，无失败，51.277秒。补充阅读／消息视图30项通过。结构合同发现已有阅读装配增加15行而旧入口上限仍为500，审查后同步为520并增加阅读模块惰性加载约束；旧消息DOM选择逻辑移回唯一ST视图适配器，滚动行为不变。世界核心边界检查改用现有ESLint的全局引用分析，继续拒绝window／document等浏览器全局及纯模块I/O；不再将合法的document数据字段／局部参数误报成DOM，并把阅读纯数据模块纳入依赖白名单及无I/O检查。27项结构／资源合同按实际构建目录补验；两次单独执行未准备对应工作目录产物，日志保留为执行方法失败，不归为产品缺陷。

此次为共享核心归档Beta，不调用桌面成品发布工作流。Beta标签原有push规则会自动构建桌面安装器，因此本次测试／记录提交使用GitHub支持的skip-ci标记防止误触该流程；本次要求的源码检查、实际Linux升级／恢复及最终发布字节验收仍单独执行，不伪造桌面三平台回执。

该阶段后的Beta.1已从b8a7d96完成构建、25件资源摘要核对、GitHub预发布及授权云实例更新；本次最终改用独立Beta.2，固定来源及验证见下文。原候选回执不替代新字节验收。共享核心维护验收与完整桌面安装／卸载验收分别报告；L-D07／L-D08／N-D04既有缺口保留。

### Beta公网目录查询补验与后续修复范围

Beta.1已从固定提交b8a7d96发布并在授权云实例完成公网固定标签更新。程序、原世界、MCP、任务关闭及21次／600.218秒运行观察通过；338份原清单中336份原位不变，酒馆既有50份自动配置备份策略轮换两份，原件已逐字节核验并另存到更新前私有归档，不将正常轮换认定为程序更新失败。保留原模型配置和四个既有后台服务。

常规Beta检查补验定位到实际缺陷：客户端一次请求100份完整发布资料，超过共享Node读取器4MiB上限，返回RESPONSE_TOO_LARGE；公网10条目录实测1,320,890字节。根清单648,776字节，不是根清单本身过大。先前仅按退出码及available=false判定“没有更新”的结论已更正；原始state=unavailable、latestConfirmed=false保留。

必要修复限定为目录分页和共享URL合同：核心Beta每页10条，最多50页，仍最多考察500项；旧100条／5页URL继续用于历史记录及未改动的桌面发现路径。来源切换、元数据4MiB上限、摘要、固定目标和100秒总预算不变。诺拉周期检查按10条分页保留原100项及30秒预算，只有目录页面采用Node同等4MiB上限，单个清单继续1MiB。收敛共用URL构造和校验，同步离线、六个自包含冷入口来源及最终消费者；不改桌面UI、APP版本或安装器行为。

Beta.1不覆盖已发布字节；完成红绿回归、网络与实际更新检查后单独发布Beta.2。只有确切程序／依赖字节未变的酒馆运行观察可复用，最后仍要补验新更新器的查询、升级、任务结束与数据保护，不能将前包通过直接记为新包通过。

### 最终Beta.2封存与验收记录

- 固定源码：b2e34adcd43f267e48f15ee9be273531aa6682cd；清单SHA256：c713ca54fab4a9df8f654644c898a3d8ae4956c8bdc27160ce01b198c3da89c3；冷入口SHA256：3036ad49e1489e5b653dd72f8218351a2652e7071f8a2a9ac7f2543546ff94b1。25件、32,069,199字节，无桌面安装器。
- 新包构建前共享维护JS980项通过（154.061秒），Python400项执行（27.198秒，392通过、8条件跳过）；目录／分发关联JS73项、Python30项及最终消费者／来源嵌入／组件合同56项通过。保留原4MiB限制、可信来源、摘要及超时；旧目录URL仍可核验历史记录。
- Linux副本直接取自本轮更新前私有归档中的真实2.5.7／01c1333程序与数据，避免拿已更新Beta.1当旧版本。停服、运行两态升级至本包分别通过；两态各282份受保护内容及模型配置未变，2个原世界可由HTTP和真实MCP读取，缺少CSRF的写入被拒绝，任务关闭且后续请求可继续。注入故障发生在本包程序及版本标记真正替换后；原2.5.7程序与标记恢复、服务健康、执行者关闭，内容未变。
- 相对Beta.1，完整清单证明酒馆、MCP及依赖的交付内容相同，仅app版本标记和共享维护／查询文件变化。因此复用Beta.1的600.218秒／21次酒馆稳定观察，另验本包实际查询、公开更新及更新后的短期健康。复用依据保存在本地私有证据目录，不用相同版本号代替字节证明。
- GitHub预发布：[v2.5.8-beta.2](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.5.8-beta.2)，25件资源大小及SHA256逐项一致；正式latest仍为v2.5.7。完整资源按固定发布ID上传，24件补传104.494秒；旧Beta.1保留原资源并在说明中标明目录查询缺陷和替代版本。
- 保留执行层失败：第一次构建调用缺少已有npm运行路径，尚未生成产品，使用已准备环境后构建成功；草稿按tag查找／只修改target时发生草稿定位变化，改为固定ID及完整发布字段后上传与发布；不重建资源。主线回移整组178项中177通过、1项在1秒夹具准备预算超时；保持原预算单独重跑该整文件32项全部通过（33.701秒），后续30项Python整组通过。失败原日志保留，不冒充首次全过。
- 授权云实例已通过公网从Beta.1更新至Beta.2，提交6.884秒，任务succeeded、settled=true、busy=false；诺拉常规检查8.919秒返回current、latest=v2.5.8-beta.2、latestConfirmed=true、metadataSource=network。此次338份受保护文件全部原位未变，原模型及无关配置保留，四个原服务PID及出生时间一致。HTTP与真实MCP读取原世界通过；更新后120.239秒／5次观察同一进程健康、原世界可读，无新增运行错误。另用已交付周期检查器在私有模块选择Beta查询真实公网，取得2.5.8-beta.2，没有改正式通道或发送通知。
- 更新前新增453,201,920字节私有归档；原2.5.7完整备份及Beta.1退役自动备份原件继续保留。私有验收日志及摘要在local-state/cloud-core-beta2-20261101，仅本机留存，不作为公开安装资源。 本轮18个私有测试／探测目录已在核对进程关闭并另存维护回执后移除，清理约5.5GB复制内容；正式备份、正式数据及必要日志保留。

## 历史锚点兼容导航

以下仅跳转到原阶段记录，不再平行维护实施状态。

<a id="启动器可靠性交付设计与执行方案"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%90%AF%E5%8A%A8%E5%99%A8%E5%8F%AF%E9%9D%A0%E6%80%A7%E4%BA%A4%E4%BB%98%E8%AE%BE%E8%AE%A1%E4%B8%8E%E6%89%A7%E8%A1%8C%E6%96%B9%E6%A1%88)

<a id="cloud-lifecycle-main-review-20261101"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-lifecycle-main-review-20261101)

<a id="2026-11-01-云端修复整合与主分支增量复核"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-11-01-%E4%BA%91%E7%AB%AF%E4%BF%AE%E5%A4%8D%E6%95%B4%E5%90%88%E4%B8%8E%E4%B8%BB%E5%88%86%E6%94%AF%E5%A2%9E%E9%87%8F%E5%A4%8D%E6%A0%B8)

<a id="cloud-lifecycle-fix-20261101"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-lifecycle-fix-20261101)

<a id="2026-11-01-云端生命周期阻断修复"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-11-01-%E4%BA%91%E7%AB%AF%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F%E9%98%BB%E6%96%AD%E4%BF%AE%E5%A4%8D)

<a id="cloud-live-acceptance-20261101"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-live-acceptance-20261101)

<a id="2026-11-01-指定linux云端实机验收未通过"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-11-01-%E6%8C%87%E5%AE%9Alinux%E4%BA%91%E7%AB%AF%E5%AE%9E%E6%9C%BA%E9%AA%8C%E6%94%B6%E6%9C%AA%E9%80%9A%E8%BF%87)

<a id="cloud-core-main-integration-20261101"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-core-main-integration-20261101)

<a id="2026-11-01-云端共用核心合并前基线核对"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-11-01-%E4%BA%91%E7%AB%AF%E5%85%B1%E7%94%A8%E6%A0%B8%E5%BF%83%E5%90%88%E5%B9%B6%E5%89%8D%E5%9F%BA%E7%BA%BF%E6%A0%B8%E5%AF%B9)

<a id="cloud-core-review-convergence-20261101"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-core-review-convergence-20261101)

<a id="2026-11-01-共用核心增量审查后的收敛"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-11-01-%E5%85%B1%E7%94%A8%E6%A0%B8%E5%BF%83%E5%A2%9E%E9%87%8F%E5%AE%A1%E6%9F%A5%E5%90%8E%E7%9A%84%E6%94%B6%E6%95%9B)

<a id="cloud-core-instance-20261031"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#cloud-core-instance-20261031)

<a id="2026-10-31-共用核心与部署路径收敛"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-31-%E5%85%B1%E7%94%A8%E6%A0%B8%E5%BF%83%E4%B8%8E%E9%83%A8%E7%BD%B2%E8%B7%AF%E5%BE%84%E6%94%B6%E6%95%9B)

<a id="linux-cloud-baseline-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#linux-cloud-baseline-20261030)

<a id="2026-10-30-linux云端产品基线修订"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-linux%E4%BA%91%E7%AB%AF%E4%BA%A7%E5%93%81%E5%9F%BA%E7%BA%BF%E4%BF%AE%E8%AE%A2)

<a id="reading-main-integration-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-main-integration-20261030)

<a id="2026-10-30-阅读控制与主分支整合"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E9%98%85%E8%AF%BB%E6%8E%A7%E5%88%B6%E4%B8%8E%E4%B8%BB%E5%88%86%E6%94%AF%E6%95%B4%E5%90%88)

<a id="reading-premerge-baseline-review-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-premerge-baseline-review-20261030)

<a id="2026-10-30-阅读分支合并前产品基线核对"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E9%98%85%E8%AF%BB%E5%88%86%E6%94%AF%E5%90%88%E5%B9%B6%E5%89%8D%E4%BA%A7%E5%93%81%E5%9F%BA%E7%BA%BF%E6%A0%B8%E5%AF%B9)

<a id="reading-default-paragraph-10-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-default-paragraph-10-20261030)

<a id="2026-10-30-已确认的内置10px段距"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E5%B7%B2%E7%A1%AE%E8%AE%A4%E7%9A%84%E5%86%85%E7%BD%AE10px%E6%AE%B5%E8%B7%9D)

<a id="reading-paragraph-layout-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-paragraph-layout-20261030)

<a id="2026-10-30-段距真实排版修正"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E6%AE%B5%E8%B7%9D%E7%9C%9F%E5%AE%9E%E6%8E%92%E7%89%88%E4%BF%AE%E6%AD%A3)

<a id="reading-defaults-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-defaults-20261030)

<a id="2026-10-30-通用阅读默认调整：已撤回"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E9%80%9A%E7%94%A8%E9%98%85%E8%AF%BB%E9%BB%98%E8%AE%A4%E8%B0%83%E6%95%B4%EF%BC%9A%E5%B7%B2%E6%92%A4%E5%9B%9E)

<a id="reading-controls-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-controls-20261030)

<a id="2026-10-30-诺拉阅读控制：独立分支"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E8%AF%BA%E6%8B%89%E9%98%85%E8%AF%BB%E6%8E%A7%E5%88%B6%EF%BC%9A%E7%8B%AC%E7%AB%8B%E5%88%86%E6%94%AF)

<a id="card-cover-contract-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#card-cover-contract-20261030)

<a id="2026-10-30-卡库封面验收同步"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E5%8D%A1%E5%BA%93%E5%B0%81%E9%9D%A2%E9%AA%8C%E6%94%B6%E5%90%8C%E6%AD%A5)

<a id="reading-startup-budget-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#reading-startup-budget-20261030)

<a id="2026-10-30-首屏预算后续授权"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E9%A6%96%E5%B1%8F%E9%A2%84%E7%AE%97%E5%90%8E%E7%BB%AD%E6%8E%88%E6%9D%83)

<a id="core-only-source-upload-20261030"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#core-only-source-upload-20261030)

<a id="2026-10-30-仅上传诺拉与酒馆源码，排除启动器更新"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-30-%E4%BB%85%E4%B8%8A%E4%BC%A0%E8%AF%BA%E6%8B%89%E4%B8%8E%E9%85%92%E9%A6%86%E6%BA%90%E7%A0%81%EF%BC%8C%E6%8E%92%E9%99%A4%E5%90%AF%E5%8A%A8%E5%99%A8%E6%9B%B4%E6%96%B0)

<a id="skill-library-main-integration-20261029"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#skill-library-main-integration-20261029)

<a id="2026-10-29-管理技能检查与本地主分支整合"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-29-%E7%AE%A1%E7%90%86%E6%8A%80%E8%83%BD%E6%A3%80%E6%9F%A5%E4%B8%8E%E6%9C%AC%E5%9C%B0%E4%B8%BB%E5%88%86%E6%94%AF%E6%95%B4%E5%90%88)

<a id="skill-library-resource-update-20261029"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#skill-library-resource-update-20261029)

<a id="2026-10-29-技能库本地资源同步"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-29-%E6%8A%80%E8%83%BD%E5%BA%93%E6%9C%AC%E5%9C%B0%E8%B5%84%E6%BA%90%E5%90%8C%E6%AD%A5)

<a id="skill-library-doc-integration-20261028"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#skill-library-doc-integration-20261028)

<a id="2026-10-28-技能库分支文档整合：保留主分支136"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-28-%E6%8A%80%E8%83%BD%E5%BA%93%E5%88%86%E6%94%AF%E6%96%87%E6%A1%A3%E6%95%B4%E5%90%88%EF%BC%9A%E4%BF%9D%E7%95%99%E4%B8%BB%E5%88%86%E6%94%AF136)

<a id="2026-10-27-合并现有修复并校正数据归属基线"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-27-%E5%90%88%E5%B9%B6%E7%8E%B0%E6%9C%89%E4%BF%AE%E5%A4%8D%E5%B9%B6%E6%A0%A1%E6%AD%A3%E6%95%B0%E6%8D%AE%E5%BD%92%E5%B1%9E%E5%9F%BA%E7%BA%BF)

<a id="2026-10-27-校验边界与恢复、服务重试收敛"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-27-%E6%A0%A1%E9%AA%8C%E8%BE%B9%E7%95%8C%E4%B8%8E%E6%81%A2%E5%A4%8D%E3%80%81%E6%9C%8D%E5%8A%A1%E9%87%8D%E8%AF%95%E6%94%B6%E6%95%9B)

<a id="补充核查：恢复后的正常编辑"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E8%A1%A5%E5%85%85%E6%A0%B8%E6%9F%A5%EF%BC%9A%E6%81%A2%E5%A4%8D%E5%90%8E%E7%9A%84%E6%AD%A3%E5%B8%B8%E7%BC%96%E8%BE%91)

<a id="初次修订记录（起点至789a9a9）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%88%9D%E6%AC%A1%E4%BF%AE%E8%AE%A2%E8%AE%B0%E5%BD%95%EF%BC%88%E8%B5%B7%E7%82%B9%E8%87%B3789a9a9%EF%BC%89)

<a id="本轮实施与证据边界"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E6%9C%AC%E8%BD%AE%E5%AE%9E%E6%96%BD%E4%B8%8E%E8%AF%81%E6%8D%AE%E8%BE%B9%E7%95%8C)

<a id="mac／windows实际验证"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#mac%EF%BC%8Fwindows%E5%AE%9E%E9%99%85%E9%AA%8C%E8%AF%81)

<a id="default-skill-library-20261023"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#default-skill-library-20261023)

<a id="2026-10-23-默认技能库管理：独立分支接入"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-23-%E9%BB%98%E8%AE%A4%E6%8A%80%E8%83%BD%E5%BA%93%E7%AE%A1%E7%90%86%EF%BC%9A%E7%8B%AC%E7%AB%8B%E5%88%86%E6%94%AF%E6%8E%A5%E5%85%A5)

<a id="optional-launcher-query-20261022"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#optional-launcher-query-20261022)

<a id="2026-10-22-可选启动器查询失败不阻断兼容核心更新（源码修复与隔离验证完成）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E5%8F%AF%E9%80%89%E5%90%AF%E5%8A%A8%E5%99%A8%E6%9F%A5%E8%AF%A2%E5%A4%B1%E8%B4%A5%E4%B8%8D%E9%98%BB%E6%96%AD%E5%85%BC%E5%AE%B9%E6%A0%B8%E5%BF%83%E6%9B%B4%E6%96%B0%EF%BC%88%E6%BA%90%E7%A0%81%E4%BF%AE%E5%A4%8D%E4%B8%8E%E9%9A%94%E7%A6%BB%E9%AA%8C%E8%AF%81%E5%AE%8C%E6%88%90%EF%BC%89)

<a id="同日合并前的133基线复查"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%90%8C%E6%97%A5%E5%90%88%E5%B9%B6%E5%89%8D%E7%9A%84133%E5%9F%BA%E7%BA%BF%E5%A4%8D%E6%9F%A5)

<a id="regression-main-cleanup-20261022"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#regression-main-cleanup-20261022)

<a id="2026-10-22-测试流程合并与冗余工作区清理（本地合并与文件清理完成）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E6%B5%8B%E8%AF%95%E6%B5%81%E7%A8%8B%E5%90%88%E5%B9%B6%E4%B8%8E%E5%86%97%E4%BD%99%E5%B7%A5%E4%BD%9C%E5%8C%BA%E6%B8%85%E7%90%86%EF%BC%88%E6%9C%AC%E5%9C%B0%E5%90%88%E5%B9%B6%E4%B8%8E%E6%96%87%E4%BB%B6%E6%B8%85%E7%90%86%E5%AE%8C%E6%88%90%EF%BC%89)

<a id="release-test-selection-20261022"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#release-test-selection-20261022)

<a id="2026-10-22-按实际改动选择发布回归（本地实施与验证完成）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E6%8C%89%E5%AE%9E%E9%99%85%E6%94%B9%E5%8A%A8%E9%80%89%E6%8B%A9%E5%8F%91%E5%B8%83%E5%9B%9E%E5%BD%92%EF%BC%88%E6%9C%AC%E5%9C%B0%E5%AE%9E%E6%96%BD%E4%B8%8E%E9%AA%8C%E8%AF%81%E5%AE%8C%E6%88%90%EF%BC%89)

<a id="regression-audit-20261022"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#regression-audit-20261022)

<a id="2026-10-22-回归测试审查与清理"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E5%9B%9E%E5%BD%92%E6%B5%8B%E8%AF%95%E5%AE%A1%E6%9F%A5%E4%B8%8E%E6%B8%85%E7%90%86)

<a id="2026-10-22-合并前收敛：只读检查、旧版接入及文档一致性"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E5%90%88%E5%B9%B6%E5%89%8D%E6%94%B6%E6%95%9B%EF%BC%9A%E5%8F%AA%E8%AF%BB%E6%A3%80%E6%9F%A5%E3%80%81%E6%97%A7%E7%89%88%E6%8E%A5%E5%85%A5%E5%8F%8A%E6%96%87%E6%A1%A3%E4%B8%80%E8%87%B4%E6%80%A7)

<a id="nora-unified-update-20261022"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#nora-unified-update-20261022)

<a id="2026-10-22-当前任务：外部核心更新后的-app-衔接及诺拉统一更新"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-22-%E5%BD%93%E5%89%8D%E4%BB%BB%E5%8A%A1%EF%BC%9A%E5%A4%96%E9%83%A8%E6%A0%B8%E5%BF%83%E6%9B%B4%E6%96%B0%E5%90%8E%E7%9A%84-app-%E8%A1%94%E6%8E%A5%E5%8F%8A%E8%AF%BA%E6%8B%89%E7%BB%9F%E4%B8%80%E6%9B%B4%E6%96%B0)

<a id="历史交付准备（2026-10-18）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%8E%86%E5%8F%B2%E4%BA%A4%E4%BB%98%E5%87%86%E5%A4%87%EF%BC%882026-10-18%EF%BC%89)

<a id="历史验收入口"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%8E%86%E5%8F%B2%E9%AA%8C%E6%94%B6%E5%85%A5%E5%8F%A3)

<a id="早期阶段记录（2026-10-04-至-2026-10-11）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E6%97%A9%E6%9C%9F%E9%98%B6%E6%AE%B5%E8%AE%B0%E5%BD%95%EF%BC%882026-10-04-%E8%87%B3-2026-10-11%EF%BC%89)

<a id="1-产品结果与范围"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#1-%E4%BA%A7%E5%93%81%E7%BB%93%E6%9E%9C%E4%B8%8E%E8%8C%83%E5%9B%B4)

<a id="2-当前事实"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2-%E5%BD%93%E5%89%8D%E4%BA%8B%E5%AE%9E)

<a id="3-现有架构的设计约束"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#3-%E7%8E%B0%E6%9C%89%E6%9E%B6%E6%9E%84%E7%9A%84%E8%AE%BE%E8%AE%A1%E7%BA%A6%E6%9D%9F)

<a id="31-一次维护只有一个总体操作"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#31-%E4%B8%80%E6%AC%A1%E7%BB%B4%E6%8A%A4%E5%8F%AA%E6%9C%89%E4%B8%80%E4%B8%AA%E6%80%BB%E4%BD%93%E6%93%8D%E4%BD%9C)

<a id="32-实现归属与接口"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#32-%E5%AE%9E%E7%8E%B0%E5%BD%92%E5%B1%9E%E4%B8%8E%E6%8E%A5%E5%8F%A3)

<a id="33-权威事实与发现提示"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#33-%E6%9D%83%E5%A8%81%E4%BA%8B%E5%AE%9E%E4%B8%8E%E5%8F%91%E7%8E%B0%E6%8F%90%E7%A4%BA)

<a id="4-功能设计与可观察验收"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#4-%E5%8A%9F%E8%83%BD%E8%AE%BE%E8%AE%A1%E4%B8%8E%E5%8F%AF%E8%A7%82%E5%AF%9F%E9%AA%8C%E6%94%B6)

<a id="41-安装稳定性"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#41-%E5%AE%89%E8%A3%85%E7%A8%B3%E5%AE%9A%E6%80%A7)

<a id="42-更新、回滚与保留数据更换"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#42-%E6%9B%B4%E6%96%B0%E3%80%81%E5%9B%9E%E6%BB%9A%E4%B8%8E%E4%BF%9D%E7%95%99%E6%95%B0%E6%8D%AE%E6%9B%B4%E6%8D%A2)

<a id="43-网络与多分发点"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#43-%E7%BD%91%E7%BB%9C%E4%B8%8E%E5%A4%9A%E5%88%86%E5%8F%91%E7%82%B9)

<a id="44-完整故障证据与接收闭环"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#44-%E5%AE%8C%E6%95%B4%E6%95%85%E9%9A%9C%E8%AF%81%E6%8D%AE%E4%B8%8E%E6%8E%A5%E6%94%B6%E9%97%AD%E7%8E%AF)

<a id="45-引导、按钮与必要排版"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#45-%E5%BC%95%E5%AF%BC%E3%80%81%E6%8C%89%E9%92%AE%E4%B8%8E%E5%BF%85%E8%A6%81%E6%8E%92%E7%89%88)

<a id="5-分阶段执行与汇报"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#5-%E5%88%86%E9%98%B6%E6%AE%B5%E6%89%A7%E8%A1%8C%E4%B8%8E%E6%B1%87%E6%8A%A5)

<a id="s2-修订执行顺序与预期效果"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s2-%E4%BF%AE%E8%AE%A2%E6%89%A7%E8%A1%8C%E9%A1%BA%E5%BA%8F%E4%B8%8E%E9%A2%84%E6%9C%9F%E6%95%88%E6%9E%9C)

<a id="s3-客户端与隔离验证（2026-10-05）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s3-%E5%AE%A2%E6%88%B7%E7%AB%AF%E4%B8%8E%E9%9A%94%E7%A6%BB%E9%AA%8C%E8%AF%81%EF%BC%882026-10-05%EF%BC%89)

<a id="s4-安装、更新与容灾分析（2026-10-05）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s4-%E5%AE%89%E8%A3%85%E3%80%81%E6%9B%B4%E6%96%B0%E4%B8%8E%E5%AE%B9%E7%81%BE%E5%88%86%E6%9E%90%EF%BC%882026-10-05%EF%BC%89)

<a id="s4-实施与隔离检查记录（2026-10-05）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s4-%E5%AE%9E%E6%96%BD%E4%B8%8E%E9%9A%94%E7%A6%BB%E6%A3%80%E6%9F%A5%E8%AE%B0%E5%BD%95%EF%BC%882026-10-05%EF%BC%89)

<a id="s5-交互设计（2026-10-05，设计范围）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s5-%E4%BA%A4%E4%BA%92%E8%AE%BE%E8%AE%A1%EF%BC%882026-10-05%EF%BC%8C%E8%AE%BE%E8%AE%A1%E8%8C%83%E5%9B%B4%EF%BC%89)

<a id="s51-实施前的实现与设计收敛项"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s51-%E5%AE%9E%E6%96%BD%E5%89%8D%E7%9A%84%E5%AE%9E%E7%8E%B0%E4%B8%8E%E8%AE%BE%E8%AE%A1%E6%94%B6%E6%95%9B%E9%A1%B9)

<a id="s52-原界面的保留、合并、隐藏与移除"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s52-%E5%8E%9F%E7%95%8C%E9%9D%A2%E7%9A%84%E4%BF%9D%E7%95%99%E3%80%81%E5%90%88%E5%B9%B6%E3%80%81%E9%9A%90%E8%97%8F%E4%B8%8E%E7%A7%BB%E9%99%A4)

<a id="s53-页面信息与动作规则"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s53-%E9%A1%B5%E9%9D%A2%E4%BF%A1%E6%81%AF%E4%B8%8E%E5%8A%A8%E4%BD%9C%E8%A7%84%E5%88%99)

<a id="s54-进度、日志和版本查询"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s54-%E8%BF%9B%E5%BA%A6%E3%80%81%E6%97%A5%E5%BF%97%E5%92%8C%E7%89%88%E6%9C%AC%E6%9F%A5%E8%AF%A2)

<a id="s55-排版与实现边界"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s55-%E6%8E%92%E7%89%88%E4%B8%8E%E5%AE%9E%E7%8E%B0%E8%BE%B9%E7%95%8C)

<a id="s56-实施顺序、验收和阶段退出"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s56-%E5%AE%9E%E6%96%BD%E9%A1%BA%E5%BA%8F%E3%80%81%E9%AA%8C%E6%94%B6%E5%92%8C%E9%98%B6%E6%AE%B5%E9%80%80%E5%87%BA)

<a id="s57-实施记录（2026-10-05，技术验证通过，真实窗口待验）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#s57-%E5%AE%9E%E6%96%BD%E8%AE%B0%E5%BD%95%EF%BC%882026-10-05%EF%BC%8C%E6%8A%80%E6%9C%AF%E9%AA%8C%E8%AF%81%E9%80%9A%E8%BF%87%EF%BC%8C%E7%9C%9F%E5%AE%9E%E7%AA%97%E5%8F%A3%E5%BE%85%E9%AA%8C%EF%BC%89)

<a id="6-测试体系与运行约束"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#6-%E6%B5%8B%E8%AF%95%E4%BD%93%E7%B3%BB%E4%B8%8E%E8%BF%90%E8%A1%8C%E7%BA%A6%E6%9D%9F)

<a id="61-保留分层测试"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#61-%E4%BF%9D%E7%95%99%E5%88%86%E5%B1%82%E6%B5%8B%E8%AF%95)

<a id="62-环境与证据"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#62-%E7%8E%AF%E5%A2%83%E4%B8%8E%E8%AF%81%E6%8D%AE)

<a id="63-用户流程门槛"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#63-%E7%94%A8%E6%88%B7%E6%B5%81%E7%A8%8B%E9%97%A8%E6%A7%9B)

<a id="7-历史问题与结案"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#7-%E5%8E%86%E5%8F%B2%E9%97%AE%E9%A2%98%E4%B8%8E%E7%BB%93%E6%A1%88)

<a id="8-清理与资料维护"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#8-%E6%B8%85%E7%90%86%E4%B8%8E%E8%B5%84%E6%96%99%E7%BB%B4%E6%8A%A4)

<a id="9-当前阶段登记"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#9-%E5%BD%93%E5%89%8D%E9%98%B6%E6%AE%B5%E7%99%BB%E8%AE%B0)

<a id="91-s1-基线与接口审计结论"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#91-s1-%E5%9F%BA%E7%BA%BF%E4%B8%8E%E6%8E%A5%E5%8F%A3%E5%AE%A1%E8%AE%A1%E7%BB%93%E8%AE%BA)

<a id="92-本轮双平台完整测试包实测（2026-10-06）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#92-%E6%9C%AC%E8%BD%AE%E5%8F%8C%E5%B9%B3%E5%8F%B0%E5%AE%8C%E6%95%B4%E6%B5%8B%E8%AF%95%E5%8C%85%E5%AE%9E%E6%B5%8B%EF%BC%882026-10-06%EF%BC%89)

<a id="93-六项遗留问题按序收敛（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#93-%E5%85%AD%E9%A1%B9%E9%81%97%E7%95%99%E9%97%AE%E9%A2%98%E6%8C%89%E5%BA%8F%E6%94%B6%E6%95%9B%EF%BC%882026-10-08%EF%BC%89)

<a id="94-最新接收端错误与最终测试包核对（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#94-%E6%9C%80%E6%96%B0%E6%8E%A5%E6%94%B6%E7%AB%AF%E9%94%99%E8%AF%AF%E4%B8%8E%E6%9C%80%E7%BB%88%E6%B5%8B%E8%AF%95%E5%8C%85%E6%A0%B8%E5%AF%B9%EF%BC%882026-10-08%EF%BC%89)

<a id="95-慢启动误判修订与未结案清单（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#95-%E6%85%A2%E5%90%AF%E5%8A%A8%E8%AF%AF%E5%88%A4%E4%BF%AE%E8%AE%A2%E4%B8%8E%E6%9C%AA%E7%BB%93%E6%A1%88%E6%B8%85%E5%8D%95%EF%BC%882026-10-08%EF%BC%89)

<a id="96-全页面高度、滚动与操作可达性核验（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#96-%E5%85%A8%E9%A1%B5%E9%9D%A2%E9%AB%98%E5%BA%A6%E3%80%81%E6%BB%9A%E5%8A%A8%E4%B8%8E%E6%93%8D%E4%BD%9C%E5%8F%AF%E8%BE%BE%E6%80%A7%E6%A0%B8%E9%AA%8C%EF%BC%882026-10-08%EF%BC%89)

<a id="97-mac-故障闭环修订与实测（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#97-mac-%E6%95%85%E9%9A%9C%E9%97%AD%E7%8E%AF%E4%BF%AE%E8%AE%A2%E4%B8%8E%E5%AE%9E%E6%B5%8B%EF%BC%882026-10-08%EF%BC%89)

<a id="98-按钮点击、刷新和返回的布局稳定性（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#98-%E6%8C%89%E9%92%AE%E7%82%B9%E5%87%BB%E3%80%81%E5%88%B7%E6%96%B0%E5%92%8C%E8%BF%94%E5%9B%9E%E7%9A%84%E5%B8%83%E5%B1%80%E7%A8%B3%E5%AE%9A%E6%80%A7%EF%BC%882026-10-08%EF%BC%89)

<a id="99-codebase-mcp-全功能架构审查与更新查询修订（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#99-codebase-mcp-%E5%85%A8%E5%8A%9F%E8%83%BD%E6%9E%B6%E6%9E%84%E5%AE%A1%E6%9F%A5%E4%B8%8E%E6%9B%B4%E6%96%B0%E6%9F%A5%E8%AF%A2%E4%BF%AE%E8%AE%A2%EF%BC%882026-10-08%EF%BC%89)

<a id="910-多资源分发接入（2026-10-08，按最新确认修订）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#910-%E5%A4%9A%E8%B5%84%E6%BA%90%E5%88%86%E5%8F%91%E6%8E%A5%E5%85%A5%EF%BC%882026-10-08%EF%BC%8C%E6%8C%89%E6%9C%80%E6%96%B0%E7%A1%AE%E8%AE%A4%E4%BF%AE%E8%AE%A2%EF%BC%89)

<a id="911-合并后遗漏收敛（2026-10-08）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#911-%E5%90%88%E5%B9%B6%E5%90%8E%E9%81%97%E6%BC%8F%E6%94%B6%E6%95%9B%EF%BC%882026-10-08%EF%BC%89)

<a id="912-诊断入口补齐（2026-10-08，未发布）"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#912-%E8%AF%8A%E6%96%AD%E5%85%A5%E5%8F%A3%E8%A1%A5%E9%BD%90%EF%BC%882026-10-08%EF%BC%8C%E6%9C%AA%E5%8F%91%E5%B8%83%EF%BC%89)

<a id="release-pipeline-hardening-20261023"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#release-pipeline-hardening-20261023)

<a id="2026-10-23-发布流程集中收敛"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-23-%E5%8F%91%E5%B8%83%E6%B5%81%E7%A8%8B%E9%9B%86%E4%B8%AD%E6%94%B6%E6%95%9B)

<a id="本轮实现与验收结果"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E6%9C%AC%E8%BD%AE%E5%AE%9E%E7%8E%B0%E4%B8%8E%E9%AA%8C%E6%94%B6%E7%BB%93%E6%9E%9C)

<a id="合并前设计基线复核"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E5%90%88%E5%B9%B6%E5%89%8D%E8%AE%BE%E8%AE%A1%E5%9F%BA%E7%BA%BF%E5%A4%8D%E6%A0%B8)

<a id="release-stage-resume-20261023"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#release-stage-resume-20261023)

<a id="2026-10-23-同提交发布阶段续跑"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-23-%E5%90%8C%E6%8F%90%E4%BA%A4%E5%8F%91%E5%B8%83%E9%98%B6%E6%AE%B5%E7%BB%AD%E8%B7%91)

<a id="本轮实现、基线对照与实际结果"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E6%9C%AC%E8%BD%AE%E5%AE%9E%E7%8E%B0%E3%80%81%E5%9F%BA%E7%BA%BF%E5%AF%B9%E7%85%A7%E4%B8%8E%E5%AE%9E%E9%99%85%E7%BB%93%E6%9E%9C)

<a id="本地主线合并授权与核对"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#%E6%9C%AC%E5%9C%B0%E4%B8%BB%E7%BA%BF%E5%90%88%E5%B9%B6%E6%8E%88%E6%9D%83%E4%B8%8E%E6%A0%B8%E5%AF%B9)

<a id="2026-10-23-同提交三平台原生执行授权"></a>
[查看原阶段记录](reports/20261101-reliability-history.md#2026-10-23-%E5%90%8C%E6%8F%90%E4%BA%A4%E4%B8%89%E5%B9%B3%E5%8F%B0%E5%8E%9F%E7%94%9F%E6%89%A7%E8%A1%8C%E6%8E%88%E6%9D%83)
