# 架构演进与原始记录

当前目录和源码归属只在[仓库结构](../REPOSITORY.md)维护；产品规则只在[产品总览](../product/README.md)及其两份模块设计维护。本页解释架构为什么演进，不重复现行操作步骤或重新宣告历史验收通过。

## 演进脉络

| 阶段 | 变化及原因 | 持续维护的依据 | 原时点证据 |
| --- | --- | --- | --- |
| World Core建立 | 从卡/聊天的临时组合转向权威世界manifest，ST保留兼容执行；世界就绪与扩展能力分开 | [ADR0007](../adr/0007-make-world-manifest-authoritative.md)、[0008](../adr/0008-separate-world-readiness-from-capabilities.md)、[0009](../adr/0009-use-json-manifests-with-an-in-memory-index.md) | `73220ae:docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`及PHASE-0～7原记录 |
| UI与兼容执行分开 | UI消费世界读模型和命令，ST全局及DOM差异集中于Adapter；避免第二套生成生命周期 | [ADR0003](../adr/0003-isolate-st-compatibility.md)、[0004](../adr/0004-split-nora-ui-workflows.md)、[兼容机器合同](ST-COMPATIBILITY-INTERFACE-MANIFEST.json) | `73220ae:docs/architecture/ST-INTERACTION-AUDIT-2026-08-30.md`；同修订复杂卡矩阵记录其当时未验范围 |
| Python到Node及档案同仓 | 替换旧在线应用；Story Profile保留唯一作者源，发布时生成可核验快照 | [ADR0002](../adr/0002-single-node-runtime.md)、[0006](../adr/0006-own-core-startup-and-use-immutable-critical-assets.md)、[模块开发](../../story-profile/README.md) | `73220ae:docs/architecture/PYTHON-TO-NODE-MIGRATION-20260831.md`、`73220ae:docs/architecture/MONOREPO-RELEASE-20260831.md` |
| 安装身份与进程观察分开 | PID和内核坐标只证明一次观察，不能当作跨容器/重启的持久安装身份 | [ADR0012](../adr/0012-separate-runtime-ownership-from-process-instance.md) | `73220ae:docs/architecture/UPDATER-EXISTING-INSTANCE-20260910.md` |
| 程序维护与用户内容分开 | 程序替换、旧数据转换、内容恢复采用不同合同；普通程序回退不回滚当前故事 | [ADR0013](../adr/0013-snapshot-replaceable-code-at-maintenance.md)、[0014](../adr/0014-repair-derived-operational-state.md)、[核心维护](../core-maintenance.md) | `73220ae:docs/design/storage-lifecycle-refactor-plan.md`；其追加的失败/部分实施记录仍按原时点保留 |
| 世界资源副本独立 | 库原件与各世界运行副本分开；旧共享绑定在用户写入时保护，不自动迁移已有世界 | [隔离实现](../design/world-data-isolation.md)、[ADR0010](../adr/0010-create-blank-worlds-through-world-core.md)、[0011](../adr/0011-world-owned-cast-for-python-data.md) | `73220ae:docs/design/library-workflow.md`、`73220ae:docs/design/world-data-isolation.md` |
| MCP与后台记忆收敛 | MCP复用领域业务；偏好、剧情账本及只读年表分工，剧情按需读取，不常驻MEMORY | [MCP接口](../../nora-mcp/README.md)、[档案作者接口](../../story-profile/README.md)、[诺拉设计](../product/nora.md#story-profile) | `73220ae:nora-mcp/docs/IMPLEMENTATION-20260830.md`、`73220ae:docs/reports/20261021-story-profile-baseline-confirmation.md`、同修订档案JSON证据 |
| 核心/桌面作者分仓 | 桌面与共同维护实现独立维护，核心消费固定输入；作者分离不自动解决已有产品缺陷 | [源码归属](../REPOSITORY.md#shared-implementation-boundaries)、[核心维护](../core-maintenance.md) | `73220ae:docs/reports/20261110-core-documentation-structure.md`；本轮源码返修整合状态不由旧报告替代 |

## 如何读取原始证据

退休材料完整保存在本轮基线`73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b`，包括旧方案、13份阶段/Workstream评审、发布过程、验证JSON、旧生成索引和已替代兼容导航；它们退出当前文件树，不再复制到另一层archive制造第二套待维护文件。

```sh
git show 73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b:docs/architecture/PHASE-1-EXECUTION-REVIEW.md
git show 73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b:docs/verification/story-profile-reliability-20261021.json
git ls-tree -r --name-only 73220aea2ced9c24f24fe24fbcbbc5c89dbe0c3b -- docs
```

原文中的源码/制品指纹、分支、日期、失败、跳过、未发布与未验范围均保留，不改成当前通过。`commit:path#anchor`中的锚点用于原文内定位；运行git show时去掉锚点。引用本地Git对象不表示它已经公开推送；浅克隆缺少原对象时应取得对应历史，不用当前代码伪造旧证据。

冻结的旧project-index只是一份历史快照。当前索引由`node tooling/checks/index-project.mjs`写入忽略的`.codebase-memory/project-index.json`，不再将生成索引复制进文档仓。仍被测试读取的兼容JSON保留原路径与原字节，不按扩展名批量删除。
