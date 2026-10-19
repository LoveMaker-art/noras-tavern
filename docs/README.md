# 文档入口

项目唯一的[产品设计基线](product-baseline.md)规定已确认规则、模块职责、当前实现差异和后续修改程序；本轮选择及未决项集中在[决策登记](product-baseline.md#八-已确认决策与待确认事项)。开始修复、优化或交付前先对照；下列模块文档与历史记录不另立产品基线。

## 用户使用

- [下载启动器](../README.md#下载安装包)
- [安装 Nora + Tavern](install-nora-tavern.md)
- [只安装 Tavern（源码方式）](install-tavern.md)
- [选择更新方式](update-nora-tavern.md#先选择你的安装方式)
- [卸载与保留数据](launcher-uninstall.md)

## 当前仓库

- [仓库导航与职责](REPOSITORY.md)
- [开发、验证与发布](../CONTRIBUTING.md)
- [核心与启动器更新：设计与验收范围](design/update-release-alignment.md) — 已完成本地实施与集成；实际证据和发行限制见[查询预算验收](reports/20261018-update-query-budget-acceptance.md)及[合并审查](reports/20261018-main-updater-merge-review.md)，尚未正式发布。
- [诺拉内容](../nora/README.md)
- [启动器](../launcher/README.md)
- [安装、更新和卸载](../deployment/README.md)
- [领域语言](../CONTEXT.md)
- [本次目录整理的验证范围](repository-organization-verification.md)
- [数据存储与生命周期重构：执行及逐阶段验收](design/storage-lifecycle-refactor-plan.md) — 开始或验收备份、恢复、删除与数据清理重构时，先对照此方案并更新阶段证据。

## 历史资料

`architecture/` 的日期快照、`adr/` 决策、`releases/` 发布记录保留历史语境。其中的旧路径、旧测试结论和版本状态不自动代表当前代码；当前路径通过 [源码交付映射](../tooling/source-layout.json) 追溯。

不要删除有依据的历史记录来让目录看起来更短，也不要把历史快照继续作为唯一的当前架构入口。
