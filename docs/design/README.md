# 技术设计与实施方案

[返回文档入口](../README.md) · [现行产品规则](../product/README.md) · [架构决策](../adr/README.md)

技术方案说明实现选择和对应验收，产品行为以四份产品设计为准。文内“本次”“当前分支”“未发布”等措辞保留记录当时的语境；继续实施前核对实际主线和后续证据。

| 文档 | 用途与范围 |
| --- | --- |
| [世界卡库复用流程](library-workflow.md) | 资料库流程的实施与历史验证；产品规则查酒馆设计。 |
| [主分支 MVU 兼容与增强方案](mvu-main-compatibility-plan.md) | MVU分支方案与分阶段记录，按文内日期和源码使用。 |
| [MVU 共用核心与旧卡兼容评估](mvu-native-semantics-assessment.md) | 2026-09-17共用核心与旧卡语义评估、实施边界。 |
| [MVU test diagnostics](mvu-test-diagnostics.md) | 可选诊断采集的操作说明及限制，不改变执行模式。 |
| [SillyTavern 1.19.0 上游升级评估](st-core-upgrade-assessment-20260929.md) | 2026-09-29升级评估及按时间追加的实施、部署记录。 |
| [数据存储与生命周期重构：执行及验收基准](storage-lifecycle-refactor-plan.md#record-summary) | 先看已实施、被替代和当时未验的摘要，再按阶段查原证据。 |
| 核心与启动器更新：历史实施方案（原修订 `09b9895`，专属材料已迁出） | 已归档方案；摘要区分仍适用的组件边界与已取消的联合执行。 |
| [World Data Isolation](world-data-isolation.md) | 世界资源归属、独立副本及已有世界保留边界的技术说明。 |

方案中的历史结论和失败证据继续保留。后续结果放入对应执行记录，并在[报告索引](../reports/README.md)或[验证记录索引](../verification/README.md)登记。
