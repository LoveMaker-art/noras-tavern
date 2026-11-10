# 架构演进与原始记录

当前目录和源码归属只在[仓库结构](../REPOSITORY.md)维护；产品规则只在[产品总览](../product/README.md)及其两份模块设计维护。本页解释架构为什么演进，不重复现行操作步骤或重新宣告历史验收通过。

## 演进脉络

| 阶段 | 变化及原因 | 持续维护的依据 | 原时点证据 |
| --- | --- | --- | --- |
| World Core建立 | 从卡/聊天的临时组合转向权威世界manifest，ST保留兼容执行；世界就绪与扩展能力分开 | [ADR0007](../adr/0007-make-world-manifest-authoritative.md)、[0008](../adr/0008-separate-world-readiness-from-capabilities.md)、[0009](../adr/0009-use-json-manifests-with-an-in-memory-index.md) | `73220ae:docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`及PHASE-0～7原记录 |
| UI与兼容执行分开 | UI消费世界读模型和命令，ST全局及DOM差异集中于Adapter；避免第二套生成生命周期 | [ADR0003](../adr/0003-isolate-st-compatibility.md)、[0004](../adr/0004-split-nora-ui-workflows.md)、[兼容机器合同](ST-COMPATIBILITY-INTERFACE-MANIFEST.json) | `73220ae:docs/architecture/ST-INTERACTION-AUDIT-2026-08-30.md`；同修订复杂卡矩阵记录其当时未验范围 |
| Python到Node及档案同仓 | 替换旧在线应用；Story Profile保留唯一作者源，发布时生成可核验快照 | [ADR0002](../adr/0002-single-node-runtime.md)、[0006](../adr/0006-own-core-startup-and-use-immutable-critical-assets.md)、[模块开发](../../story-profile/README.md) | [Python→Node迁移原记录](PYTHON-TO-NODE-MIGRATION-20260831.md)、`73220ae:docs/architecture/MONOREPO-RELEASE-20260831.md` |
| 安装身份与进程观察分开 | PID和内核坐标只证明一次观察，不能当作跨容器/重启的持久安装身份 | [ADR0012](../adr/0012-separate-runtime-ownership-from-process-instance.md) | `73220ae:docs/architecture/UPDATER-EXISTING-INSTANCE-20260910.md` |
| 程序维护与用户内容分开 | 程序替换、旧数据转换、内容恢复采用不同合同；普通程序回退不回滚当前故事 | [ADR0013](../adr/0013-snapshot-replaceable-code-at-maintenance.md)、[0014](../adr/0014-repair-derived-operational-state.md)、[核心维护](../core-maintenance.md) | `73220ae:docs/design/storage-lifecycle-refactor-plan.md`；其追加的失败/部分实施记录仍按原时点保留 |
| 世界资源副本独立 | 库原件与各世界运行副本分开；旧共享绑定在用户写入时保护，不自动迁移已有世界 | [隔离实现](../design/world-data-isolation.md)、[ADR0010](../adr/0010-create-blank-worlds-through-world-core.md)、[0011](../adr/0011-world-owned-cast-for-python-data.md) | `73220ae:docs/design/library-workflow.md`、`73220ae:docs/design/world-data-isolation.md` |
| MCP与后台记忆收敛 | MCP复用领域业务；偏好、剧情账本及只读年表分工，剧情按需读取，不常驻MEMORY | [MCP接口](../../nora-mcp/README.md)、[档案作者接口](../../story-profile/README.md)、[诺拉设计](../product/nora.md#story-profile) | `73220ae:nora-mcp/docs/IMPLEMENTATION-20260830.md`、`73220ae:docs/reports/20261021-story-profile-baseline-confirmation.md`、同修订档案JSON证据 |
| 核心/桌面作者分仓 | 桌面与共同维护实现独立维护，核心消费固定输入；作者分离不自动解决已有产品缺陷 | [源码归属](../REPOSITORY.md#shared-implementation-boundaries)、[核心维护](../core-maintenance.md) | `73220ae:docs/reports/20261110-core-documentation-structure.md`；本轮源码返修整合状态不由旧报告替代 |

## 直接可读的历史依据

历史保留按内容价值判断：包含重要故障根因、不可替代的架构/数据转换理由，或仍为当前产品承诺提供独立验收依据的原记录，应能从这里直接打开。旧日期或已有Git副本都不是移除它的充分理由。重复规则、被取代的草稿与逐次构建流水不因此全部恢复。

### 架构与故障复盘

| 记录 | 保留的独立信息 |
| --- | --- |
| [Python→Node迁移](PYTHON-TO-NODE-MIGRATION-20260831.md) | 旧数据承载映射、程序替换/转换边界与当时未支持范围；不是当前目录地图 |
| [Linux历史升级与失败回退](../reports/20261016-linux-historical-update-acceptance.md) | 原始2.x真实更新、启动失败后恢复，以及“1.x不兼容”和“未实测”的区别 |
| [云端目录权限误拒](../reports/20261019-cloud-update-permission-repair.md) | 额外权限准入错误拒绝合法02770组写目录；候选验证与后续正式交付分别记录 |
| [诺拉能力覆盖核对](../reports/20261020-nora-design-coverage.md) | 规则冲突、接口/技能对账及当时修正和未验范围，是当前设计的历史依据 |
| [酒馆能力覆盖与反例](../reports/20261020-tavern-design-coverage.md) | 创建结果不明、删除保护不等效的反例和修复，以及批准/撤回的原始过程 |
| [档案整合与Windows锁冲突](../reports/20261021-story-profile-main-integration.md) | 真实WinError5共享删除句柄实验、错误被包装掩盖、有界重试和数据保护证明 |
| [2.6.4验收/发布复盘](../reports/20261102-v2.6.4-release-preparation.md) | 产品、测试工具与汇总故障的区分；同批制品复验发布，不把原失败run改写成通过 |

### 互补的验收证据

以下JSON保持原字节、原源码指纹和原结果。它们分别保护不同阶段/条件，不是同一结果的副本，也不证明今天所有平台通过。

| 证据 | 不可替代的范围 |
| --- | --- |
| [Linux旧版升级原始摘要](../reports/20261016-linux-historical-update-evidence.json) | 对应复盘中的资产、目标及四个旧版实验身份 |
| [偏好链可靠性](../verification/story-profile-reliability-20261021.json) | 初始链路的模型、关闭/恢复、持久化和剩余限制 |
| [默认开启及旧选择保留](../verification/story-profile-default-on-20261021.json) | 后续默认政策变化的独立验证，不能用早期默认政策的通过代替 |
| [合并前审查发现](../verification/story-profile-premerge-design-review-20261021.json) | 原始负向发现及更正依据，不能只留下之后的通过 |
| [审查后修复](../verification/story-profile-postreview-fixes-20261021.json) | 对上述发现的Mac/Windows源码与本地HTTP修复验证，未扩大为安装器或模型语义验收 |
| [偏好与剧情记忆分工](../verification/story-profile-plot-memory-flow-20261021.json) | 当前模块引用的USER/账本/MEMORY流程和失败保护 |
| [最终档案整合](../verification/story-profile-main-integration-20261021.json) | 最终冻结来源、Windows实测与实际合并身份，区别于合并前的验证 |

产品模块化和1.31基线确认的旧全文继续留在`73220ae:docs/reports/20261020-product-design-modularization.md`及`73220ae:docs/reports/20261021-story-profile-baseline-confirmation.md`：其核心演进是从平行基线改为按职责维护唯一规则，以及把用户偏好、故事进展和年表分开。现行规则已在产品设计承接，独立验收由上表记录；无需把旧规则表再复制为第二套当前依据。

旧World Core长计划仍保留原始来源。现行选择已由ADR承接；历史Phase 1只证明无浏览器的核心，并未接通导入、HTTP和页面。不能用当时核心用例通过推断整条用户流程通过，后续阶段记录按其原范围追溯。

<a id="如何读取原始证据"></a>
## 如何读取更细的原始过程

未按上述标准直接保留的旧草稿、细粒度阶段评审、逐次构建流水及冻结生成索引，仍可从固定修订`73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b`追溯。它们未被认定为“所有内容都重复”；只是日常阅读所需的决策、重要故障和承诺依据已由现行文档及上表的重点历史承接，无需继续逐份维护。

```sh
git show 73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b:docs/architecture/PHASE-1-EXECUTION-REVIEW.md
git ls-tree -r --name-only 73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b -- docs
```

原文中的源码/制品指纹、分支、日期、失败、跳过、未发布与未验范围均保留，不改成当前通过。`commit:path#anchor`中的锚点用于原文内定位；运行git show时去掉锚点。引用本地Git对象不表示它已经公开推送；浅克隆缺少原对象时应取得对应历史，不用当前代码伪造旧证据。

冻结的旧project-index只是一份历史快照。当前索引由`node tooling/checks/index-project.mjs`写入忽略的`.codebase-memory/project-index.json`，不再将生成索引复制进文档仓。仍被测试读取的兼容JSON保留原路径与原字节，不按扩展名批量删除。
