# 核心文件结构、文档分类与拆分对照

盘点日期：2026-11-10。统计基线为本地 main `ab3e0487e207d4d55fb043b8a85f1eda004c5e69`。本轮文档整理位于独立分支 `codex/core-documentation-structure-20261110`，不表示已经合并或发布。

本报告是结构盘点和导航，不新增产品规则，也不宣称产品缺陷已修复。现行权威入口为[产品总览](../product/README.md)、[诺拉设计](../product/nora.md)、[酒馆设计](../product/tavern.md)。

## 1. 结论与统计口径

- 当前 main：**1921 个 Git 跟踪文件**；`docs/` **208 项，其中184份Markdown、21份JSON、3张图片**。
- 本文档分支：**1925 个交付候选文件**；`docs/` **212 项，其中188份Markdown、21份JSON、3张图片**。新增为3份恢复的核心ADR和本汇总；不删除原历史证据。
- 全仓Markdown基线共244份，其中34份在`nora/`，含运行指令/技能，不能全部当成待清理的开发文档；本轮候选共248份。
- 统计不扫描`.git`、缓存、安装依赖、构建包、私有证据或用户数据；目录文件数不等于测试用例数、Bug数或安全证明。
- 源码主体已经分仓；当前main尚缺已验收拆分返修`3e8d814`。本轮只整理文档，不将那次源码返修或7项旧运行缺陷混入文档完成度。

## 2. 当前main文件结构

| 路径 | 文件数 | 职责 |
| --- | ---: | --- |
| `[root files]` | 11 | 项目首页、开发规则、领域语言、工具与依赖锁 |
| `.github` | 3 | 核心 CI、构造和发布工作流；当前3个入口均为core工作流 |
| `app` | 1352 | 酒馆前后端、原生适配、扩展与档案运行快照 |
| `deployment` | 45 | 核心首装、更新/恢复、模型、实例及服务实现 |
| `nora` | 86 | 交付给Hermes的人格、运行指引、技能和Hook |
| `nora-mcp` | 25 | MCP源码、包配置和所属测试 |
| `story-profile` | 24 | 故事档案唯一手写源码与所属测试 |
| `tests` | 104 | 根级和核心部署测试；不是全仓所有测试的数量 |
| `tooling` | 62 | 固定输入、源码投影、构造和验证工具 |
| `docs` | 208 | 核心产品、操作、技术规则和保留证据 |
| `local-state` | 1 | 仅README受管；其余本地证据/运行数据被忽略 |

主要目录展开：

```text
core/
├── app/
│   ├── engine/sillytavern/    # 引擎、产品界面、适配与所属测试
│   ├── native-extensions/    # 内置扩展
│   └── story_profile_runtime/# 从story-profile生成的运行快照
├── nora/                    # 人格、运行指引、技能、Hook
├── nora-mcp/                # MCP工具与所属测试
├── story-profile/           # 档案作者源码
├── deployment/
│   ├── install/             # 核心首装
│   ├── update/              # 核心更新与恢复
│   ├── shared/              # 核心模型、实例、服务、Liveware
│   └── runtime/             # 无桌面运行与技能准备
├── tooling/                 # 固定外部输入、投影、构造、检查
├── tests/                   # 根级与部署验证
├── docs/                    # 下节分类
└── local-state/             # 仅README入Git，其余本地保留
```

**作者源码、生成副本和依赖须分开：**

- `story-profile/`是档案源码；`app/story_profile_runtime/`是生成运行快照，不能双处编辑。
- `tooling/maintenance-input.lock.json`固定共享维护输入，`tooling/source-layout.json`保留旧交付路径；历史`ops/installer/desktop/`路径本身不是桌面作者源码残留。
- 独立启动器仓有自己的Git，当前核对为`d127b195`、422个跟踪文件；不需要把其档案复制回来才能维护核心。
- 核心进程、模型、安装和更新仍是核心职责；不因桌面也调用而误迁。

## 3. 文档分类和阅读顺序

| 分类目录 | main项数 | 本轮候选项数 | 用途与保留理由 |
| --- | ---: | ---: | --- |
| `docs/[root]` | 13 | 13 | 当前入口、核心指南、兼容导航及少量旧记录 |
| `docs/product` | 6 | 6 | 现行规则、变更模板、兼容导航和旧版归档 |
| `docs/adr` | 12 | 15 | 架构决策及取代关系；恢复核心适用0012～0014 |
| `docs/architecture` | 49 | 49 | 历史架构/阶段评审、兼容参考和结构化清单 |
| `docs/design` | 8 | 8 | 技术方案与适用范围，不另立产品规则 |
| `docs/releases` | 63 | 63 | 历史批次说明，不自动证明已发布或当前可用 |
| `docs/reports` | 30 | 31 | 实施/故障/验收记录及本次结构盘点 |
| `docs/verification` | 24 | 24 | 验证快照与仍被现行产品引用的安全合同 |
| `docs/images` | 3 | 3 | 文档图片资源 |

实际使用时按目的阅读：

1. 用户操作：根README → 安装/更新指南；不让用户从旧报告寻找当前入口。
2. 产品规则：产品总览与诺拉/酒馆两份模块设计；requirements和product-baseline仅兼容导航。
3. 实现依据：领域语言、仓库职责、相关ADR与技术设计；方案不等于实现，历史验收不等于当前验收。
4. 开发/构造：CONTRIBUTING、core-maintenance、release-process及实际固定输入。
5. 历史取证：architecture、reports、verification、releases，核对原日期、源码、环境和结果。

根目录仍有三份历史记录：`ledger-runtime-design-20260930.md`、`local-main-integration-verification.md`、`startup-followup-20260924.md`；本轮列明其历史身份并保留原路径，避免无收益搬动产生新引用变更。`liveware-first-greeting-order.md`是技术说明，其旧测试命令已修正。

## 4. 本轮实际整理内容

- 当前安装指南去除桌面操作引导，统一指向核心安装/更新；源码安装步骤本身保留。
- 修正报告、架构、设计、版本及验证索引；桌面专属活动入口移除，混合历史保留固定Git来源。
- 将38处指向迁出文件的失效文件链接改为原修订引用；另修正恢复ADR内2处旧产品文档引用。历史目标均用Git对象验证，未假定本地提交已经公开在GitHub。
- 恢复3份核心ADR，补充来源和适用范围；原有时点的实现缺口、失败、未验和数据保护约定不重写。
- 删除一条调用已迁出测试的现行回归命令，保留实际存在的同主题测试入口；不冒用尚未合并的测试文件。
- 补齐总文档分类索引与本报告逐文件目录；产品总览中残留的模块数量改为两份核心模块，仅改描述，不改需求。

本轮没有修改产品代码、测试实现、运行技能、锁单或CI；没有合入拆分返修。文档文件/锚点检查只能证明导航与文本一致性，不能代替安装、更新或模型实机验收。

## 5. 35份迁出文档的归属对照

迁出差异按`09b9895 → ab3e048`计算。3份核心ADR恢复适用正文；其余32份不恢复为核心活动指南。混合历史中的核心规则由当前设计、core-maintenance及ADR维护，旧文保留原修订，不复制成第二套当前规则。

独立启动器仓的冻结归档位置为`docs/archive/core-origin-09b9895/<原路径>`。本轮逐文件比较了归档与原Git正文，**35/35字节一致**。

本地可执行`git show 09b9895:docs/原文件.md`读取原文；`#锚点`是原文内定位，执行git show时去掉锚点。该引用不表示已推送或当前仍适用。

| 原核心仓路径 | 归属与处理 | 冻结原文 |
| --- | --- | --- |
| `docs/adr/0012-separate-runtime-ownership-from-process-instance.md` | 核心ADR恢复适用正文 | 已核字节一致 |
| `docs/adr/0013-snapshot-replaceable-code-at-maintenance.md` | 核心ADR恢复适用正文 | 已核字节一致 |
| `docs/adr/0014-repair-derived-operational-state.md` | 核心ADR恢复适用正文 | 已核字节一致 |
| `docs/architecture/NORA-TAVERN-LAUNCHER-OPTIMIZATION-PLAN.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/design/update-release-alignment.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/launcher-beta-acceptance.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/launcher-beta-testing.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/launcher-install-diagnostics.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/launcher-managed-files.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/launcher-reliability-plan.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/launcher-unified-update.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/launcher-uninstall.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/product/launcher.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/releases/launcher-test-lifecycle-20260918-1.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/releases/v2.2.11.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/releases/v2.5.3.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/releases/v2.5.7.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261016-shared-independent-updater-acceptance.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261018-app-only-publication-acceptance.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/reports/20261018-official-old-update-acceptance.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261019-dual-update-contract-fix.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261019-retained-data-copy-fix.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261020-launcher-concentrated-errors-bug-analysis.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/reports/20261020-launcher-design-coverage.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/reports/20261022-launcher-regression-audit.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/reports/20261028-hermes-model-reuse.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261029-hermes-configuration-field-audit.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/reports/20261101-reliability-history.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/updater-ownership-contract.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |
| `docs/verification/launcher-product-convergence.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/verification/launcher-source-cleanup-20261013.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/verification/launcher-stability.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/verification/launcher-test-cleanup.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/verification/launcher-uninstall.md` | 桌面主体/共同维护作者材料，保留归档 | 已核字节一致 |
| `docs/verification/v2.5.0-github-diff.md` | 混合历史记录，核心规则另由当前文档维护 | 已核字节一致 |

## 6. 保留、合并、删除的边界

| 对象 | 本轮处理 | 原因 |
| --- | --- | --- |
| 现行核心产品规则与操作说明 | 保留并修导航 | 继续约束核心产品和维护 |
| 桌面专属活动入口 | 从核心索引移除 | 独立仓维护，避免核心用户走错入口 |
| 仍适用核心ADR | 恢复并限定范围 | 桌面迁出不取消核心运行/维护规则 |
| 混合历史、失败和验收原文 | 原文不重写；来源固定 | 保留因果与当时证明范围 |
| 重复的入口解释 | 归并至现有README/REPOSITORY | 不再建立平行产品规则 |
| 人格、技能、Hook、内置内容 | 完全保留 | 它们是产品运行输入 |
| 用户数据、本地凭据、日志、缓存 | 不扫描、不纳入报告清单 | 不属于Git源码文档交付 |

本轮没有删除现有文档文件；清理的是过期导航，恢复的是误迁核心规则。是否进一步压缩某份长历史记录，应在等价证据和来源已保留后另作选择，不能用删文件数量衡量清理完成。

## 7. 文档逐文件清单

以下列出本文档候选中`docs/`的全部212项，标题为文件首个一级标题（JSON/图片按类型标注）。目录分类是用途说明，不代表其中每个历史结论都适用于当前main。

### docs/[root]

| 文件 | 标题/内容 |
| --- | --- |
| [README.md](../README.md) | 核心文档索引 |
| [REPOSITORY.md](../REPOSITORY.md) | 核心仓导航 |
| [core-maintenance.md](../core-maintenance.md) | 核心维护合同 |
| [install-nora-tavern.md](../install-nora-tavern.md) | 安装诺拉与酒馆核心 |
| [install-tavern.md](../install-tavern.md) | 只安装 Tavern（源码方式） |
| [ledger-runtime-design-20260930.md](../ledger-runtime-design-20260930.md) | 剧情账本运行治理设计 |
| [liveware-first-greeting-order.md](../liveware-first-greeting-order.md) | Independent Greeting and Liveware Startup |
| [local-main-integration-verification.md](../local-main-integration-verification.md) | Local Main Integration Verification |
| [product-baseline.md](../product-baseline.md) | 产品设计基线兼容入口 |
| [release-process.md](../release-process.md) | 核心构建与交付 |
| [startup-followup-20260924.md](../startup-followup-20260924.md) | Startup follow-up audit |
| [update-nora-tavern.md](../update-nora-tavern.md) | 核心更新与恢复 |
| [update-standalone-tavern.md](../update-standalone-tavern.md) | 独立核心更新与旧版本接入 |

### docs/product

| 文件 | 标题/内容 |
| --- | --- |
| [README.md](../product/README.md) | 诺拉酒馆核心产品设计：总览与共同约定 |
| [20261019-update-release-design.md](../product/archive/20261019-update-release-design.md) | 更新与发布产品设计 |
| [change-request-template.md](../product/change-request-template.md) | 产品需求变更模板 |
| [nora.md](../product/nora.md) | 诺拉产品设计 |
| [requirements.md](../product/requirements.md) | 产品需求与验收索引 |
| [tavern.md](../product/tavern.md) | 酒馆产品设计 |

### docs/adr

| 文件 | 标题/内容 |
| --- | --- |
| [0001-store-world-identity-with-chat.md](../adr/0001-store-world-identity-with-chat.md) | ADR 0001: Store World Identity With The Chat |
| [0002-single-node-runtime.md](../adr/0002-single-node-runtime.md) | ADR 0002: Single Node Runtime |
| [0003-isolate-st-compatibility.md](../adr/0003-isolate-st-compatibility.md) | ADR 0003: Isolate The ST Compatibility Boundary |
| [0004-split-nora-ui-workflows.md](../adr/0004-split-nora-ui-workflows.md) | ADR 0004: Split Nora UI Workflows Into Deep Modules |
| [0005-separate-product-brand-from-compatibility-identity.md](../adr/0005-separate-product-brand-from-compatibility-identity.md) | ADR 0005: Separate Product Brand from Compatibility Identity |
| [0006-own-core-startup-and-use-immutable-critical-assets.md](../adr/0006-own-core-startup-and-use-immutable-critical-assets.md) | ADR 0006: Own Core Startup and Use Immutable Critical Assets |
| [0007-make-world-manifest-authoritative.md](../adr/0007-make-world-manifest-authoritative.md) | Make The World Manifest Authoritative |
| [0008-separate-world-readiness-from-capabilities.md](../adr/0008-separate-world-readiness-from-capabilities.md) | Separate World Readiness From Capability Readiness |
| [0009-use-json-manifests-with-an-in-memory-index.md](../adr/0009-use-json-manifests-with-an-in-memory-index.md) | Use Atomic JSON Manifests With An In-Memory Index |
| [0010-create-blank-worlds-through-world-core.md](../adr/0010-create-blank-worlds-through-world-core.md) | Create Blank Worlds Through World Core |
| [0011-world-owned-cast-for-python-data.md](../adr/0011-world-owned-cast-for-python-data.md) | Preserve Python story identities in a World-owned cast |
| [0012-separate-runtime-ownership-from-process-instance.md](../adr/0012-separate-runtime-ownership-from-process-instance.md) | ADR 0012: Separate Runtime Ownership from Process Instance Identity |
| [0013-snapshot-replaceable-code-at-maintenance.md](../adr/0013-snapshot-replaceable-code-at-maintenance.md) | ADR 0013: Snapshot Replaceable Code at Maintenance |
| [0014-repair-derived-operational-state.md](../adr/0014-repair-derived-operational-state.md) | ADR 0014: Repair Derived Operational State Instead of Treating It as Authority |
| [README.md](../adr/README.md) | 架构决策索引 |

### docs/architecture

| 文件 | 标题/内容 |
| --- | --- |
| [COMPLEX-CARD-COMPATIBILITY-MATRIX.md](../architecture/COMPLEX-CARD-COMPATIBILITY-MATRIX.md) | Nora Tavern Complex Card Compatibility Matrix |
| [HERMES-SKILL-CONFORMANCE-EVIDENCE-20260830.md](../architecture/HERMES-SKILL-CONFORMANCE-EVIDENCE-20260830.md) | Hermes Skill 官方规范证据（2026-08-30） |
| [INDEX-COVERAGE.md](../architecture/INDEX-COVERAGE.md) | Tavern Index Coverage |
| [MONOREPO-RELEASE-20260831.md](../architecture/MONOREPO-RELEASE-20260831.md) | Tavern + Story Profile 同仓候选发布审查 |
| [NORA-MCP-HERMES-DEPLOYMENT-20260830.md](../architecture/NORA-MCP-HERMES-DEPLOYMENT-20260830.md) | Nora MCP 接入 Hermes：远端部署记录 |
| [NORA-MCP-PANEL-PARITY-20260831.md](../architecture/NORA-MCP-PANEL-PARITY-20260831.md) | Nora MCP：右侧基础能力补齐与前端边界 |
| [NORA-MCP-RUNTIME-CONTROLS-20260830.md](../architecture/NORA-MCP-RUNTIME-CONTROLS-20260830.md) | Nora MCP 0.3：现有插件运行控制 |
| [NORA-MCP-SKILL-INTEGRATION-20260830.md](../architecture/NORA-MCP-SKILL-INTEGRATION-20260830.md) | Nora MCP 接入与技能收敛评估 |
| [NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md](../architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md) | Nora Tavern World Core 完整重构计划 |
| [PHASE-0-EXECUTION-REVIEW.md](../architecture/PHASE-0-EXECUTION-REVIEW.md) | Phase 0 Execution Review |
| [PHASE-0-RUNTIME-BASELINE.md](../architecture/PHASE-0-RUNTIME-BASELINE.md) | Phase 0 Runtime Baseline |
| [PHASE-1-EXECUTION-REVIEW.md](../architecture/PHASE-1-EXECUTION-REVIEW.md) | Phase 1 Execution Review |
| [PHASE-2-EXECUTION-REVIEW.md](../architecture/PHASE-2-EXECUTION-REVIEW.md) | Phase 2 Execution Review |
| [PHASE-3-EXECUTION-REVIEW.md](../architecture/PHASE-3-EXECUTION-REVIEW.md) | Phase 3 Execution Review |
| [PHASE-4-EXECUTION-REVIEW.md](../architecture/PHASE-4-EXECUTION-REVIEW.md) | Phase 4 Execution Review |
| [PHASE-5-EXECUTION-REVIEW.md](../architecture/PHASE-5-EXECUTION-REVIEW.md) | Phase 5 Execution Review |
| [PHASE-6-EXECUTION-REVIEW.md](../architecture/PHASE-6-EXECUTION-REVIEW.md) | Phase 6 Execution Review |
| [PHASE-7-PREFLIGHT-REVIEW.md](../architecture/PHASE-7-PREFLIGHT-REVIEW.md) | Phase 7 Preflight Review |
| [PROJECT-ARCHITECTURE.md](../architecture/PROJECT-ARCHITECTURE.md) | Nora Tavern Architecture Snapshot |
| [PYTHON-TO-NODE-MIGRATION-20260831.md](../architecture/PYTHON-TO-NODE-MIGRATION-20260831.md) | 原 Python 酒馆 → Node Tavern：实现与验收 |
| [README.md](../architecture/README.md) | 历史架构与兼容资料 |
| [RELEASE-HARDENING-2026-08-30.md](../architecture/RELEASE-HARDENING-2026-08-30.md) | Tavern 发布收口执行记录 |
| [ST-COMPATIBILITY-INTERFACE-MANIFEST.json](../architecture/ST-COMPATIBILITY-INTERFACE-MANIFEST.json) | 结构化清单或验证证据（JSON） |
| [ST-INTERACTION-AUDIT-2026-08-30.md](../architecture/ST-INTERACTION-AUDIT-2026-08-30.md) | ST／复杂卡交互适配审计：远端版本 cd7cf216e868460f |
| [ST-INTERACTION-INVENTORY-2026-08-30.json](../architecture/ST-INTERACTION-INVENTORY-2026-08-30.json) | 结构化清单或验证证据（JSON） |
| [ST-INTERACTION-REPAIR-STATUS-2026-08-30.md](../architecture/ST-INTERACTION-REPAIR-STATUS-2026-08-30.md) | 交互链路修复状态：已技术验证并部署，待实际页面验收 |
| [STORY-PROFILE-CLEANUP-20260831.md](../architecture/STORY-PROFILE-CLEANUP-20260831.md) | Tavern / Story Profile 定向收敛记录 |
| [TAVERN-BILINGUAL-LOCAL-IMPLEMENTATION.md](../architecture/TAVERN-BILINGUAL-LOCAL-IMPLEMENTATION.md) | Nora 固定文案与 ST 翻译接口：本地交付记录 |
| [TAVERN-CLAWCHAT-BILINGUAL-P0.md](../architecture/TAVERN-CLAWCHAT-BILINGUAL-P0.md) | 双语化 P0 执行记录 |
| [TAVERN-CLAWCHAT-BILINGUAL-PLAN.md](../architecture/TAVERN-CLAWCHAT-BILINGUAL-PLAN.md) | Tavern 固定系统文案双语化与 ClawChat 语言跟随计划 |
| [TAVERN-RELEASE-AUDIT-2026-08-30.json](../architecture/TAVERN-RELEASE-AUDIT-2026-08-30.json) | 结构化清单或验证证据（JSON） |
| [TAVERN-RELEASE-AUDIT-2026-08-30.md](../architecture/TAVERN-RELEASE-AUDIT-2026-08-30.md) | Tavern 架构、冗余与发布就绪审计 |
| [TAVERN-STORY-LEDGER-LOCAL-30-ROUNDS.md](../architecture/TAVERN-STORY-LEDGER-LOCAL-30-ROUNDS.md) | 剧情账本：本地真实 30 轮验证 |
| [TAVERN-STORY-LEDGER-PLUGIN.md](../architecture/TAVERN-STORY-LEDGER-PLUGIN.md) | 剧情账本插件：实现与交付边界 |
| [TAVERN-STORY-PROFILE-LEDGER-PROJECTION.md](../architecture/TAVERN-STORY-PROFILE-LEDGER-PROJECTION.md) | 剧情账本 → Story Profile → Hermes 记忆投影 |
| [UNIFIED-UPDATE-20260910.md](../architecture/UNIFIED-UPDATE-20260910.md) | 统一更新流程（2026-09-10 历史设计） |
| [UPDATER-ACTIVATION-LOCAL-VERIFICATION-20260831.md](../architecture/UPDATER-ACTIVATION-LOCAL-VERIFICATION-20260831.md) | Owner-confirmed updater activation — local verification |
| [UPDATER-EXISTING-INSTANCE-20260910.md](../architecture/UPDATER-EXISTING-INSTANCE-20260910.md) | Existing-Instance Update Safety |
| [UPDATER-IMPLEMENTATION-20260831.md](../architecture/UPDATER-IMPLEMENTATION-20260831.md) | Updater implementation — local verification, not a production release |
| [UPDATER-ISOLATED-REHEARSAL-20260831.md](../architecture/UPDATER-ISOLATED-REHEARSAL-20260831.md) | 更新器整目录与数据迁移：隔离演练 |
| [UPDATER-NONBLOCKING-DATA-IMPORT-20260901.md](../architecture/UPDATER-NONBLOCKING-DATA-IMPORT-20260901.md) | 更新器：程序升级与 Python 数据导入分开判定 |
| [UPDATER-SAFETY-20260831.md](../architecture/UPDATER-SAFETY-20260831.md) | 更新器安全修正与未完成边界 |
| [WORKSTREAM-B-EXECUTION-REVIEW.md](../architecture/WORKSTREAM-B-EXECUTION-REVIEW.md) | Workstream B Execution Review |
| [WORKSTREAM-C-EXECUTION-REVIEW.md](../architecture/WORKSTREAM-C-EXECUTION-REVIEW.md) | Workstream C Execution Review |
| [WORKSTREAM-D-EXECUTION-REVIEW.md](../architecture/WORKSTREAM-D-EXECUTION-REVIEW.md) | Workstream D Execution Review |
| [WORKSTREAM-F-EXECUTION-REVIEW.md](../architecture/WORKSTREAM-F-EXECUTION-REVIEW.md) | Workstream F Execution Review |
| [WORLD-CARD-CHARACTER-SETTINGS.md](../architecture/WORLD-CARD-CHARACTER-SETTINGS.md) | World Card character settings |
| [WORLD-VISUALS-ADAPTATION-20260831.md](../architecture/WORLD-VISUALS-ADAPTATION-20260831.md) | World Visuals adaptation (2026-08-31) |
| [project-index.json](../architecture/project-index.json) | 结构化清单或验证证据（JSON） |

### docs/design

| 文件 | 标题/内容 |
| --- | --- |
| [README.md](../design/README.md) | 技术设计与实施方案 |
| [library-workflow.md](../design/library-workflow.md) | 世界卡库复用流程 |
| [mvu-main-compatibility-plan.md](../design/mvu-main-compatibility-plan.md) | 主分支 MVU 兼容与增强方案 |
| [mvu-native-semantics-assessment.md](../design/mvu-native-semantics-assessment.md) | MVU 共用核心与旧卡兼容评估 |
| [mvu-test-diagnostics.md](../design/mvu-test-diagnostics.md) | MVU test diagnostics |
| [st-core-upgrade-assessment-20260929.md](../design/st-core-upgrade-assessment-20260929.md) | SillyTavern 1.19.0 上游升级评估 |
| [storage-lifecycle-refactor-plan.md](../design/storage-lifecycle-refactor-plan.md) | 数据存储与生命周期重构：执行及验收基准 |
| [world-data-isolation.md](../design/world-data-isolation.md) | World Data Isolation |

### docs/releases

| 文件 | 标题/内容 |
| --- | --- |
| [2.0.1.md](../releases/2.0.1.md) | Tavern 2.0.1 |
| [2.0.10.md](../releases/2.0.10.md) | Tavern 2.0.10 |
| [2.0.11.md](../releases/2.0.11.md) | Tavern 2.0.11 |
| [2.0.12.md](../releases/2.0.12.md) | Tavern 2.0.12 |
| [2.0.13.md](../releases/2.0.13.md) | Tavern 2.0.13 |
| [2.0.2.md](../releases/2.0.2.md) | Tavern 2.0.2 |
| [2.0.3.md](../releases/2.0.3.md) | Tavern 2.0.3 |
| [2.0.4.md](../releases/2.0.4.md) | Tavern 2.0.4 |
| [2.0.5.md](../releases/2.0.5.md) | Tavern 2.0.5 |
| [2.0.6.md](../releases/2.0.6.md) | Tavern 2.0.6 |
| [2.0.9.md](../releases/2.0.9.md) | Tavern 2.0.9 |
| [2.1.0.md](../releases/2.1.0.md) | Tavern 2.1.0 |
| [2.1.1.md](../releases/2.1.1.md) | Tavern 2.1.1 |
| [2.1.2.md](../releases/2.1.2.md) | Tavern 2.1.2 |
| [2.1.3.md](../releases/2.1.3.md) | Tavern 2.1.3 |
| [2.1.4.md](../releases/2.1.4.md) | Tavern 2.1.4 |
| [2.1.5.md](../releases/2.1.5.md) | Tavern 2.1.5 |
| [2.1.6.md](../releases/2.1.6.md) | Tavern 2.1.6 |
| [2.1.7.md](../releases/2.1.7.md) | Tavern 2.1.7 |
| [2.2.0.md](../releases/2.2.0.md) | Tavern 2.2.0 |
| [2.2.1.md](../releases/2.2.1.md) | Tavern 2.2.1 |
| [2.2.10.md](../releases/2.2.10.md) | Nora Tavern v2.2.10 |
| [2.2.2.md](../releases/2.2.2.md) | Tavern 2.2.2 |
| [README.md](../releases/README.md) | 版本说明索引 |
| [v2.0.0-rc.3.md](../releases/v2.0.0-rc.3.md) | Tavern 2.0.0-rc.3 — 更新器重构测试版 |
| [v2.0.0-rc.4.md](../releases/v2.0.0-rc.4.md) | Tavern 2.0.0-rc.4 — 精简资源测试版 |
| [v2.0.0-rc.5.md](../releases/v2.0.0-rc.5.md) | Tavern 2.0.0-rc.5 — 修复 Python 旧版启动脚本误报冲突 |
| [v2.0.0-rc.6.md](../releases/v2.0.0-rc.6.md) | Tavern 2.0.0-rc.6 — 对齐旧版有效登录流程 |
| [v2.0.0-rc.7.md](../releases/v2.0.0-rc.7.md) | Tavern 2.0.0-rc.7 — 修复 Hermes 终端找不到 Liveware |
| [v2.0.0-rc.8.md](../releases/v2.0.0-rc.8.md) | Tavern 2.0.0-rc.8 - Restore legacy updater stop behavior |
| [v2.0.0-rc.9.md](../releases/v2.0.0-rc.9.md) | Tavern 2.0.0-rc.9 - Verify Liveware before updater success |
| [v2.0.0.md](../releases/v2.0.0.md) | Tavern 2.0.0 — main-branch promotion |
| [v2.3.0.md](../releases/v2.3.0.md) | 诺拉·酒馆 v2.3.0 |
| [v2.3.1.md](../releases/v2.3.1.md) | 诺拉·酒馆 v2.3.1 |
| [v2.3.13.md](../releases/v2.3.13.md) | 诺拉·酒馆 v2.3.13 |
| [v2.3.14.md](../releases/v2.3.14.md) | 诺拉·酒馆 v2.3.14 |
| [v2.3.15.md](../releases/v2.3.15.md) | 诺拉·酒馆 v2.3.15 |
| [v2.3.16.md](../releases/v2.3.16.md) | 诺拉·酒馆 v2.3.16 |
| [v2.3.17.md](../releases/v2.3.17.md) | 诺拉·酒馆 v2.3.17 |
| [v2.3.2.md](../releases/v2.3.2.md) | 诺拉·酒馆 v2.3.2 |
| [v2.3.3.md](../releases/v2.3.3.md) | 诺拉·酒馆 v2.3.3 · 启动器 1.0.0 |
| [v2.3.4.md](../releases/v2.3.4.md) | 诺拉·酒馆 v2.3.4 |
| [v2.3.5.md](../releases/v2.3.5.md) | 诺拉·酒馆 v2.3.5 |
| [v2.3.6.md](../releases/v2.3.6.md) | 诺拉·酒馆 v2.3.6 |
| [v2.3.7.md](../releases/v2.3.7.md) | 诺拉·酒馆 v2.3.7 |
| [v2.4.0.md](../releases/v2.4.0.md) | 诺拉·酒馆 v2.4.0 |
| [v2.4.1.md](../releases/v2.4.1.md) | 诺拉·酒馆 v2.4.1 |
| [v2.4.2.md](../releases/v2.4.2.md) | 诺拉·酒馆 v2.4.2 |
| [v2.4.3.md](../releases/v2.4.3.md) | 诺拉·酒馆 v2.4.3 |
| [v2.4.4.md](../releases/v2.4.4.md) | 诺拉·酒馆 v2.4.4 |
| [v2.4.5.md](../releases/v2.4.5.md) | 诺拉·酒馆 v2.4.5 |
| [v2.5.0.md](../releases/v2.5.0.md) | 诺拉·酒馆 v2.5.0 |
| [v2.5.1.md](../releases/v2.5.1.md) | 诺拉·酒馆 v2.5.1 |
| [v2.5.2.md](../releases/v2.5.2.md) | 诺拉·酒馆 v2.5.2 |
| [v2.5.4.md](../releases/v2.5.4.md) | 诺拉·酒馆 v2.5.4 |
| [v2.5.5.md](../releases/v2.5.5.md) | 诺拉·酒馆 v2.5.5 |
| [v2.5.6.md](../releases/v2.5.6.md) | 诺拉·酒馆 v2.5.6 |
| [v2.6.0.md](../releases/v2.6.0.md) | 诺拉·酒馆 v2.6.0 |
| [v2.6.1.md](../releases/v2.6.1.md) | 诺拉·酒馆 v2.6.1 |
| [v2.6.2.md](../releases/v2.6.2.md) | 诺拉·酒馆 v2.6.2 |
| [v2.6.3.md](../releases/v2.6.3.md) | 诺拉·酒馆 v2.6.3 |
| [v2.6.4.md](../releases/v2.6.4.md) | 诺拉·酒馆 v2.6.4 |
| [v2.6.5.md](../releases/v2.6.5.md) | 诺拉·酒馆 v2.6.5 |

### docs/reports

| 文件 | 标题/内容 |
| --- | --- |
| [20261016-linux-historical-update-acceptance.md](20261016-linux-historical-update-acceptance.md) | Linux 独立部署历史更新验收补充 |
| [20261016-linux-historical-update-evidence.json](20261016-linux-historical-update-evidence.json) | 结构化清单或验证证据（JSON） |
| [20261016-pair-standalone-update-acceptance.md](20261016-pair-standalone-update-acceptance.md) | 配对重试与独立部署更新：修复验收记录 |
| [20261016-pair-standalone-update-evidence.json](20261016-pair-standalone-update-evidence.json) | 结构化清单或验证证据（JSON） |
| [20261017-update-release-alignment-acceptance.md](20261017-update-release-alignment-acceptance.md) | 更新职责与两项更新：独立分支验收记录 |
| [20261018-installed-nora-skill-next-version.md](20261018-installed-nora-skill-next-version.md) | 新版诺拉内置技能更新下一版实测 |
| [20261018-main-updater-merge-review.md](20261018-main-updater-merge-review.md) | 独立更新器及组件更新：本地主线合并审查 |
| [20261018-recovery-ownership-legacy-admission.md](20261018-recovery-ownership-legacy-admission.md) | 恢复按钮、卸载归属与旧版更新接入验收 |
| [20261018-update-query-budget-acceptance.md](20261018-update-query-budget-acceptance.md) | 更新查询预算隔离与发布路径收敛 |
| [20261019-cloud-update-permission-repair.md](20261019-cloud-update-permission-repair.md) | 云端更新权限修复与验收 |
| [20261019-product-documentation-review.md](20261019-product-documentation-review.md) | 产品文档整理与两项修复登记 |
| [20261019-v2.5.3-release-preparation.md](20261019-v2.5.3-release-preparation.md) | v2.5.3 发布与验收记录 |
| [20261019-v2.5.4-release-preparation.md](20261019-v2.5.4-release-preparation.md) | v2.5.4 发布准备与验收 |
| [20261019-v2.5.5-release-preparation.md](20261019-v2.5.5-release-preparation.md) | v2.5.5 发布准备与验收 |
| [20261020-nora-design-coverage.md](20261020-nora-design-coverage.md) | 诺拉全能力设计覆盖核对 |
| [20261020-product-design-modularization.md](20261020-product-design-modularization.md) | 产品设计模块化与执行入口整顿 |
| [20261020-tavern-design-coverage.md](20261020-tavern-design-coverage.md) | 酒馆全功能产品设计覆盖核对 |
| [20261021-story-profile-baseline-confirmation.md](20261021-story-profile-baseline-confirmation.md) | 故事档案新产品基线确认与用户体验变化 |
| [20261021-story-profile-main-integration.md](20261021-story-profile-main-integration.md) | 故事档案1.31：本地主分支整合记录 |
| [20261022-v2.5.7-release-preparation.md](20261022-v2.5.7-release-preparation.md) | v2.5.7／启动器2.2.7发布记录 |
| [20261028-preset-copy-and-world-opening.md](20261028-preset-copy-and-world-opening.md) | 预设副本存取与创建后打开修复 |
| [20261028-tavern-library-script-ui.md](20261028-tavern-library-script-ui.md) | 酒馆脚本编辑与卡库交互补齐 |
| [20261101-main-prepush-function-check.md](20261101-main-prepush-function-check.md) | 2026-11-01 完整本地主分支推送前功能检查 |
| [20261101-v2.6.0-release-preparation.md](20261101-v2.6.0-release-preparation.md) | v2.6.0／启动器2.2.8发布记录 |
| [20261102-v2.6.1-release-preparation.md](20261102-v2.6.1-release-preparation.md) | v2.6.1 核心更新器修复发行记录 |
| [20261102-v2.6.2-release-preparation.md](20261102-v2.6.2-release-preparation.md) | v2.6.2 核心更新器修复发行记录 |
| [20261102-v2.6.3-release-preparation.md](20261102-v2.6.3-release-preparation.md) | v2.6.3 核心更新器修复发行记录 |
| [20261102-v2.6.4-release-preparation.md](20261102-v2.6.4-release-preparation.md) | v2.6.4 更新器修复与验收执行纠正 |
| [20261107-main-documentation-maintenance.md](20261107-main-documentation-maintenance.md) | 2026-11-07 主线文档整理记录 |
| [20261110-core-documentation-structure.md](20261110-core-documentation-structure.md) | 核心文件结构、文档分类与拆分对照 |
| [README.md](README.md) | 故障、实施与验收报告 |

### docs/verification

| 文件 | 标题/内容 |
| --- | --- |
| [README.md](../verification/README.md) | 验证记录与安全合同 |
| [chat-backup-mcp-integration-20261002.md](../verification/chat-backup-mcp-integration-20261002.md) | Chat Backup UI And MCP Integration - 2026-10-02 |
| [chat-backup-retention-safety-20261008.md](../verification/chat-backup-retention-safety-20261008.md) | Rolling Chat Backup Safety |
| [helper-script-persistence-20260928.md](../verification/helper-script-persistence-20260928.md) | 酒馆助手脚本保存隔离修复技术报告 |
| [local-branch-audit-20260930.md](../verification/local-branch-audit-20260930.md) | Local Branch Audit 2026-09-30 |
| [local-branch-integration-20260928.md](../verification/local-branch-integration-20260928.md) | 本地分支整合技术验收（2026-09-28） |
| [local-main-integration-20261001.md](../verification/local-main-integration-20261001.md) | Local Main Integration Review - 2026-10-01 |
| [story-ledger-on-demand-20261021.json](../verification/story-ledger-on-demand-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-archive-ui-cleanup-20261021.json](../verification/story-profile-archive-ui-cleanup-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-default-on-20261021.json](../verification/story-profile-default-on-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-main-integration-20261021.json](../verification/story-profile-main-integration-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-multi-world-layout-20261021.json](../verification/story-profile-multi-world-layout-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-plot-memory-flow-20261021.json](../verification/story-profile-plot-memory-flow-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-postreview-fixes-20261021.json](../verification/story-profile-postreview-fixes-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-premerge-design-review-20261021.json](../verification/story-profile-premerge-design-review-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-preview-live-20261021.json](../verification/story-profile-preview-live-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-reader-recap-20261021.json](../verification/story-profile-reader-recap-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-reliability-20261021.json](../verification/story-profile-reliability-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-user-budget-2000-20261021.json](../verification/story-profile-user-budget-2000-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-user-budget-20261021.json](../verification/story-profile-user-budget-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-yearbook-display-correction-20261021.json](../verification/story-profile-yearbook-display-correction-20261021.json) | 结构化清单或验证证据（JSON） |
| [story-profile-yearbook-filter-20261021.json](../verification/story-profile-yearbook-filter-20261021.json) | 结构化清单或验证证据（JSON） |
| [tavern-mcp-local-acceptance-20260929.md](../verification/tavern-mcp-local-acceptance-20260929.md) | Local Nora MCP deployment and natural-language acceptance |
| [tavern-mcp-parity-20260929.md](../verification/tavern-mcp-parity-20260929.md) | Tavern MCP parity implementation status |

### docs/images

| 文件 | 标题/内容 |
| --- | --- |
| [story-profile.png](../images/story-profile.png) | 文档图片资源 |
| [tavern-desktop.png](../images/tavern-desktop.png) | 文档图片资源 |
| [tavern-mobile.png](../images/tavern-mobile.png) | 文档图片资源 |


## 8. 本轮验证及剩余事项

- 文档候选共212项，其中188份Markdown；逐项清单及分组数量一致。
- 检查188份Markdown及相关根/模块入口的1159个本地文件链接，无缺失文件；42个活动文档来源的本地锚点检查通过。
- 76处原修订引用均能在本地Git解析；35份迁出材料的独立仓冻结原文均与旧Git字节一致。不把本地Git验证说成线上链接已公开。
- 13份受影响历史记录除引用格式外，正文与基线一致；两份安装/更新指南的代码块与基线一致。去除的旧测试命令另有明确范围。
- 现有`tests/core/docs.test.mjs`通过，`git diff --check`通过。检查范围为文档导航、来源、命令保留及差异边界，不是全平台产品验收。
- 改动仅位于`docs/`；运行技能、产品代码、测试、锁和工作流未改。

主线仍为ab3e048；本轮文档整理及此前已验收拆分返修3e8d814均未因此自动进入main。7项旧运行缺陷另行登记，未在此轮修复。进一步合并、推送与发布不由本文档操作自动执行。
