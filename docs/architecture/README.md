# 历史架构与兼容资料

[返回文档入口](../README.md) · [当前源码职责](../REPOSITORY.md) · [现行产品规则](../product/README.md) · [架构决策](../adr/README.md)

本目录保留架构快照、旧方案和阶段评审。按每份记录的日期、源码与验收范围使用；当前职责和操作入口从仓库导航进入。兼容矩阵等资料继续供既有指南引用，其已验范围以正文为准。

旧交付路径可通过[源码映射](../../tooling/source-layout.json)追溯。这里的历史发布、更新或测试步骤不覆盖现行[发布流程](../release-process.md)和[更新指南](../update-nora-tavern.md)。

## 兼容参考与交互审计

- [Nora Tavern Complex Card Compatibility Matrix](COMPLEX-CARD-COMPATIBILITY-MATRIX.md)
- [Tavern Index Coverage](INDEX-COVERAGE.md)
- [ST-COMPATIBILITY-INTERFACE-MANIFEST.json](ST-COMPATIBILITY-INTERFACE-MANIFEST.json) — 机器可读清单或证据。
- [ST／复杂卡交互适配审计：远端版本 cd7cf216e868460f](ST-INTERACTION-AUDIT-2026-08-30.md)
- [ST-INTERACTION-INVENTORY-2026-08-30.json](ST-INTERACTION-INVENTORY-2026-08-30.json) — 机器可读清单或证据。
- [交互链路修复状态：已技术验证并部署，待实际页面验收](ST-INTERACTION-REPAIR-STATUS-2026-08-30.md)
- [TAVERN-RELEASE-AUDIT-2026-08-30.json](TAVERN-RELEASE-AUDIT-2026-08-30.json) — 机器可读清单或证据。
- [Tavern 架构、冗余与发布就绪审计](TAVERN-RELEASE-AUDIT-2026-08-30.md)

## 架构快照与重构方案

- [Nora Tavern World Core 完整重构计划](NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md)
- [Nora Tavern Architecture Snapshot](PROJECT-ARCHITECTURE.md)
- [原 Python 酒馆 → Node Tavern：实现与验收](PYTHON-TO-NODE-MIGRATION-20260831.md)
- [2026-08-29本地发布基线（已并入Workstream F）](WORKSTREAM-F-EXECUTION-REVIEW.md#local-release-baseline-20260829)
- [旧组件交付与0.3.4接入说明（已并入更新历史）](UNIFIED-UPDATE-20260910.md#legacy-release-delivery-paths)
- [Tavern 发布收口执行记录](RELEASE-HARDENING-2026-08-30.md)
- [project-index.json](project-index.json) — 机器可读清单或证据。

## 阶段评审

- [Phase 0 Execution Review](PHASE-0-EXECUTION-REVIEW.md)
- [Phase 0 Runtime Baseline](PHASE-0-RUNTIME-BASELINE.md)
- [Phase 1 Execution Review](PHASE-1-EXECUTION-REVIEW.md)
- [Phase 2 Execution Review](PHASE-2-EXECUTION-REVIEW.md)
- [Phase 3 Execution Review](PHASE-3-EXECUTION-REVIEW.md)
- [Phase 4 Execution Review](PHASE-4-EXECUTION-REVIEW.md)
- [Phase 5 Execution Review](PHASE-5-EXECUTION-REVIEW.md)
- [Phase 6 Execution Review](PHASE-6-EXECUTION-REVIEW.md)
- [Phase 7 Preflight Review](PHASE-7-PREFLIGHT-REVIEW.md)
- [Workstream B Execution Review](WORKSTREAM-B-EXECUTION-REVIEW.md)
- [Workstream C Execution Review](WORKSTREAM-C-EXECUTION-REVIEW.md)
- [Workstream D Execution Review](WORKSTREAM-D-EXECUTION-REVIEW.md)
- [Workstream F Execution Review](WORKSTREAM-F-EXECUTION-REVIEW.md)

## 部署、技能与更新历史

- [Hermes Skill 官方规范证据（2026-08-30）](HERMES-SKILL-CONFORMANCE-EVIDENCE-20260830.md)
- [Tavern + Story Profile 同仓候选发布审查](MONOREPO-RELEASE-20260831.md)
- [Nora MCP 接入 Hermes：远端部署记录](NORA-MCP-HERMES-DEPLOYMENT-20260830.md)
- [Nora MCP：右侧基础能力补齐与前端边界](NORA-MCP-PANEL-PARITY-20260831.md)
- [Nora MCP 0.3：现有插件运行控制](NORA-MCP-RUNTIME-CONTROLS-20260830.md)
- [Nora MCP 接入与技能收敛评估](NORA-MCP-SKILL-INTEGRATION-20260830.md)
- [统一更新流程（2026-09-10 历史设计）](UNIFIED-UPDATE-20260910.md)
- [Owner-confirmed updater activation — local verification](UPDATER-ACTIVATION-LOCAL-VERIFICATION-20260831.md)
- [Existing-Instance Update Safety](UPDATER-EXISTING-INSTANCE-20260910.md)
- [Updater implementation — local verification, not a production release](UPDATER-IMPLEMENTATION-20260831.md)
- [更新器整目录与数据迁移：隔离演练](UPDATER-ISOLATED-REHEARSAL-20260831.md)
- [更新器：程序升级与 Python 数据导入分开判定](UPDATER-NONBLOCKING-DATA-IMPORT-20260901.md)
- [更新器安全修正与未完成边界](UPDATER-SAFETY-20260831.md)

## 故事、界面与其他历史记录

- [Tavern / Story Profile 定向收敛记录](STORY-PROFILE-CLEANUP-20260831.md)
- [Nora 固定文案与 ST 翻译接口：本地交付记录](TAVERN-BILINGUAL-LOCAL-IMPLEMENTATION.md)
- [双语化 P0 执行记录](TAVERN-CLAWCHAT-BILINGUAL-P0.md)
- [Tavern 固定系统文案双语化与 ClawChat 语言跟随计划](TAVERN-CLAWCHAT-BILINGUAL-PLAN.md)
- [剧情账本：本地真实 30 轮验证](TAVERN-STORY-LEDGER-LOCAL-30-ROUNDS.md)
- [剧情账本插件：实现与交付边界](TAVERN-STORY-LEDGER-PLUGIN.md)
- [剧情账本 → Story Profile → Hermes 记忆投影](TAVERN-STORY-PROFILE-LEDGER-PROJECTION.md)
- [World Card character settings](WORLD-CARD-CHARACTER-SETTINGS.md)
- [World Visuals adaptation (2026-08-31)](WORLD-VISUALS-ADAPTATION-20260831.md)

已迁出的桌面专属文档不再作为本仓操作入口；保留的混合历史记录使用固定原修订引用追溯，不代表当前产品规则或当前验收通过。完整分类与迁出对照见[文件与文档结构汇总](../reports/20261110-core-documentation-structure.md)。
