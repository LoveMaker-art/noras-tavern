# 文档入口

[产品设计总览](product/README.md)与启动器、诺拉、酒馆三份模块设计共同构成项目内最高产品依据。开发前阅读总览及受影响模块，按[变更控制](product/README.md#change-control)核对规则、范围和验收；已确认、已取消及待决事项集中在[决策登记](product/README.md#decisions)。技术说明、执行流程和历史证据分别维护，不另立产品规则。

## 分类总览

| 要查什么 | 入口 | 适用范围 |
| --- | --- | --- |
| 产品应该怎样工作 | [产品设计](product/README.md) | 总览及三份模块设计维护现行规则 |
| 用户怎样安装、更新、卸载 | [用户使用](#用户使用) | 可操作步骤，按实际安装来源选择 |
| 源码归属和开发方式 | [仓库导航](REPOSITORY.md)、[贡献指南](../CONTRIBUTING.md) | 当前工程入口 |
| 为什么作出架构选择 | [架构决策索引](adr/README.md) | 查看原决策及其被取代、修订状态 |
| 某项技术方案和实施边界 | [技术设计索引](design/README.md) | 区分当前实现说明与历史方案 |
| 技术安全合同和某次验收结果 | [报告索引](reports/README.md)、[验证记录与安全合同](verification/README.md) | 区分现行设计引用的合同与固定源码、制品、环境和场景的结果 |
| 早期架构和阶段评审 | [历史架构索引](architecture/README.md) | 保留原时点，当前代码查仓库导航 |
| 某个版本发布了什么 | [版本说明索引](releases/README.md) | 按批次查看组件版本及变化 |

`nora/AGENTS.md`、人格、技能、故事档案和内置开场白等 Markdown 也会作为产品内容交付。其职责见[诺拉内容](../nora/README.md)和[源码导航](REPOSITORY.md)，整理说明文档时保留这些运行内容。

## 产品设计文档

- [项目总览与共同约定](product/README.md) — 产品目标、三者协作、数据和更新规则、交付要求与设计变更程序。
- [启动器设计](product/launcher.md) — 全部页面、控件、安装配置、服务控制、更新恢复、日志诊断、社区互动、窗口与卸载。
- [诺拉设计](product/nora.md) — 人格对话、问候连接、制卡、资料库与世界管理、模型和插件协助、档案记忆、运维与自主更新。
- [酒馆设计](product/tavern.md) — 完整页面与故事流程、卡库与世界内容、模型消息、账本备份、插件／MVU、外观及交互边界。
- [酒馆本轮四项设计选择](product/README.md#tavern-policy-decisions) — 删除范围、完整卡导入、模型调用与自动偏好复盘的已确认规则及实施边界。
- [需求与验收索引](product/requirements.md) — PR 编号跳转到四份设计中的唯一验收原文。
- [旧基线兼容入口](product-baseline.md) — 保留旧章节链接，只跳转，不平行维护规则。
- [需求变更模板](product/change-request-template.md) — 新需求或策略调整时先说明结果、范围、取舍和验收。
- [2026-10-19 更新设计归档](product/archive/20261019-update-release-design.md) — 保留当时的规则和取舍；现行规则仍查总览及三份模块设计。
- [发布执行流程与验证状态](release-process.md) — 工具、命令、协议和实际验证记录；不能自行改变产品策略。

## 用户使用

- [下载启动器](../README.md#下载安装包)
- [安装 Nora + Tavern](install-nora-tavern.md)
- [Linux云端部署范围与当前状态](install-nora-tavern.md#linux-cloud-installation)
- [只安装 Tavern（源码方式）](install-tavern.md)
- [选择更新方式](update-nora-tavern.md#先选择你的安装方式)
- [旧技能的官方独立接入](update-standalone-tavern.md#旧技能要求启动器时的一次接入)
- [卸载与保留数据](launcher-uninstall.md)
- [安装位置与迁移边界](install-nora-tavern.md#installation-location)
- [受管文件和自定义配置](launcher-managed-files.md)

## 当前仓库

- [仓库导航与职责](REPOSITORY.md)
- [开发、验证与发布](../CONTRIBUTING.md)
- [核心与启动器更新：历史实施方案](design/update-release-alignment.md#record-summary) — 已归档的技术方案；当前规则查基线，发行状态查对应报告，历史证据保留各自日期和验收范围。
- [诺拉内容](../nora/README.md)
- [启动器](../launcher/README.md)
- [安装、更新和卸载](../deployment/README.md)
- [领域语言](../CONTEXT.md)
- [数据存储与生命周期重构：执行及逐阶段验收](design/storage-lifecycle-refactor-plan.md#record-summary) — 先看已记载实施、被替代规则及当时未验范围；原方案与阶段证据保留。
- [源码测试分组及前置条件](../tests/deployment/README-nora-acceptance.md)
- [当前任务与历史证据导航](launcher-reliability-plan.md) — 以各段记录的日期、源码及验收范围为准。
- [本地原始证据与临时文件说明](../local-state/README.md)

### 工程专题

- [安装、核心更新与启动器自更新](launcher-unified-update.md)
- [更新职责及历史合同](updater-ownership-contract.md#current-boundary)
- [启动器与公共业务实现边界](REPOSITORY.md#shared-implementation-boundaries)
- [日志与自动故障诊断](launcher-install-diagnostics.md)
- [面向用户的错误及进度呈现](launcher-install-diagnostics.md#error-presentation)
- [问候与 Liveware 独立启动合同](liveware-first-greeting-order.md)
- [Beta 构建、更新与验收](launcher-beta-testing.md)

## 历史资料

[历史架构](architecture/README.md)、[技术方案](design/README.md)、[报告](reports/README.md)、[验证记录与安全合同](verification/README.md)和[版本说明](releases/README.md)分别提供分类入口。现行产品引用的安全合同继续按其边界适用；ADR 的有效及取代关系见[决策索引](adr/README.md)。旧路径、旧测试结论和版本状态保留各自历史语境；当前路径通过 [源码交付映射](../tooling/source-layout.json) 追溯。

以下一次性记录保留原路径，统一在此归类：

- [2026-09-24 两项启动审计](startup-followup-20260924.md) — 两份原始基线、结果及未验分别保留。
- [2026-09-30 剧情账本运行设计](ledger-runtime-design-20260930.md)
- [目录整理与本地主线整合的历史验证](local-main-integration-verification.md) — 2026-09-10目录迁移与其后整合分别留证。
- [2026-09-08 早期 Beta 验收](launcher-beta-acceptance.md)

不要删除有依据的历史记录来让目录看起来更短，也不要把历史快照继续作为唯一的当前架构入口。
