# 验证记录与安全合同

[返回文档入口](../README.md) · [报告索引](../reports/README.md) · [当前源码测试入口](../../tests/deployment/README-nora-acceptance.md)

本目录既有指定场景的验证快照，也有仍由现行产品设计引用的技术安全合同。合同的适用状态由现行引用及文内边界决定，不能仅按文件日期判断失效。验收结果则按记录中的日期、源码或制品摘要、环境、场景和未验项使用，不是当前全量验收通过清单。JSON里的source_sha256等固定指纹也是身份依据；未记录的旧身份不从当前main补造。

## 现行产品引用的安全合同

- [Rolling Chat Backup Safety](chat-backup-retention-safety-20261008.md) — 仍由[酒馆产品设计](../product/tavern.md)引用，包含备份保留和清理边界；同时保留该次验证范围。后续变更先核对现行产品规则。

## 故事档案、账本与备份

- [Chat Backup UI And MCP Integration - 2026-10-02](chat-backup-mcp-integration-20261002.md)
- [酒馆助手脚本保存隔离修复技术报告](helper-script-persistence-20260928.md)
- [story-ledger-on-demand-20261021.json](story-ledger-on-demand-20261021.json) — 机器可读清单或证据。
- [story-profile-archive-ui-cleanup-20261021.json](story-profile-archive-ui-cleanup-20261021.json) — 机器可读清单或证据。
- [story-profile-default-on-20261021.json](story-profile-default-on-20261021.json) — 机器可读清单或证据。
- [story-profile-main-integration-20261021.json](story-profile-main-integration-20261021.json) — 机器可读清单或证据。
- [story-profile-multi-world-layout-20261021.json](story-profile-multi-world-layout-20261021.json) — 机器可读清单或证据。
- [story-profile-plot-memory-flow-20261021.json](story-profile-plot-memory-flow-20261021.json) — 机器可读清单或证据。
- [story-profile-postreview-fixes-20261021.json](story-profile-postreview-fixes-20261021.json) — 机器可读清单或证据。
- [story-profile-premerge-design-review-20261021.json](story-profile-premerge-design-review-20261021.json) — 机器可读清单或证据。
- [story-profile-preview-live-20261021.json](story-profile-preview-live-20261021.json) — 机器可读清单或证据。
- [story-profile-reader-recap-20261021.json](story-profile-reader-recap-20261021.json) — 机器可读清单或证据。
- [story-profile-reliability-20261021.json](story-profile-reliability-20261021.json) — 机器可读清单或证据。
- [story-profile-user-budget-2000-20261021.json](story-profile-user-budget-2000-20261021.json) — 机器可读清单或证据。
- [story-profile-user-budget-20261021.json](story-profile-user-budget-20261021.json) — 机器可读清单或证据。
- [story-profile-yearbook-display-correction-20261021.json](story-profile-yearbook-display-correction-20261021.json) — 机器可读清单或证据。
- [story-profile-yearbook-filter-20261021.json](story-profile-yearbook-filter-20261021.json) — 机器可读清单或证据。

## 主线整合与MCP

- [Local Branch Audit 2026-09-30](local-branch-audit-20260930.md)
- [本地分支整合技术验收（2026-09-28）](local-branch-integration-20260928.md)
- [Local Main Integration Review - 2026-10-01](local-main-integration-20261001.md)
- [Local Nora MCP deployment and natural-language acceptance](tavern-mcp-local-acceptance-20260929.md)
- [Tavern MCP parity implementation status](tavern-mcp-parity-20260929.md)
- 酒馆 2.5.0 与 GitHub 版本差异报告（原修订 `09b9895:docs/verification/v2.5.0-github-diff.md`）

已迁出的桌面专属文档不再作为本仓操作入口；保留的混合历史记录使用固定原修订引用追溯，不代表当前产品规则或当前验收通过。完整分类与迁出对照见[文件与文档结构汇总](../reports/20261110-core-documentation-structure.md)。
