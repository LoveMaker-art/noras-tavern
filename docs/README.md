# 文档入口

[产品设计总览](product/README.md)与启动器、诺拉、酒馆三份模块设计共同构成项目内最高产品依据。开发前阅读总览及受影响模块，按[变更控制](product/README.md#change-control)核对规则、范围和验收；已确认、已取消及待决事项集中在[决策登记](product/README.md#decisions)。技术说明、执行流程和历史证据分别维护，不另立产品规则。

## 产品设计文档

- [项目总览与共同约定](product/README.md) — 产品目标、三者协作、数据和更新规则、交付要求与设计变更程序。
- [启动器设计](product/launcher.md) — 全部页面、控件、安装配置、服务控制、更新恢复、日志诊断、社区互动、窗口与卸载。
- [诺拉设计](product/nora.md) — 人格对话、问候连接、制卡、资料库与世界管理、模型和插件协助、档案记忆、运维与自主更新。
- [酒馆设计](product/tavern.md) — 完整页面与故事流程、卡库与世界内容、模型消息、账本备份、插件／MVU、外观及交互边界。
- [酒馆本轮四项设计选择](product/README.md#tavern-policy-decisions) — 删除范围、完整卡导入、模型调用与自动偏好复盘的已确认规则及实施边界。
- [需求与验收索引](product/requirements.md) — PR 编号跳转到四份设计中的唯一验收原文。
- [旧基线兼容入口](product-baseline.md) — 保留旧章节链接，只跳转，不平行维护规则。
- [需求变更模板](product/change-request-template.md) — 新需求或策略调整时先说明结果、范围、取舍和验收。
- [更新与发布产品设计](product/archive/20261019-update-release-design.md) — 已确认规则，按 2026-10-19 归档；实施和未验状态分别保留。
- [发布执行流程与验证状态](release-process.md) — 工具、命令、协议和实际验证记录；不能自行改变产品策略。

## 用户使用

- [下载启动器](../README.md#下载安装包)
- [安装 Nora + Tavern](install-nora-tavern.md)
- [只安装 Tavern（源码方式）](install-tavern.md)
- [选择更新方式](update-nora-tavern.md#先选择你的安装方式)
- [卸载与保留数据](launcher-uninstall.md)

## 当前仓库

- [仓库导航与职责](REPOSITORY.md)
- [开发、验证与发布](../CONTRIBUTING.md)
- [核心与启动器更新：历史实施方案](design/update-release-alignment.md) — 已归档的技术方案；当前规则查基线，发行状态查对应报告，历史证据保留各自日期和验收范围。
- [诺拉内容](../nora/README.md)
- [启动器](../launcher/README.md)
- [安装、更新和卸载](../deployment/README.md)
- [领域语言](../CONTEXT.md)
- [本次目录整理的验证范围](repository-organization-verification.md)
- [数据存储与生命周期重构：执行及逐阶段验收](design/storage-lifecycle-refactor-plan.md) — 开始或验收备份、恢复、删除与数据清理重构时，先对照此方案并更新阶段证据。

## 历史资料

`architecture/` 的日期快照、`adr/` 决策、`releases/` 发布记录保留历史语境。其中的旧路径、旧测试结论和版本状态不自动代表当前代码；当前路径通过 [源码交付映射](../tooling/source-layout.json) 追溯。

不要删除有依据的历史记录来让目录看起来更短，也不要把历史快照继续作为唯一的当前架构入口。
