# 产品需求与验收索引

本页保留旧需求入口及 PR 编号，仅导航到[项目总览](README.md)和三个模块中的唯一原文；现行版本以总览为准，不平行维护版本号、产品规则或验证状态。

## 一 产品定位与目标用户

见[产品目标与组成](README.md#product-goals)。

## 二 产品范围与职责

见[总览职责](README.md#pb-02)、[模块交接](README.md#module-handoffs)、[启动器](launcher.md)、[诺拉](nora.md)和[酒馆](tavern.md)。

## 三 主要用户流程

见[完整体验](README.md#pb-02)及各模块中的首次、日常和维护流程。

## 四 功能要求与验收标准

| 编号 | 原用户目标 | 唯一验收原文 |
| --- | --- | --- |
| PR-01 | 首次使用 | [查看要求](launcher.md#pr-01) |
| PR-02 | 日常进入 | [查看要求](launcher.md#pr-02) |
| PR-03 | 故事持久保存 | [查看要求](tavern.md#pr-03) |
| PR-04 | 内容隔离与复用 | [查看要求](tavern.md#pr-04) |
| PR-05 | 模型配置 | [查看要求](README.md#pr-05) |
| PR-06 | 配对与重试 | [查看要求](nora.md#pr-06) |
| PR-07 | 诺拉内容管理 | [查看要求](nora.md#pr-07) |
| PR-08 | 故事档案与辅助 | [查看要求](nora.md#pr-08) |
| PR-09 | 状态与可用边界 | [查看要求](README.md#pr-09) |
| PR-10 | 核心自主更新 | [查看要求](nora.md#pr-10) |
| PR-11 | 桌面更新 | [查看要求](launcher.md#pr-11) |
| PR-12 | 故障恢复 | [查看要求](README.md#pr-12) |
| PR-13 | 备份与卸载 | [查看要求](launcher.md#pr-13) |
| PR-14 | 下载与诊断 | [查看要求](README.md#pr-14) |

上述要求描述“应证明什么”。实际是否通过、适用版本与环境，由对应报告说明；数量不等于用例数或已完成数量。

启动器完整规格另由[全部页面与入口目录](launcher.md#pages)、[L-01～L-22 全功能验收](launcher.md#acceptance)和[覆盖审计](../reports/20261020-launcher-design-coverage.md)定位；既有 PR 编号并不包含全部控件细则。细则只在启动器设计维护。

诺拉完整规格由[人格与对话](nora.md#conversation)、[N-01～N-19 全能力验收](nora.md#acceptance)和[覆盖核对](../reports/20261020-nora-design-coverage.md)定位，涵盖运行内容、技能、MCP、档案页、记忆、运维与更新；既有 PR 编号不是全部能力清单。

酒馆完整规格由[页面与首次续接](tavern.md#interface)、[T-01～T-27 全功能验收](tavern.md#acceptance)和[覆盖核对](../reports/20261020-tavern-design-coverage.md)定位，覆盖世界／库、角色设定、预设模型、消息保存、账本备份、插件／MVU、视觉与交互；PR-03／04不是全部酒馆功能清单。

酒馆删除、完整卡导入、模型调用／费用的已确认规则和本轮四项批准依据见[集中决策](README.md#tavern-policy-decisions)，相应验收在[删除合同](tavern.md#library-deletion-policy)、[导入支持](tavern.md#import-support)、[调用边界](tavern.md#model-call-policy)及[自动复盘](nora.md#automatic-reflection-policy)；已确认设计不等于已实现或验收。

## 五 品质与异常要求

见[共同品质、隐私与验收要求](README.md#quality-and-privacy)。

## 六 已确认取舍

见[唯一决策登记](README.md#decisions)。

## 七 评审与维护

见[开发执行与设计变更控制](README.md#change-control)；改变行为时使用[变更模板](change-request-template.md)，修正实现偏离则保留原规则并记录必要证据。
