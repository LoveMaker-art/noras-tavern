# 核心文档入口

| 阅读目的 | 唯一入口 |
| --- | --- |
| 产品规则 | [共同约定](product/README.md)、[诺拉](product/nora.md)、[酒馆](product/tavern.md) |
| 行为变更 | [变更模板](product/change-request-template.md) |
| 文件结构与作者归属 | [仓库结构](REPOSITORY.md) |
| 开发、测试、构造 | [CONTRIBUTING](../CONTRIBUTING.md) |
| 安装 | [只安装酒馆](install-tavern.md)、[完整核心](install-nora-tavern.md) |
| 更新与恢复 | [核心入口](update-nora-tavern.md)、[旧入口接入及平台步骤](update-standalone-tavern.md) |
| 核心维护与交付 | [维护合同](core-maintenance.md)、[发布流程](release-process.md) |
| 世界资源实现 | [隔离与绑定](design/world-data-isolation.md) |
| MVU诊断 | [诊断采集](design/mvu-test-diagnostics.md) |
| 注册与问候时序 | [Liveware技术说明](liveware-first-greeting-order.md) |
| 架构决策 | [ADR状态与索引](adr/README.md) |
| 架构演进与原始证据 | [演进记录](architecture/README.md) |
| 历史版本变化 | [版本记录](releases/README.md) |
| 备份安全合同 | [保留及失败边界](verification/chat-backup-retention-safety-20261008.md) |

人格、技能及Hook属于`nora/`产品运行输入；第三方声明、实际测试合同和生成运行快照按各自职责保留。新文档必须有现有文件无法承担的独立维护目的；相同规则修改唯一原文，其他位置只引用；一次性过程结果绑定Git/制品后从当前目录退出，必要演进集中追加到现有历史入口。
