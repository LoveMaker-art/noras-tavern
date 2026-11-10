# 核心文档索引

## 当前入口

- [产品总览](product/README.md)
- [诺拉设计](product/nora.md)
- [酒馆设计](product/tavern.md)
- [需求与验收索引](product/requirements.md)
- [仓库结构](REPOSITORY.md)
- [文件结构、文档分类与拆分对照汇总](reports/20261110-core-documentation-structure.md)
- [开发、测试和构建](../CONTRIBUTING.md)
- [核心安装](install-nora-tavern.md)
- [只安装酒馆](install-tavern.md)
- [核心更新和恢复](update-nora-tavern.md)
- [共享维护输入和数据合同](core-maintenance.md)
- [发行流程](release-process.md)
- [领域语言](../CONTEXT.md)

## 历史与运行内容

历史架构、报告和验证记录保留各自日期、源码与实际证明范围，不能代替当前实现。已迁出的专属材料在原修订 `09b9895` 的 Git 历史可追溯。当前产品规则以本索引指向的核心设计为准。

`nora/AGENTS.md`、人格、技能及Hook是产品运行内容，保留其业务职责；不将运行技能当作开发说明清理。用户目录、日志、凭据与生成资产不属于文档仓。

## 分类目录

| 类别 | 入口 | 使用规则 |
| --- | --- | --- |
| 现行产品规则 | [产品设计](product/README.md) | 总览、诺拉、酒馆三份为规则来源；旧需求入口只导航 |
| 当前安装、开发与维护 | 本页当前入口、[仓库结构](REPOSITORY.md) | 执行当前入口，不从旧验收记录拼接操作步骤 |
| 架构决策 | [ADR](adr/README.md) | 按状态和取代关系使用；恢复核心适用的0012～0014 |
| 技术设计 | [设计索引](design/README.md) | 区分方案、实现与验收，不自行改写产品要求 |
| 历史架构与兼容参考 | [架构资料](architecture/README.md) | 保留原源码和时点，兼容矩阵按原已验范围使用 |
| 实施和故障记录 | [报告索引](reports/README.md) | 原通过、失败、未验、未发布结论保留 |
| 验证证据及安全合同 | [验证索引](verification/README.md) | 证据绑定具体对象；仍适用合同按现行引用使用 |
| 历史发行说明 | [版本索引](releases/README.md) | 记录各批次组件，不当成当前发行资格 |
