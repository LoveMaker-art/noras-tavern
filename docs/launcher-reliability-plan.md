# 可靠性交付执行与证据导航

现行规则只在[产品设计1.45](product/README.md)及三份模块设计维护；本文件记录当前任务与证据导航。已完成迭代归入[截至2026-11-01的历史记录](reports/20261101-reliability-history.md)，原锚点继续可达。历史测试、未提交及未发布状态保留其原日期，不能直接当作当前状态。

## 当前源码与已知缺口

- 本轮开工基线为本地main e61a79c，已整合云端实例定位、无APP启停、跨语言写锁及旧事务准入修复；该历史合并本身不代表推送或部署；本轮核心Beta交付状态及证据见下文。
- 完整程序／用户数据回滚分离和现场归因继续登记为L-D07／L-D08；全新Linux首装、真实模型驱动MCP、外部认证及最终桌面安装器等缺口见[N-D04](product/nora.md#differences)。旧未验项不会因归档消失。

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
