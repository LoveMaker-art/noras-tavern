# 诺拉酒馆 Nora Tavern

<img src="app/engine/sillytavern/public/tavern-icon-dbf4ecbd54ec.png" width="112" height="112" alt="诺拉酒馆">

诺拉酒馆以世界和故事会话组织角色扮演，提供角色、资料库、模型、剧情账本与记忆管理。诺拉运行于 Hermes Agent，通过 MCP 操作酒馆，并在用户授权下管理模型与本实例的核心更新。

本仓维护诺拉、酒馆、MCP、故事档案及核心安装、运行和更新实现。

- [只安装酒馆](docs/install-tavern.md)
- [安装诺拉与酒馆](docs/install-nora-tavern.md)
- [核心更新与恢复](docs/update-nora-tavern.md)
- [产品设计](docs/product/README.md)
- [开发、测试和构建](CONTRIBUTING.md)
- [仓库结构与维护职责](docs/REPOSITORY.md)
- [English](README.en.md)

## 开发入口

使用真实 Node.js 24、npm、Python 3.11+ 与 tar。完整前置条件见开发指南。

```sh
npm ci
node tooling/maintenance-input.mjs fetch
npm --prefix app/engine/sillytavern ci
npm --prefix nora-mcp ci
```

共享维护执行实现通过版本与摘要固定的外部输入消费；源码检出不需要相邻项目目录。输入缺失或校验失败会明确阻断，不回退到未固定的本地副本。

用户的模型密钥、配置、世界、会话、日志与备份不属于源码仓。更新与恢复只操作已确认归属的本实例，并保留既有数据保护规则。第三方许可证及声明保留原处。
