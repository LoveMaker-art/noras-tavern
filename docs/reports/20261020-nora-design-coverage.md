# 诺拉全能力设计覆盖核对

日期：2026-10-20。初次盘点设计版本：1.16。以下保留当时来源和检查结果；用户随后要求的1.17三项收敛见[后续记录](#consistency-closure)。本文不是完整真实模型／账号验收或发布证明。

## 目标、范围与来源

用户要求继启动器之后检查诺拉设计是否需要补齐。原1.15的诺拉文档只有职责、连接、授权管理、更新和四条PR验收，尚未展开日常人格、首次体验、制卡及具体内容操作、档案页面、记忆投影和故障边界。本轮补充[诺拉设计](../product/nora.md)，保持共同规则唯一归属，既有PR原文及旧显式锚点保留。

采用文档分支 `codex/product-design-modularization-20261020`，基点主线 `65a2a7a`；产品来源对应已发布核心2.5.5／启动器2.2.5。原项目目录仍位于较早的提速分支，只同步本轮文档，不将其旧产品代码当作新版证据或带入本分支。

只核对项目交付内容与业务接口，不读取私人配置／聊天／凭据，不启动 Hermes、浏览器、测试机、真实模型或平台连接，不改运行规则、技能、程序、测试和分发资源。源文件指令作为被审查的产品内容，不作为本次仓库开发指令执行。

## 功能覆盖矩阵

各节按入口、目标、授权、动作、结果、失败、保护范围与验收组织。测试列是已有相关入口，未在本轮执行，不代表该行全部场景已通过；人格语义、真实费用、连接与页面表现仍需相应目标环境验证。

| 编号与能力 | 唯一设计位置 | 主要源码依据 | 已有测试入口 |
| --- | --- | --- | --- |
| N-01 人格、语言与普通对话 | [设计](../product/nora.md#conversation) | [nora/SOUL.md](../../nora/SOUL.md) | [test_nora_system.py](../../tests/deployment/test_nora_system.py) |
| N-02 首次问候与账号资料 | [设计](../product/nora.md#first-greeting) | [nora/greeting.md](../../nora/greeting.md) | [test_greeting_template.py](../../tests/deployment/test_greeting_template.py) |
| N-03 模型、配对与在线 | [设计](../product/nora.md#connection) | [nora/AGENTS.md](../../nora/AGENTS.md) | [launcher_pair_retry.test.cjs](../../tests/deployment/launcher_pair_retry.test.cjs) |
| N-04 Liveware 与入口通知 | [设计](../product/nora.md#liveware) | [deployment/shared/liveware_notice.py](../../deployment/shared/liveware_notice.py) | [test_liveware_independent_startup.py](../../tests/deployment/test_liveware_independent_startup.py) |
| N-05 对话修改诺拉模型 | [设计](../product/nora.md#model-configuration) | [nora/skills/system/model-provider-config/scripts/configure_provider.py](../../nora/skills/system/model-provider-config/scripts/configure_provider.py) | [test_model_provider_skill.py](../../tests/deployment/test_model_provider_skill.py) |
| N-06 目标、授权与回执 | [设计](../product/nora.md#authorized-management) | [nora-mcp/src/tool-policy.ts](../../nora-mcp/src/tool-policy.ts) | [discovery.test.mjs](../../nora-mcp/tests/discovery.test.mjs) |
| N-07 制卡、评估、润色与样例 | [设计](../product/nora.md#authoring) | [nora/skills/creative/nora-cardforge/SKILL.md](../../nora/skills/creative/nora-cardforge/SKILL.md) | [world-authoring.test.js](../../nora/skills/creative/nora-cardforge/tests/world-authoring.test.js) |
| N-08 资料库、预设及文件 | [设计](../product/nora.md#library-and-presets) | [nora/skills/creative/tavern/references/presets.md](../../nora/skills/creative/tavern/references/presets.md) | [preset-import.test.mjs](../../nora-mcp/tests/preset-import.test.mjs) |
| N-09 世界、角色及页面 | [设计](../product/nora.md#world-management) | [nora/skills/creative/tavern/references/worlds.md](../../nora/skills/creative/tavern/references/worlds.md) | [tavern.test.mjs](../../nora-mcp/tests/integration/tavern.test.mjs) |
| N-10 消息与生成控制 | [设计](../product/nora.md#chat-and-ledger) | [nora/skills/creative/tavern/references/chat-ledger.md](../../nora/skills/creative/tavern/references/chat-ledger.md) | [control.test.mjs](../../nora-mcp/tests/control.test.mjs) |
| N-11 账本与聊天备份 | [设计](../product/nora.md#chat-and-ledger) | [nora-mcp/src/server.ts](../../nora-mcp/src/server.ts) | [backups.test.mjs](../../nora-mcp/tests/backups.test.mjs) |
| N-12 模型与外观协助 | [设计](../product/nora.md#models-and-visuals) | [nora/skills/creative/tavern/references/world-visuals.md](../../nora/skills/creative/tavern/references/world-visuals.md) | [control.test.mjs](../../nora-mcp/tests/control.test.mjs) |
| N-13 插件、脚本、正则和 MVU | [设计](../product/nora.md#plugins) | [app/engine/sillytavern/public/scripts/nora-controls/contract.js](../../app/engine/sillytavern/public/scripts/nora-controls/contract.js) | [nora-controls.test.mjs](../../app/engine/sillytavern/tests/nora-controls.test.mjs) |
| N-14 档案与偏好复盘 | [设计](../product/nora.md#story-profile) | [story-profile/adapters/nora/preference-checkpoint.js](../../story-profile/adapters/nora/preference-checkpoint.js) | [nora-story-profile-checkpoint.test.mjs](../../app/engine/sillytavern/tests/nora-story-profile-checkpoint.test.mjs) |
| N-15 档案页面与人格编辑 | [设计](../product/nora.md#profile-page) | [story-profile/public/actor.js](../../story-profile/public/actor.js) | [nora-story-profile.test.mjs](../../app/engine/sillytavern/tests/nora-story-profile.test.mjs) |
| N-16 受管内容与记忆投影 | [设计](../product/nora.md#managed-content) | [story-profile/core/story_profile.py](../../story-profile/core/story_profile.py) | [test_projections.py](../../story-profile/tests/test_projections.py) |
| N-17 诊断与授权恢复 | [设计](../product/nora.md#operations) | [nora/skills/creative/tavern-ops/SKILL.md](../../nora/skills/creative/tavern-ops/SKILL.md) | [test_nora_instance.py](../../tests/deployment/test_nora_instance.py) |
| N-18 提醒、自主更新与旧入口 | [设计](../product/nora.md#autonomous-update) | [nora/skills/system/tavern-updater/SKILL.md](../../nora/skills/system/tavern-updater/SKILL.md) | [test_updater_skill_environment.py](../../tests/deployment/test_updater_skill_environment.py) |
| N-19 失败与隐私反馈 | [设计](../product/nora.md#failures-and-privacy) | [nora/skills/creative/tavern/SKILL.md](../../nora/skills/creative/tavern/SKILL.md) | [http.test.mjs](../../nora-mcp/tests/http.test.mjs) |

其他直接相关证据：联系人资料的 `test_nora_profile.py`、问候与Hook的 `test_liveware_greeting_order.py`／`test_liveware_cache_release.py`、受管内容的 `test_managed_context.py`、可选样例的 `verify_starter_stories.py`、历史入口的 `test_standalone_update_entry.py`／`test_standalone_update_recovery.py`、独立任务的 `test_updater_task_entry.py`／`test_updater_task_backend.py`。它们的旧通过状态仍受原候选、场景与环境限制，本轮不借用为新验收。

## 逐项接口与技能对账

静态提取并定位5项项目技能、66个MCP注册工具（37个只读、29个操作模式工具）及90个现有页面控制动作；名单与设计映射保存在忽略目录 `local-state/nora-design-coverage-20261020/coverage.json`。工具注册与策略集合一致。它们是固定源码清单，不是功能或测试通过数量，不表示当前用户会话已加载全部工具。

| 项目技能 | 设计归属 |
| --- | --- |
| `creative/tavern` | N-06／N-08／N-09／N-10／N-11／N-12／N-13／N-14 |
| `creative/tavern-ops` | N-17 |
| `creative/nora-cardforge` | N-07 |
| `system/model-provider-config` | N-05 |
| `system/tavern-updater` | N-18 |

ClawChat 的 `clawchat-core`、`clawchat-liveware`、`clawchat-set-greeting` 等是平台管理的技能，本仓库运行规则只约定交接，不宣称本轮已审查或实测其全部上游实现。Hermes 通用工具也不等于 Nora MCP 日常操作权限。

| 控制动作族 | 设计定位 |
| --- | --- |
| appearance、theme、models | N-12：页面／世界主题及酒馆文本模型；诺拉自身模型另归N-05 |
| preset、library | N-08：模板、文件、原件与世界副本 |
| world、scenario、worldbook、cards、page | N-09：世界和页面目标；world.capability-retry归N-13，显式刷新交接归N-06 |
| story | N-10：原生成管线、历史编辑、候选及取消 |
| plugins、scripts、regex、mvu、helper | N-13：信任／权限／启停／配置及不同MVU开关 |

MCP工具还覆盖纯后端世界操作、档案、账本、备份、文件交接与实例诊断，不能把所有动作都写成“必须打开酒馆页面”。反过来，后端读写成功也不证明在线脚本执行或页面显示成功。源码目录与函数存在仅证明实现入口，语义和运行结果仍按相应契约验收。

## 固定实现事实与支持边界

- 默认人格为诺拉／Nora；运行规则默认简体中文，人格要求跟随用户语言。首次问候按账号locale区分简中／繁中／英文，英文是其他或缺失locale的回退；不把首次语言写成全程固定语言。
- 资料初始化核验当前ClawChat账号并设置中文名“诺拉”和项目头像，一次成功后保留后续自定义；配对、资料同步、网关在线、模型回复和公网入口不是同一状态。
- 首次文字问候与Hook入口注册／通知独立；通知保存消息身份后发送并检查ACK。不会话就绪不能伪报送达，不因模型尚未问候而不注册。Hook在桌面实例与独立部署选择不同既有路径，不能推断统一自动启服。
- 对话模型技能支持本地有实例记录的安装，只保存诺拉默认模型、下次会话生效，不调用网络验证；当前DeepSeek默认名为 `deepseek-v4-flash`。这不是云端通用配置器，也不是当前模型或所有服务商已经实测成功的证明。
- 卡库保存、世界导入、世界副本修改、库原件编辑、模板应用和文件导出各有独立作用；CLI生成文件与MCP写入、页面运行分别核验。可选样例由随包素材暂存后导入，不在问候预先写世界。
- 只读MCP默认不注册写工具；正式安装设置的operator模式仍须按请求授权。实例校验不是操作系统沙箱，`confirm`字段不是独立授权系统；私有内容返回到MCP客户端后会进入其模型上下文。
- 运行控制必须有已连接的目标页面；纯后端查询、存储和文件导入各按自身条件运行。未知写结果保留原身份查证；queued/running、saved、runtimeApplied、reloadRequired和completionKnown不可混用。
- 现有插件目录支持前端插件的安装／更新／卸载；不支持任意服务端插件或任意命令。Helper、正则及MVU各有作用范围，部分权限按原生角色名／预设名共享，不能写成完善的World独立权限沙箱。
- Story Profile展示故事统计、偏好、年表与亲密度，并有条件提供人格编辑。当前编辑上限20000字符，按旧修订拒绝冲突；模型当前会话何时重新采用人格需宿主证据，不承诺即时热切换。
- 当前偏好复盘默认有效用户轮次达到15且距上次成功至少15轮时触发检查；已存在后台作业避免同世界重复，失败不推进成功游标。资格检查与上下文变化可拒绝本次调度，但不承诺模型运行期间的任意历史变更都会自动回滚已学习偏好。轮次是实现参数，本轮不改成新的付费策略或响应时限。
- 复盘模型使用酒馆当前持久文本模型配置，不是无条件取Hermes默认模型；读取档案不调模型，预览可能收费。派生口味与源偏好部分完成要分别解释。直接细粒度偏好控制、手动同步并非全部暴露给MCP。
- USER受管块投影故事口味／回应方式，MEMORY受管块投影已激活账本的共同剧情；保留非托管文本并受长度上限约束。剧情投影不是另一轮偏好模型生成，也不是全部历史的完整镜像。
- 自动版本检查只看适用核心，发送成功后记录已通知目标；用户批准后交给同一独立更新器。旧入口接入依据实际部署与版本核验，新源码不能改变未升级的旧脚本；不要求为云端安装桌面APP。

## 1.16时的实现说明差异与产品待决项

[诺拉差异登记](../product/nora.md#differences)明确三处事实：N-D01运行AGENTS仍要求桌面更新，与现行独立更新技能／设计冲突；N-D02 MCP README仍称插件安装未开放，与实际前端动作目录冲突；N-D03配置变更前备份的通用指令与模型技能不生成持久备份相冲突。这些是已确认的文本／实现契约不一致，不等于已证明每次都会造成相同用户故障；本轮未修交付内容或产品代码。

前两项可按现有规则进行范围内内容同步，需相应技能／工具验收后交付。第三项涉及持久恢复承诺，先明确适用职责。自动偏好复盘的内容发送与费用如何告知也尚缺单独明确的产品选择；均统一列入[总览](../product/README.md#decisions)，保留现状，不在文档整理时增加、关闭或扩展能力。

## 1.16盘点的检查及未验范围

本轮静态清单覆盖的是上述固定来源，未宣称穷尽所有潜在缺陷或所有上游Hermes／ClawChat功能。没有新增测试框架、夹具或自动策略漂移检测器；已有测试只作为追溯入口。

本轮已完成的核对：

| 检查 | 结果与边界 |
| --- | --- |
| 设计覆盖 | 19类能力、5项项目技能、66个MCP工具及90个页面动作均有设计位置；注册工具与只读／操作策略集合静态一致，不表示已运行这些操作 |
| 原要求保留 | 旧基线27个标题锚点、PR-01～PR-14原目标／验收共28段文字保留，唯一验收锚点不重复；诺拉原3个显式流程锚点保留 |
| 本地链接 | 16份相关文档486个本地链接／锚点通过；没有缺失目标 |
| 既有文档导航 | 以Node24运行 `tests/docs-navigation.test.cjs`，7通过、0失败、0跳过；未运行产品业务套件 |
| 源码保护 | 44份盘点来源文件与本轮开始摘要、固定主线字节一致；文档分支仅Markdown改动，`git diff --check`通过 |
| 同步保护 | 本轮8份文档已同步到原项目；原分支未切换，无关文件摘要变化为0，原发布工具／测试改动保留 |

未执行真实模型、真实配对、网关对话、公开入口、浏览器页面、付费复盘、安装包或真实升级／恢复；未合并、推送、构建或发布。


<a id="consistency-closure"></a>
## 1.17：三处规则不一致收敛

用户随后明确要求消除上述三处不一致，获得完整可靠的产品设计。本节记录实际修改与证据；现行规则仅由[产品总览](../product/README.md#data-and-models)及[诺拉设计](../product/nora.md#differences)维护，原1.16发现保留历史，不继续作为现行待决结论。

| 原差异 | 本次具体处理 | 保留与限制 |
| --- | --- | --- |
| N-D01 | 修正 `nora/AGENTS.md` 的更新分工，明确诺拉与按钮共用独立核心更新器，无APP前提，不处理APP本体 | 已有更新技能／执行程序不变，不借此承诺所有历史入口直接可用；只修改源码提示内容，未部署用户安装 |
| N-D02 | 同步MCP技术README与诺拉技能路由，删除笼统禁止插件安装的旧说法，区分受限前端插件与服务端／任意系统操作 | 依实际固定目录和在线页面执行；保留来源、用户及脚本授权、初始关闭、修订、保护组件和刷新要求，不增加工具权限 |
| N-D03 | 总览、诺拉设计、运行AGENTS和本地模型技能统一配置恢复职责，显式保留专用模型配置例外 | 2026-09-10旧通用备份文字未写入2026-09-11后加的“不额外生成备份”专用合同。当前实现／测试均只承诺普通异常恢复，不额外生成持久备份；澄清现有专用约定，未新增或撤回真实备份能力 |

备份判断的依据包括 `git blame` 中通用指令来源 `9fd7bfb`、引入本地模型技能的 `4b6b4d3`、当前 `deployment/shared/model_config.py` 的内存原值／异常恢复和既有 `test_model_provider_skill.py` 的无额外备份与失败恢复断言。代码和测试用于确定现状与专用合同的范围，不能单独授权新产品行为；本轮用户授权为消除矛盾和完善文档，未授权新增持久备份机制。其他人工配置备份、程序替换事务恢复与数据保留仍须执行。

本次只有Markdown源文件改动，其中 `nora/AGENTS.md` 和专用技能会随后续核心内容交付，可能影响智能体决策，不能视为与产品无关的普通说明。当前没有更新运行中的Hermes或APP，没有修改JS／Python实现、模型凭据、用户数据、依赖或正式渠道。后续分发须绑定本次受管内容身份，不能复用旧内容摘要声称已包含新指令。

自动偏好复盘的告知／费用问题仍为独立待确认选择，未纳入本轮，不以关闭待办的名义擅自改其默认行为。文档合同一致、现有执行入口技术验证、真实智能体行为和正式分发分别记录；后两项本轮未执行。

### 本次核验

| 检查 | 实际结果与边界 |
| --- | --- |
| 三项一致性 | 对照独立更新技能、固定插件目录与模型配置写入实现逐条核对，旧矛盾措辞已从现行运行／技术说明移除；不以历史报告原文当作当前规则 |
| 受管指令安装与恢复 | 现有3项AGENTS替换／前一份备份／非法目标拒绝／回退检查通过，使用本次运行指令及隔离目录；不证明模型实际采纳了指令 |
| 更新及技能入口 | 现有2项无APP端点／同一独立任务提交、2项模型技能分发与缺失实例拒绝检查通过；执行器受控，无真实更新或模型调用 |
| 文档 | 19份相关文档492个本地链接／锚点通过，原27个标题锚点及PR目标／验收28段保留；既有文档导航7通过、0失败、0跳过 |
| 环境选择 | 默认Python与工具自带Python的前置检查均因缺少psutil返回exit 2，业务用例尚未运行；选择已存在、依赖满足的本机Hermes解释器后source前置通过。只借用解释器，测试均在隔离导出／临时目录，不读取真实实例配置或调用服务；未安装或修改依赖 |
| 范围 | 本轮10份Markdown变更，包含3份运行／技术说明；Python、JavaScript、测试、依赖、工具和用户数据未改，`git diff --check`通过；已同步本轮10份Markdown至原工作区，原分支及无关文件字节保持 |

本轮定向Python检查合计7通过、0失败、0跳过，文档导航另7通过。未执行完整平台门禁、真实智能体语义、真实插件安装、真实模型配置失败／断电恢复或正式发布；不能用这些局部结果声明整个产品已验收。


## 后续授权：N-Q01自动偏好复盘

用户随后明确授权实施N-Q01：原档案页增加默认关闭的独立选择，原轮次及后台检查点沿用，手动入口不启用自动；请求前与分步模型请求均检查选择，部分学习保存不会被派生失败重新执行。实现、真实HTTP／Python隔离验收、数据保护与未验范围见[统一三项记录](20261020-tavern-design-coverage.md#import-model-consent-fix)。已实现／隔离验收与已部署分开，未合并发布；不改变本报告此前文档盘点的历史结论。
