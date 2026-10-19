# 文档入口

项目唯一的[产品设计基线](product-baseline.md)规定已确认规则、模块职责和后续修改程序；已确认、已取消及待决选择集中在[决策登记](product-baseline.md#八-已确认决策与待确认事项)。开始修复、优化或交付前先对照；实际实现、验收与发行查附录链接的报告，下列模块文档与历史记录不另立产品基线。

## 产品设计文档

- [产品设计文档库](product/README.md) — 整套产品文档的主入口：定位、需求、功能标准、决策与设计归档。
- [产品需求说明](product/requirements.md) — 目标用户、产品范围、主要流程、功能要求和验收标准。
- [产品设计基线](product-baseline.md) — 唯一现行规则，包含诺拉、酒馆、启动器的职责、数据保护及更新发布策略。
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
