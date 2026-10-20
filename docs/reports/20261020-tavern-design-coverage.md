# 酒馆全功能产品设计覆盖核对

日期：2026-10-20。设计集合：1.18。本文记录文档审查及后续两项隔离实测的来源、覆盖、差异及验证边界，不是产品全功能实机验收或发布证明。

## 目标与固定来源

用户要求继启动器、诺拉后检查最后一个模块。本轮补齐[酒馆设计](../product/tavern.md)，将原6节原则概要展开为26节、27类能力，说明入口、目标、操作、作用范围、结果、失败及验收。总览维护跨模块策略，酒馆维护其业务规则，技术说明和本报告不另立产品要求；原PR-03／04及既有流程锚点保留。

采用独立文档分支`codex/product-design-modularization-20261020`，基点主线`65a2a7a`，对应正式核心2.5.5／启动器2.2.5。原用户目录仍在较早提速分支，本轮只向其同步授权文档，不切换分支、不混入旧业务代码。

适用PB-01／02／05／07／08／09及PR-03／04／05／07／08／09／12／14。保留现有页面、默认行为、模型策略、脚本权限、用户内容和更新发布行为；本轮没有修改产品JS／Python、测试、依赖、凭据或用户数据，没有调用浏览器、测试机、模型、平台接口或线上服务。1.17已完成的诺拉运行规则修改保持，不在本轮再次改写。

## 功能覆盖与既有验收入口

下列测试在初次盘点时仅作相关入口索引；后续定向运行的45项检查见末节，也不保证每个场景都有充分自动覆盖。源码存在只证明相应实现路径；视觉、真实模型、复杂卡、并发及付费结果须按目标另验。

| 编号 | 能力 | 唯一规格 | 主要源码 | 既有测试入口 |
| --- | --- | --- | --- | --- |
| T-01 | 页面、导航与加载 | [设计](../product/tavern.md#interface) | [shell-controller.js](../../app/native-extensions/nora-ui/shell-controller.js) | [nora-ui-shell-contract.mjs](../../app/engine/sillytavern/tests/nora-ui-shell-contract.mjs) |
| T-02 | 欢迎世界与最后世界续接 | [设计](../product/tavern.md#interface) | [builtin-welcome.js](../../app/engine/sillytavern/src/nora-world-core/builtin-welcome.js) | [nora-builtin-welcome.test.mjs](../../app/engine/sillytavern/tests/nora-builtin-welcome.test.mjs) |
| T-03 | 世界选择与打开 | [设计](../product/tavern.md#story-flow) | [world-core-runtime.js](../../app/engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js) | [nora-world-selection-transaction.test.mjs](../../app/engine/sillytavern/tests/nora-world-selection-transaction.test.mjs) |
| T-04 | 创建与文件／卡库导入 | [设计](../product/tavern.md#story-flow) | [world-creation-controller.js](../../app/native-extensions/nora-ui/world-creation-controller.js) | [nora-world-core-client.test.mjs](../../app/engine/sillytavern/tests/nora-world-core-client.test.mjs) |
| T-05 | 重新开局 | [设计](../product/tavern.md#story-flow) | [world-restart.js](../../app/engine/sillytavern/src/nora-world-core/world-restart.js) | [nora-world-restart-ui.test.mjs](../../app/engine/sillytavern/tests/nora-world-restart-ui.test.mjs) |
| T-06 | 身份、归属与独立副本 | [设计](../product/tavern.md#world-and-library) | [st-backend-materializer.js](../../app/engine/sillytavern/src/nora-world-core/st-backend-materializer.js) | [nora-worldbook-edit-isolation.test.mjs](../../app/engine/sillytavern/tests/nora-worldbook-edit-isolation.test.mjs) |
| T-07 | 完整世界卡库 | [设计](../product/tavern.md#card-library) | [character-controller.js](../../app/native-extensions/nora-ui/character-controller.js) | [nora-card-library-dedupe.test.mjs](../../app/engine/sillytavern/tests/nora-card-library-dedupe.test.mjs) |
| T-08 | 角色资料与我的角色库 | [设计](../product/tavern.md#reusable-material) | [library-profiles.js](../../app/engine/sillytavern/src/nora-world-core/library-profiles.js) | [nora-library-profiles.test.mjs](../../app/engine/sillytavern/tests/nora-library-profiles.test.mjs) |
| T-09 | 独立世界书库 | [设计](../product/tavern.md#reusable-material) | [library-worldbooks.js](../../app/engine/sillytavern/src/nora-world-core/library-worldbooks.js) | [nora-library-worldbooks.test.mjs](../../app/engine/sillytavern/tests/nora-library-worldbooks.test.mjs) |
| T-10 | 当前世界玩家与人物 | [设计](../product/tavern.md#cast) | [character-controller.js](../../app/native-extensions/nora-ui/character-controller.js) | [nora-character-editor.test.mjs](../../app/engine/sillytavern/tests/nora-character-editor.test.mjs) |
| T-11 | 背景与条目编辑 | [设计](../product/tavern.md#settings) | [worldbook-controller.js](../../app/native-extensions/nora-ui/worldbook-controller.js) | [nora-setting-delete-editor.test.mjs](../../app/engine/sillytavern/tests/nora-setting-delete-editor.test.mjs) |
| T-12 | 预设库与世界预设 | [设计](../product/tavern.md#presets) | [library-controller.js](../../app/native-extensions/nora-ui/library-controller.js) | [nora-preset-editing.test.mjs](../../app/engine/sillytavern/tests/nora-preset-editing.test.mjs) |
| T-13 | 文本与MVU模型配置 | [设计](../product/tavern.md#models) | [model-controller.js](../../app/native-extensions/nora-ui/model-controller.js) | [nora-model-removal.test.mjs](../../app/engine/sillytavern/tests/nora-model-removal.test.mjs) |
| T-14 | 输入、生成、停止与阅读 | [设计](../product/tavern.md#generation) | [story-action-dispatcher.js](../../app/native-extensions/nora-ui/story-action-dispatcher.js) | [nora-story-action-dispatcher.test.mjs](../../app/engine/sillytavern/tests/nora-story-action-dispatcher.test.mjs) |
| T-15 | 消息编辑、候选与建议 | [设计](../product/tavern.md#message-actions) | [message-controller.js](../../app/native-extensions/nora-ui/message-controller.js) | [nora-message-controller.test.mjs](../../app/engine/sillytavern/tests/nora-message-controller.test.mjs) |
| T-16 | 持久保存与失败重试 | [设计](../product/tavern.md#save-and-retry) | [save-recovery.js](../../app/engine/sillytavern/public/scripts/nora-story-ledger/save-recovery.js) | [nora-ledger-save-recovery.test.mjs](../../app/engine/sillytavern/tests/nora-ledger-save-recovery.test.mjs) |
| T-17 | 账本整理与重置 | [设计](../product/tavern.md#ledger) | [ledger-settings-controller.js](../../app/native-extensions/nora-ui/ledger-settings-controller.js) | [nora-ledger-settings-ui.test.mjs](../../app/engine/sillytavern/tests/nora-ledger-settings-ui.test.mjs) |
| T-18 | 辅助备份与保留清理 | [设计](../product/tavern.md#backups) | [backup-controller.js](../../app/native-extensions/nora-ui/backup-controller.js) | [nora-backup-retention-safety.test.mjs](../../app/engine/sillytavern/tests/nora-backup-retention-safety.test.mjs) |
| T-19 | 备份预览与恢复 | [设计](../product/tavern.md#restore) | [backup-controller.js](../../app/native-extensions/nora-ui/backup-controller.js) | [nora-backup-ui.test.mjs](../../app/engine/sillytavern/tests/nora-backup-ui.test.mjs) |
| T-20 | 插件库与扩展 | [设计](../product/tavern.md#plugins) | [plugin-library-controller.js](../../app/native-extensions/nora-ui/plugin-library-controller.js) | [nora-plugin-library-ui.test.mjs](../../app/engine/sillytavern/tests/nora-plugin-library-ui.test.mjs) |
| T-21 | Helper、正则及卡片动作 | [设计](../product/tavern.md#scripts) | [card-action-gateway.js](../../app/native-extensions/nora-ui/card-action-gateway.js) | [nora-card-action-gateway.test.mjs](../../app/engine/sillytavern/tests/nora-card-action-gateway.test.mjs) |
| T-22 | MVU能力及逐轮效果 | [设计](../product/tavern.md#mvu) | [mvu-transaction-view.js](../../app/native-extensions/nora-ui/mvu-transaction-view.js) | [nora-mvu-source-result.test.mjs](../../app/engine/sillytavern/tests/nora-mvu-source-result.test.mjs) |
| T-23 | 外观与世界主题 | [设计](../product/tavern.md#visuals) | [world-theme-controller.js](../../app/native-extensions/nora-ui/world-theme-controller.js) | [nora-world-theme.test.mjs](../../app/engine/sillytavern/tests/nora-world-theme.test.mjs) |
| T-24 | 档案及诺拉交接 | [设计](../product/tavern.md#profile-handoff) | [story-profile-controller.js](../../app/native-extensions/nora-ui/story-profile-controller.js) | [nora-story-profile.test.mjs](../../app/engine/sillytavern/tests/nora-story-profile.test.mjs) |
| T-25 | 编辑、键盘与移动交互 | [设计](../product/tavern.md#interaction) | [dialog-controller.js](../../app/native-extensions/nora-ui/dialog-controller.js) | [nora-mobile-viewport-contract.mjs](../../app/engine/sillytavern/tests/nora-mobile-viewport-contract.mjs) |
| T-26 | 部署、维护、诊断与隐私 | [设计](../product/tavern.md#maintenance) | [nora-worlds-v2.js](../../app/engine/sillytavern/src/endpoints/nora-worlds-v2.js) | [nora-world-phase6-boundary.test.mjs](../../app/engine/sillytavern/tests/nora-world-phase6-boundary.test.mjs) |
| T-27 | 世界删除与历史保护 | [设计](../product/tavern.md#deletion) | [service.js](../../app/engine/sillytavern/src/nora-world-core/service.js) | [nora-world-v2-endpoint.test.mjs](../../app/engine/sillytavern/tests/nora-world-v2-endpoint.test.mjs) |

## 界面模块清单

盘点Nora UI目录40个JS模块／控制器，按实际入口与职责映射。模块数量、动作属性和控制器存在均不等于功能已验收；一项能力可能跨多个控制器，底层适配也可能比可见UI更宽。

| 模块 | 设计类别 |
| --- | --- |
| [activation-lifecycle.js](../../app/native-extensions/nora-ui/activation-lifecycle.js) | T-01／03 |
| [appearance-controller.js](../../app/native-extensions/nora-ui/appearance-controller.js) | T-23 |
| [backup-controller.js](../../app/native-extensions/nora-ui/backup-controller.js) | T-18／19 |
| [card-action-gateway.js](../../app/native-extensions/nora-ui/card-action-gateway.js) | T-14／21 |
| [card-capability-controller.js](../../app/native-extensions/nora-ui/card-capability-controller.js) | T-21／22 |
| [character-controller.js](../../app/native-extensions/nora-ui/character-controller.js) | T-07／08／10 |
| [composer-format-controller.js](../../app/native-extensions/nora-ui/composer-format-controller.js) | T-14／25 |
| [dialog-controller.js](../../app/native-extensions/nora-ui/dialog-controller.js) | T-25 |
| [extension-controller.js](../../app/native-extensions/nora-ui/extension-controller.js) | T-20／21／22 |
| [extension-usage.js](../../app/native-extensions/nora-ui/extension-usage.js) | T-20／21 |
| [index.js](../../app/native-extensions/nora-ui/index.js) | T-01／14／25 |
| [ledger-settings-controller.js](../../app/native-extensions/nora-ui/ledger-settings-controller.js) | T-17 |
| [library-controller.js](../../app/native-extensions/nora-ui/library-controller.js) | T-08／09／12 |
| [library-tabs.js](../../app/native-extensions/nora-ui/library-tabs.js) | T-07／08／09 |
| [message-controller.js](../../app/native-extensions/nora-ui/message-controller.js) | T-14／15／16 |
| [model-controller.js](../../app/native-extensions/nora-ui/model-controller.js) | T-13 |
| [model-display.js](../../app/native-extensions/nora-ui/model-display.js) | T-13 |
| [mvu-model-adapter.js](../../app/native-extensions/nora-ui/mvu-model-adapter.js) | T-13／22 |
| [mvu-transaction-view.js](../../app/native-extensions/nora-ui/mvu-transaction-view.js) | T-22 |
| [page-controls.js](../../app/native-extensions/nora-ui/page-controls.js) | T-01／25 |
| [panel-controller.js](../../app/native-extensions/nora-ui/panel-controller.js) | T-01／10／11／12 |
| [pending-message-view.js](../../app/native-extensions/nora-ui/pending-message-view.js) | T-14／16 |
| [performance-reporter.js](../../app/native-extensions/nora-ui/performance-reporter.js) | T-01／26 |
| [plugin-library-controller.js](../../app/native-extensions/nora-ui/plugin-library-controller.js) | T-20 |
| [preset-presentation.js](../../app/native-extensions/nora-ui/preset-presentation.js) | T-12 |
| [regex-controller.js](../../app/native-extensions/nora-ui/regex-controller.js) | T-21 |
| [shell-controller.js](../../app/native-extensions/nora-ui/shell-controller.js) | T-01 |
| [smart-reply-controller.js](../../app/native-extensions/nora-ui/smart-reply-controller.js) | T-15 |
| [st-message-view-adapter.js](../../app/native-extensions/nora-ui/st-message-view-adapter.js) | T-15 |
| [startup-controller.js](../../app/native-extensions/nora-ui/startup-controller.js) | T-01／02／03 |
| [story-action-dispatcher.js](../../app/native-extensions/nora-ui/story-action-dispatcher.js) | T-14／15／16 |
| [story-profile-controller.js](../../app/native-extensions/nora-ui/story-profile-controller.js) | T-24 |
| [story-scroller.js](../../app/native-extensions/nora-ui/story-scroller.js) | T-14／25 |
| [ui-operation-registry.js](../../app/native-extensions/nora-ui/ui-operation-registry.js) | T-01／25 |
| [ui-store.js](../../app/native-extensions/nora-ui/ui-store.js) | T-01／03 |
| [viewport-controller.js](../../app/native-extensions/nora-ui/viewport-controller.js) | T-25 |
| [world-controller.js](../../app/native-extensions/nora-ui/world-controller.js) | T-01／03／06／27 |
| [world-creation-controller.js](../../app/native-extensions/nora-ui/world-creation-controller.js) | T-04／05 |
| [world-theme-controller.js](../../app/native-extensions/nora-ui/world-theme-controller.js) | T-23 |
| [worldbook-controller.js](../../app/native-extensions/nora-ui/worldbook-controller.js) | T-09／11 |

## World Core与HTTP边界

当前导出门面与HTTP组合路由分别为32个方法、35条声明，两者不是一对一映射，更不代表全部酒馆后端。接口清单固定于本次来源；以后改接口以源文件为准，同步受影响规格与验收，不将本报告作为运行注册表。

| World Core职责 | 方法 | 设计类别 |
| --- | --- | --- |
| 完整卡库 | `listLibraryCards`, `saveLibraryCard`, `manageLibraryCard`, `readLibraryCardSource`, `deleteLibraryCard` | T-07 |
| 角色资料库 | `listLibraryProfiles`, `readLibraryProfile`, `saveLibraryProfile`, `deleteLibraryProfile` | T-08 |
| 世界书与原件导入 | `listLibraryWorldbooks`, `readLibraryWorldbook`, `saveLibraryWorldbook`, `deleteLibraryWorldbook`, `importLibraryItem` | T-09 |
| 创建与重新开局 | `submitWorld`, `createWorld`, `restartWorld` | T-04／05 |
| 原任务查询与重试 | `retryOperation`, `getOperation` | T-03／04／27 |
| 世界读取与打开 | `getWorld`, `listWorlds`, `prepareOpen` | T-03／06 |
| 当前世界编辑 | `updateWorld`, `editWorldbookEntry`, `addWorldSetting` | T-10／11 |
| 世界主题 | `setWorldTheme` | T-23 |
| 删除、检查与修复 | `deleteWorld`, `previewWorldDeletion`, `repairWorld`, `inspectWorld` | T-27 |
| 能力独立尝试 | `beginCapabilityAttempt`, `settleCapabilityAttempt` | T-21／22 |

来源：[index.js](../../app/engine/sillytavern/src/nora-world-core/index.js)；HTTP组合入口：[nora-worlds-v2.js](../../app/engine/sillytavern/src/endpoints/nora-worlds-v2.js)。

| 方法 | 路径（统一前缀`/api/nora-worlds-v2`） | 设计类别 |
| --- | --- | --- |
| GET | `/storage/inventory` | T-26／27 |
| GET | `/library/cards` | T-07 |
| POST | `/library/cards/import` | T-07 |
| POST | `/library/cards/manage` | T-07 |
| GET | `/library/profiles` | T-08 |
| POST | `/library/profiles/read` | T-08 |
| POST | `/library/profiles/save` | T-08 |
| POST | `/library/profiles/delete` | T-08 |
| GET | `/library/worldbooks` | T-09 |
| POST | `/library/worldbooks/delete` | T-09 |
| POST | `/library/worldbooks/read` | T-09 |
| POST | `/library/worldbooks/import` | T-09 |
| POST | `/worlds/:worldId/library` | T-07／08／09 |
| GET | `/theme` | T-23 |
| POST | `/theme` | T-23 |
| POST | `/backgrounds/import` | T-23 |
| POST | `/worlds/:worldId/theme` | T-23 |
| GET | `/status` | T-01／02 |
| POST | `/worlds/:worldId/worldbook-entry` | T-11 |
| POST | `/imports` | T-04 |
| POST | `/library-imports` | T-04 |
| POST | `/worlds/:worldId/restarts` | T-05 |
| POST | `/worlds` | T-04 |
| GET | `/operations/:operationId` | T-04／27 |
| POST | `/operations/:operationId/retry` | T-04／27 |
| GET | `/worlds` | T-03／06 |
| POST | `/worlds/:worldId/capabilities/:capability/attempts` | T-21／22 |
| PATCH | `/worlds/:worldId` | T-10／11 |
| POST | `/worlds/:worldId/settings` | T-11 |
| PUT | `/worlds/:worldId/capabilities/:capability/attempts/:attemptId` | T-21／22 |
| GET | `/worlds/:worldId/open-plan` | T-03／06 |
| GET | `/worlds/:worldId/snapshot` | T-03／06 |
| POST | `/worlds/:worldId/repair` | T-27 |
| GET | `/worlds/:worldId/delete-preview` | T-27 |
| DELETE | `/worlds/:worldId` | T-27 |

补充核对的主要业务来源：

- 欢迎与续接：[builtin-welcome.js](../../app/engine/sillytavern/src/nora-world-core/builtin-welcome.js)。
- 创建客户端与运行时：[world-core-client.js](../../app/engine/sillytavern/public/scripts/nora-worlds/world-core-client.js)。
- 独立世界与运行副本：[st-backend-materializer.js](../../app/engine/sillytavern/src/nora-world-core/st-backend-materializer.js)。
- 持久化及变更：[store.js](../../app/engine/sillytavern/src/nora-world-core/store.js)。
- 世界书引用核验：[worldbook-references.js](../../app/engine/sillytavern/src/nora-world-core/worldbook-references.js)。
- 故事持久化：[chat-persistence.js](../../app/engine/sillytavern/public/scripts/nora-story-ledger/chat-persistence.js)。
- 卡库旧删除适配：[st-card-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js)。
- 消息原生适配：[st-message-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-message-adapter.js)。
- 模型配置：[st-model-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-model-adapter.js)。
- 插件公开能力：[plugin-library-actions.js](../../app/engine/sillytavern/public/scripts/nora-controls/plugin-library-actions.js)。
- 档案业务桥接：[nora-story-profile.js](../../app/engine/sillytavern/src/nora-story-profile.js)。
- 受限MCP能力：[server.ts](../../nora-mcp/src/server.ts)。

这些来源按对应逻辑核对，不宣称逐行审计所有上游SillyTavern、第三方脚本、Hermes或ClawChat。未打开私人聊天／模型配置来证明故事已保存。

## 必须保持清楚的业务边界

- 存入资料库、从卡创建世界、世界内修改和另存资料是不同动作；同源原件去重不合并世界副本。重新开局保留原故事，聊天恢复也不重建已删世界。
- 用户消息尚未保存、已保存但回复失败、回复生成后保存失败、版本冲突和结果未知有不同续接；保存重试不直接等于重新付费生成。取消请求也不等于后端已停止。
- 聊天备份是辅助副本；后续[2026-10-08安全合同](../verification/chat-backup-retention-safety-20261008.md)已明确警告后继续合法前台操作，不能沿用更早备份失败即整体拦截的策略。程序替换前的恢复准备仍是另一种责任。
- 备份清单中的手动保留保护，不能外推为删除世界时仍留下该世界全部副本；世界删除预览包含归属明确的受保护聊天备份。更新回退包和未知文件不被顺便清理。
- 基础世界、Helper／正则权限、MVU运行时、变量初始化与每轮结果分别证明；插件安装、启用、刷新和脚本执行分别授权。没有通用操作系统／World沙箱承诺。
- 当前文本模型为酒馆用户全局配置，MVU另有配置；模型保存、运行采用与真实调用分开。外观能力接口不等于已有完整主题编辑器，MCP能力也不等于相同按钮。
- 档案与诺拉交接由诺拉文档维护；填入复盘草稿不等于发送。后台复盘费用／内容告知继续保持原有待确认状态。

## 本次发现及处置

### T-D01：过期World Core技术说明——文档已纠正

原README只列早期12项，仍将新内嵌世界书写作共享、Story Profile留v1回退，且把已经存在的编辑接口写作未来阶段。当前门面、物化器、引用保护和Story Profile桥接不支持这套描述。本轮同步[技术README](../../app/engine/sillytavern/src/nora-world-core/README.md)，按当前职责分组、明确新世界独立副本与旧资源边界，去掉过期阶段／上线断言。没有改业务代码或实际迁移数据。

### T-D02：创建结果不明后的表单重提——后续已复现，未修复

`world-creation-controller.js`的空白创建、本地导入每次提交生成新UUID；卡库／重新开局保留意图记录。`world-core-client.js`内部传输重试会保留提交键，运行时也读取pending记录。仅凭这两点不能判定全部表单重提最终都会造成重复；需要演示“服务器可能已经创建，但客户端未取得结果”后，手动重新提交是否准确查询原操作并复用同一意图。

初次盘点只登记疑点；后续按用户授权在隔离目录进行故障注入，空白／本地导入的手动重提已稳定复现1→2个世界，详见[实测记录](#suspect-runtime-check)。同一未知操作先查原任务的设计要求保持，产品代码尚未修复。

### T-D03：UI卡库删除与MCP路径不同——后续已确认保护不等效，未修复

UI的`character-controller.deleteGroup`调用`st-card-adapter.deleteCharacterCards`，使用`/api/characters/delete`和适用的`delete_chats`；MCP受管维护走`/api/nora-worlds-v2/library/cards/manage`。源码证明不是相同接口，不能用MCP的修订／引用保护直接证明UI等效。

后续[隔离实测](#suspect-runtime-check)确认两路均保护世界运行卡，但UI会删除查看后已变化的卡片，也会删除仍被旧群组引用的卡；MCP分别拒绝或保留。关联旧聊天经UI明确确认会一起删除，MCP保留，这是范围差异，不能单独称为未告知误删。产品代码尚未修复。

### T-D04：末页“下一页”可能发起新候选——现状已明示，交互选择待确认

`st-message-view-adapter.js`在多候选的最后助手消息仍展示可用的向右按钮；`st-message-adapter.js`在末页向右调用原生新候选路径并准备模型。MCP仅切换已有候选的窄合同不等于此UI行为。可能调用模型的边界已写入规格；是否调整末页文案、提示或按钮统一登记[总览决策](../product/README.md#decisions)，本轮不改UI或发起付费调用。

## 文档检查、保护与未验范围

| 检查 | 结果与限制 |
| --- | --- |
| 覆盖映射 | 27类能力、40个UI模块、32个World Core方法和35条所选HTTP路由均有对应规则；清单按固定源码解析比对，业务测试只作索引 |
| 文档链接与锚点 | 21份相关文档678个本地链接／锚点通过；旧基线27个标题锚点、14项PR目标／验收28段及唯一验收锚点保留；酒馆原4个显式流程锚点保留 |
| 既有文档导航 | Node24执行`tests/docs-navigation.test.cjs`，7通过、0失败、0跳过；未运行产品业务套件 |
| 变更范围 | 本轮9份Markdown，包含1份技术README；`git diff --check`通过，运行指令、产品实现、测试、依赖和用户数据未在本轮修改 |
| 工作区保护 | 同步前后按既有文件摘要核对，业务源码及所有授权文档之外的内容保持；本轮文档同步到原工作区，分支不切换，无关发布流程改动保留 |

检查记录和源码清单保存在本地忽略目录`local-state/tavern-design-coverage-20261020/`；不引入产品检测框架或新业务测试。

本轮没有产品业务源码修改，也没有合并、推送、构建或发布。结论是规格覆盖与技术说明已对齐到上述来源；不等于酒馆所有功能没有Bug，或上述疑点与待确认项已解决。


<a id="suspect-runtime-check"></a>
## 后续：两条疑点隔离实测

用户授权仅核对T-D02创建未知后的重试和T-D03卡库UI／MCP删除保护。适用PB-05／07／08及PR-03／04／07／09／12、T-04／07／16／27。使用固定当前源码、隔离生成内容与临时目录，模拟请求响应丢失或确认后目标变化，核对实际世界数量、归属、原件／聊天文件内容和错误。保留业务代码、交互、权限、用户真实数据及无关改动；不合并、推送、构建、发布，不使用Windows测试机。界面控制器、HTTP业务与磁盘数据结果分别举证，不用独立底层函数测试代替完整调用链。

### 明确结论

T-D02已由源码疑点变为可重复的重复创建缺陷；T-D03已确认保护不等效，其中卡片修订缺失和旧群组引用未保留均有反例。业务代码与交互本轮不修改，没有修好或部署这些缺陷。原界面已经明确告知的关联旧聊天删除，单独记录为范围差异。

### 实测方法与前提

- 使用固定源码`65a2a7a`，涉及的UI控制器、客户端／适配器、World Core、HTTP端点和MCP控制平面，与正式发行产品提交`4907f85917c5796db210743e208bc15d323bbcf7`的相应源码一致；没有拿原工作区较旧提速分支作为当前产品依据。
- 使用Node24、现有引擎依赖、真实World Core／ST物化器和卡片编解码器。进程工作目录为引擎目录，使用单独配置及临时DATA_ROOT，关闭磁盘缓存；每个样本具有自己的用户目录。只绑定本机随机端口，无真实模型、ClawChat、用户凭据或用户内容。
- 界面部分直接执行真实控制器生成的表单／按钮事件与真实浏览器适配器；DOM轻适配只提供表单值、选择器、事件和确认，世界打开回调不负责视觉验收。HTTP与文件写入、删除没有模拟成成功，故障仅在真实服务器已返回之后丢弃响应，或在确认期间写入一份新的合成卡。
- MCP部分从实际TypeScript源码在本地诊断目录转译控制平面及HTTP客户端，真实执行请求和错误解析；共享端点使用真实业务实现。没有启动MCP SDK的stdio工具发现／传输，也没有浏览器渲染和鼠标视觉验收，本轮证明的是两条业务路径的实际磁盘效果。
- 诊断脚本、原始结果、请求编号和摘要保存在本地忽略目录`local-state/tavern-suspect-verification-20261020/`。统一18场景脚本退出1表示已捕获预期安全条件不满足；本次`harnessErrors=0`，不能解释成测试工具失败。未把临时诊断引入产品源码或正式套件。

### 创建结果不明后重试

| 场景 | 实际结果 | 判定 |
| --- | --- | --- |
| 正常创建空白世界 | 1个世界 | 对照通过 |
| 第一次创建响应丢失，内部自动重试收到结果 | 仍为1个，同一请求编号 | 内部传输重试有效 |
| 空白创建的响应均丢失，确认服务器已有1个世界后，用户在原表单再次提交 | 变为2个，手动重提换了请求编号 | **已复现重复创建** |
| 同一本地卡导入的响应均丢失，用户再次选择该文件导入 | 变为2个，新的世界与会话身份 | **已复现重复创建** |
| 服务器返回操作编号后，查询响应丢失，空白创建再提交 | 变为2个 | **已复现重复创建** |
| 世界创建已完成，运行时读取列表失败，空白表单再提交 | 变为2个，旧pending此时已被清除 | **已复现重复创建** |
| 卡库创建遇相同响应丢失，重试同一张卡 | 仍为1个，意图记录保留请求编号 | 对照通过 |
| 响应丢失后模拟页面重开，沿用pending并正常刷新恢复 | 仍为1个，原任务完成并清除pending | 该续接路径通过；不表示任意手动重提安全 |

根因位置：[空白及本地导入控制器](../../app/native-extensions/nora-ui/world-creation-controller.js)的第135–136／191行在重新提交时分配新键；[客户端](../../app/engine/sillytavern/public/scripts/nora-worlds/world-core-client.js)仅在同一提交内部复用键；[运行时](../../app/engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js)记录失败但未让这两个表单的下一次提交强制续接原任务。列表读取失败还可能发生在客户端已确认创建并清除pending之后。

相同卡片内容允许用户有意创建不同世界，是原有能力；不能通过“同名／同源一律不准再建”修复这一问题。应保护的是一次尚未确认完成的用户意图。实测中原世界、原卡、原聊天、世界书及设置的已存在文件摘要没有变化；问题结果是多出世界及会话，不是本轮观察到覆盖原故事。

### 卡库UI与MCP删除对照

每条删除路径均在单独目录重建等价样本；最终验证每份样本有两个从同一原件创建、资源独立的世界，另有世界书、设置与适用旧聊天／群组。确认回调只同意页面实际展示的范围，不人为加入MCP保护。

| 场景 | 卡库UI实际结果 | MCP实际结果 | 判定 |
| --- | --- | --- | --- |
| 删除独立库原件，世界使用独立运行副本 | 删除选中原件，保留两世界／聊天／世界书及仍引用的源存档 | 相同保护结果 | 对照通过 |
| 尝试删除世界运行卡 | 可见按钮不可用；即使直接调用UI适配器也被后端409拒绝 | 拒绝该非独立库卡，本例400 | 两路均有世界归属保护，错误码不要求相同 |
| 页面查看／确认期间卡片被另一次写入改成新内容 | **仍按旧页面批准删除了新版卡片** | 用旧修订提交返回409／NORA_ST_RESOURCE_CONFLICT，保留新内容 | **已复现缺少修订核验，存在删掉未确认新版内容的风险** |
| 卡片仍被已有ST群组引用 | **卡片被删，群组文件未变，留下失效引用** | 返回referenced并保留原件 | **已复现引用保护不等效**；不等于已经删除Nora世界 |
| 库原件有同名绑定的旧兼容聊天 | 确认框明确说“角色卡及其关联聊天”，确认后卡与旧聊天都删除 | 将聊天视作引用，卡与旧聊天都保留 | 范围不同；UI此次删除已告知，不能仅凭此称为未授权误删 |

根因位置：[UI删除](../../app/native-extensions/nora-ui/character-controller.js)第106–137行及[适配器](../../app/engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js)第437–453行只传头像和`delete_chats`；[旧角色删除端点](../../app/engine/sillytavern/src/endpoints/characters.js)第1438–1463行先检查世界归属，再走无已查看修订的`deleteLibraryCard`，另行删除获准的聊天目录。[MCP控制平面](../../nora-mcp/src/nora-control-plane.ts)调用`manageLibraryCard`；[受管卡库](../../app/engine/sillytavern/src/nora-world-core/library-cards.js)第295–304行同时检查已查看修订与聊天／群组／设置等引用。

两路已共用部分底层删除机制，不能笼统说UI完全没有后端保护；缺的是上层同等的修订和引用准入。本次没有删到两个Nora世界的运行卡、所属聊天或世界书，其他既存内容摘要保持。这个保护样本不能外推成“界面任何删除都安全”，也不能把旧群组损坏外推成所有世界数据丢失。

### 重复验证与覆盖缺口

最终18场景在加上双世界数据保护后重复运行，关键结果一致，诊断执行错误0。统一脚本识别四个重复创建反例、两个UI删除保护反例；这六个场景归属前述两项问题，不是发现六套独立机制或声称线上发生率。第一次完整轮次也得到相同业务观察；旧聊天范围在最终判读中已明确分开。

另执行现有4份相关测试：`nora-world-core-client.test.mjs`、`nora-card-library-dedupe.test.mjs`、`nora-character-library-pagination.test.mjs`及`nora-world-restart-ui.test.mjs`，合计45通过、0失败、0跳过。它们覆盖内部同键重试、底层删除／引用、列表和部分重新开局，但没有拦住本轮UI上层反例；旧测试通过不能当作这两项安全条件已通过。

本轮没有修复产品或改变删除范围，也没有新增交互／正式回归用例、合并、推送或发布。隔离服务与数据已清理，合成内容证据只保存在本地诊断记录。待下一步明确修复授权后，需以这两条完整调用链锁住回归，而不是仅重复已有底层绿测。


<a id="policy-draft"></a>
## 1.19：删除、导入和费用设计推荐稿

用户要求先补产品设计，给出明确推荐，集中列出需确认项；不改代码、合并或发布。本节补设计依据与范围记录，实际规则由[酒馆设计](../product/tavern.md)、[共同费用](../product/README.md#model-use-and-cost)、[诺拉自动复盘](../product/nora.md#automatic-reflection-policy)维护；四项状态只在[总览决策](../product/README.md#tavern-policy-decisions)维护。本轮没有新增第五份产品规范、迁移、任务系统或费用统计器。

### 对当前入口的静态核对

| 事实 | 本次来源 | 能证明与不能证明的范围 |
| --- | --- | --- |
| 本地建世界的选择器有六种扩展名且多选 | [shell-controller.js](../../app/native-extensions/nora-ui/shell-controller.js) | 选择器不是解码或大文件成功证明；文案原来未列全 |
| 卡库文件入口只允许五扩展名、上限32 MiB | [st-card-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js) | 明确PNG／JSON／CHARX／YAML／YML的前置检查；BYAF未在此入口开放 |
| MCP存库／建世界共用文件检查，64 MiB、PNG／WebP／JSON／CHARX | [nora-control-plane.ts](../../nora-mcp/src/nora-control-plane.ts) | 只证明入口放行，不能将WebP放行等同受管后端支持 |
| 受管完整卡暂存六扩展名、100 MiB | [st-import-staging.js](../../app/engine/sillytavern/src/nora-world-core/st-import-staging.js) | 包含YAML／YML／BYAF，不包含WebP；单一后端范围不代表所有调用入口已接入 |
| 实际编解码分支与必要资源边界 | [st-card-codec.js](../../app/engine/sillytavern/src/nora-world-core/st-card-codec.js) | 容器可识别不代表任意内嵌附件／脚本都可完整使用，未做本轮格式／容量验收 |
| 资料预览1 MiB、通用JSON导入10 MiB、预设文件10 MiB；世界书后端对象另有32 MiB | [library-controller.js](../../app/native-extensions/nora-ui/library-controller.js)、[preset-file.js](../../app/engine/sillytavern/public/scripts/nora-worlds/preset-file.js)、[library-worldbooks.js](../../app/engine/sillytavern/src/nora-world-core/library-worldbooks.js) | 资源类型和入口不同，不能把完整卡上限推广到所有JSON文件；未改变既有上限 |
| 末页仍叫“下一页”，向右可进入原生新候选生成 | [st-message-view-adapter.js](../../app/native-extensions/nora-ui/st-message-view-adapter.js)、[st-message-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-message-adapter.js) | 说明动作名称与调用语义的差别，文案策略待确认；本轮没有调用真实模型 |
| 模型表单“测试并保存”、配置和保存结果分别存在 | [model-controller.js](../../app/native-extensions/nora-ui/model-controller.js)、[st-model-adapter.js](../../app/engine/sillytavern/public/scripts/nora-adapters/st-model-adapter.js) | 不凭“测试”文字直接推断已进行生成验证或产生费用；后续验收须辨认实际请求类型 |
| 自动偏好复盘当前按轮次资格调度 | [preference-checkpoint.js](../../story-profile/adapters/nora/preference-checkpoint.js) | 默认关闭、用途选择和旧安装补确认尚是N-Q01推荐，不是已实现功能 |

### 推荐取舍的审查依据

- 删除：本轮反例已证明修订与旧群组引用保护不足；这些底线不依赖是否保留旧聊天连带删除。推荐普通卡库只处理无引用原件，以复用受管业务并缩小普通删除影响；有引用时不能承诺一键清理。世界删除及受保护备份的原有明确范围保持。
- 导入：先统一业务对象和格式说明，保留入口已有容量。进一步核对发现直接导入100 MiB，因此未经容量验收直接统一64会缩小既有路径、统一100会扩大另两入口资源占用；推荐暂不改变容量。MCP允许WebP而受管卡接口不支持的事实被明确列出，不伪报已完成接入，也不扩大本轮为所有图像／容器兼容改造。
- 费用：普通故事不逐轮弹窗；明确动作、附随能力用途选择和后台偏好学习分别取得相应范围。推荐末页沿用原按钮位置和生成能力，只明确名称；自动复盘推荐可选默认关闭，需要新增明确选择而非仅改一句说明，旧档案与已确认选择保持。两项均待用户确认，不偷偷调整默认调用。
- 实施关系：既有创建重试／数据保护规则已确认，1.18两项Bug仍未修；四项推荐获批也不自动授权代码、合并或发布。后续只执行获批范围，不能因推荐稿存在就顺手补未批准功能。

### 文档验收

| 检查 | 本轮实际结果与边界 |
| --- | --- |
| 四项推荐 | 删除范围、完整卡支持、显式／附随调用及自动偏好复盘均有现状、推荐、取舍、保留数据和验收条件；状态均待确认，不冒充已批准 |
| 文档链接 | 21份相关文档731个本地链接／锚点通过；旧基线27个标题锚点、酒馆原27个显式锚点、14项PR目标／验收28段及唯一验收归属保留 |
| 既有文档导航 | Node24执行`tests/docs-navigation.test.cjs`，7通过、0失败、0跳过；没有运行产品业务测试／模型／浏览器／测试机 |
| 范围与保护 | 八份Markdown，启动器仅同步设计版本；`git diff --check`通过。业务实现、运行AGENTS／技能、测试、依赖和用户内容在本轮字节保持，原工作区分支及无关改动保留 |
| 本地交付 | 推荐稿及导航／记录同步至原项目目录；未提交、合并、推送、构建或发布。当前两项Bug保持未修复状态 |

本轮交付是已补齐的推荐稿和集中决策材料，**不是四项已经批准、产品已修复或完成发布验收**。新旧行为、用户代价、替代方案、支持入口、失败／保留边界及应验证结果已分别写入唯一责任章节，四项仍为待确认；其他模块旧待决项未在本轮重新打开或擅自取消。

<a id="policy-approval"></a>
## 1.20：推荐方案经用户确认

2026-10-20，用户对前一答复的四项推荐回复“好”；[总览决策登记](../product/README.md#tavern-policy-decisions)现已标为已确认。上节1.19的“待确认”是提出方案时的历史状态，不再代表现行批准状态。详细规则只在总览／酒馆／诺拉各自责任章节维护，本报告不复制另一套要求。

本次仅更新设计批准状态及相关版本、导航与追溯，范围为原八份Markdown；未改业务代码、运行AGENTS／技能、测试或依赖，不修改用户内容。重复创建与UI删除保护不等效仍未修复；格式接入、费用告知／末页名称及自动复盘选择均未完成对应实现与业务验收。保留1.18实测证据、现有容量和旧数据保护边界；未运行产品测试、模型调用或测试机操作，未提交、合并、推送、构建或发布。

文档检查：21份相关文档735个本地链接／锚点通过，旧基线27个标题锚点、批准前酒馆30个显式锚点及14项PR目标／验收28段保留；既有文档导航7通过、0失败、0跳过，`git diff --check`通过。检查仅证明文档导航与追溯完整，不代表上述设计已实现或完成业务验收。

<a id="create-delete-fix"></a>
## 续项：创建重试与卡库删除修复

用户已授权在独立分支修复T-D02／T-D03，并用隔离数据验证，不合并发布。分支为`codex/tavern-create-delete-safety-20261020`，基点`65a2a7a`，保留未提交的设计1.20及其他既有改动。适用PB-05／07、PR-03／04、T-04／06／07／24及已确认T-Q01。

范围：空白／本地卡创建的未知结果重试接续原意图，创建已完成但刷新／打开失败时只补后续步骤；界面卡库删除复用与MCP相同的受管业务，核对查看时的修订和实时引用，仅删无引用原件，聊天保留。保留原入口、正常有意新建、世界隔离、全部非删除目标的聊天／角色／世界／配置；不迁移历史数据，不清理已有重复世界，不接入其他三项设计，不改安装／更新／卸载或发行。

修复前再次执行既有真实调用链复现：18场景，四个重复创建、两个UI保护反例再次出现，执行器错误0。此前已通过故障位置单变量对照确认：手动提交换键、提交后列表失败，以及UI旧删除路径缺查看修订／旧群组引用准入。沿用该证据，不重新猜测网络或测试环境。将该真实UI控制器→适配器／客户端→本机HTTP→World Core与实际MCP控制平面的回放转为回归，先确认修复前失败；后续记录修复与实际结果。临时实例仅绑定本机随机端口，所有输入为合成内容，无真实模型或用户数据。

### 实际改动与必要性

| 改动 | 对应结果及移除后的后果 |
| --- | --- |
| 空白创建保留原意图；本地批次保留每项文件、原键及已创建世界 | 手动重试不分配新创建身份；已成功项不重新创建，打开失败只重试打开。完成后正常新建仍分配新身份。删除这层将重现表单重提反例 |
| 重新选文件时按名称、大小及实际字节核对；明确拒绝后只替换失败尾部 | 防止把变更文件套用到尚未确认的原任务；已成功前缀保留。只在重选时分块比较，新增工作缓冲约2 MiB，不整包复制或新增摘要依赖 |
| 客户端先续查同键，阻止覆盖其他未确认任务；World Runtime显示结果后再确认清除现有pending | 列表／角色读取失败及整页重载仍能找到原结果。新增整页重载反例先失败后通过；普通直接客户端默认结算行为保留，无新存储、后台服务或后端协议 |
| 界面带查看时的修订调用既有受管删除接口 | 后端同时检查修订和引用，与实际MCP使用同一业务；移除将恢复两个UI保护缺口。不改MCP或重写后端，也不改变独立世界／聊天归属 |
| 删除确认及结果区分原件、保留与部分完成 | 按已确认T-Q01取消关联聊天删除，不再把HTTP200但retained当作已删除；中途失败保留已确认结果并停止未开始项 |
| 本次提示补齐已有中英文词典 | 保留现有语言选择，不另建提示框架；仅增加此次新增文字 |

业务源码共六份，均服务上述结果；没有安装／更新／卸载、发行、依赖、费用授权或自动偏好复盘改动。创建结果完成确认复用现有pending键；没有新增永久去重表，也不按同名／同源全局合并世界。

### 实际验收

采用[正式回归文件](../../app/engine/sillytavern/tests/nora-world-create-delete-workflows.test.mjs)，通过现有`test:nora`的`nora-*.test.mjs`发现，不维护另一份正式驱动。真实控制器事件、ST适配器、World客户端、HTTP路由、物化器／卡编解码器、文件读写及MCP控制平面均实际执行；合成DOM只提供表单、确认和事件，故障注入位于真实提交或查询响应之后，不伪造服务端成功。

| 场景 | 实际结果 |
| --- | --- |
| 提交响应丢失、查询丢失、列表／角色刷新失败后重试 | 每次原意图保持一个世界，原世界／会话及其他既存文件摘要不变 |
| 世界已创建但列表失败，随后重载整页 | 续接记录保持到新页面取回原世界；恢复后记录清除、任务结束，不另建世界 |
| 空白／本地／卡库创建后打开失败 | 重新打开原世界，不再创建第二份 |
| 三文件批次第二项已接收但响应丢失 | 原成功项保留、第三项先不执行；相同输入重试后恰好三个导入世界，未重复前缀；未知时换内容被拒绝 |
| 三文件批次第二项明确无效，修正后重试 | 保留成功前缀，完成修正项及未开始项；结束后同一卡仍可有意另建独立世界 |
| 两入口删除无引用原件 | 仅原件与可清理库记录移除；两份独立世界、其运行卡／聊天／世界书、仍引用的源存档、独立角色／玩家资料及配置保持 |
| 两入口删除时存在旧聊天、群组、配置引用或引用记录不可读 | 原卡与引用均保留；界面不报告“角色卡已删除” |
| 查看／确认后卡片改变；尝试删除世界运行卡 | 两入口拒绝或保留；新内容、世界及聊天未被删。界面禁用的运行卡按钮还通过适配器强行请求验证后端拒绝 |
| 批量删除中途冲突、删除成功但页面刷新失败 | 针对适配器验证：停止后续请求，错误保留已确认删除／保留结果，不自动再次删除；不冒充整体成功或全部未执行 |

最终Node24在引擎规定工作目录执行10份相关测试：136通过、0失败、0跳过，其中新增31个隔离业务场景全部通过，执行器错误0。其余覆盖World客户端、重新开局、卡库去重、分页、详情、运行适配器、World UI边界、旧角色写入保护和中英文。额外`nora-ui-shell-contract=PASS nodes=20`；六份改动源码按项目owned配置ESLint通过，新集成回归按测试目录配置ESLint通过，差异格式检查通过。

核对关联旧用例：原适配器与详情断言要求旧端点／连聊天删除，已按T-Q01改为修订与保留结果；两条静态边界断言更新为统一打开辅助函数，真实动作由新增集成验证。未删旧用例或降低数据保护断言。执行中一次从仓库根调用绑定引擎工作目录的旧测试找不到默认配置，改用其既有引擎入口后通过；一次直接调用界面合同缺参数，按原调用协议补齐后通过；两者属于执行方式，未通过修改业务来适配。修复前反例与新增整页中断反例的失败日志均保存在本地忽略目录`local-state/tavern-create-delete-fix-20261020/`。

### 结论与未验范围

两项已实现，并达到本次要求的隔离数据业务验收；本次验收无剩余失败／跳过或直接阻断。已有真实用户内容未参与测试；样本覆盖既存聊天、角色／玩家资料、两个独立世界与世界书，以及含模型设置的配置摘要保护。没有清理线上历史重复数据，没有调用真实模型、连接测试机或部署程序。测试监听、临时数据和转译MCP文件均在finally清理。

尚未做真实浏览器／WebView鼠标视觉、Windows／Mac安装包和线上发布验收；本次没有安装包变化或发布授权，不将这些后续阶段称为已完成。代码保留在独立分支，未提交、合并、推送、构建或发布；原工作区与既有无关改动保留。其他已确认设计仍按各自未实施状态管理，本次没有一并实现。

交付核对：以开工前全部非忽略文件摘要为基线，只有六份业务源码、五份测试（含一份新增集成回归）和三份既有文档变化，共14份，其他原有改动字节保持，分支HEAD未变。21份相关文档738个本地链接／锚点、旧27个基线标题锚点、酒馆30个原显式锚点及14项PR目标／验收28段通过；文档导航7通过、0失败／跳过。该文档检查不代替前述业务验收，未另建发布或产品策略。


<a id="import-model-consent-fix"></a>
## 三项已确认设计实施：T-Q02／T-Q03／N-Q01

本轮用户授权独立分支 `codex/tavern-import-model-consent-20261020` 补齐导入格式、模型调用告知与自动偏好复盘选择。适用 PB-05／07、T-Q02／03、N-Q01；保留现有按钮、各入口容量、聊天、角色、世界、配置和此前两项修复。验收使用临时隔离数据、真实业务入口与可计数的本地模型替身，区分源码验收与真实服务／视觉／部署；不合并、推送、构建安装包或发布。目标是六格式内容校验一致、只读不触发生成、显式用途告知、额外自动调用先选择且关闭不启动新请求、手动能力与已有内容保留。实施与验收结果如下；既有章节按其历史日期保留，不代表当前仍为推荐稿。


### 当前结论

**T-Q02、T-Q03、N-Q01均已实现，并完成本轮隔离数据验收；没有本轮直接验收阻断。** 设计仍为1.20，没有新增产品策略或软件版本。源码与文档保留在`codex/tavern-import-model-consent-20261020`工作区，基点`65a2a7a`；本轮未提交、合并、推送、构建安装器、部署或发布，不影响正式用户的现有运行程序。此前重复建世界与卡库删除保护修复保留，并回放原场景。

| 已确认项 | 实际变化 | 用户可观察的结果 |
| --- | --- | --- |
| T-Q02完整卡格式 | 本地建世界、卡库存入、MCP存库／建世界均接受PNG、JSON、CHARX、YAML、YML、BYAF，进入既有内容解码与受管业务；MCP移除WebP完整卡放行，补空文件检查；选择器与支持提示补齐 | 六种有效卡可从相应入口导入；损坏／伪扩展名不能产生有效空壳世界；保留UI卡库32 MiB、MCP64 MiB、本地建世界100 MiB，不改背景／附件的WebP支持 |
| T-Q03主动与附随模型 | 原模型设置加入用途、必要内容、实际模型与费用说明；末页按钮和辅助访问名称为“生成新回复”，原处理管线保留；MVU和账本分别记录对应功能选择，未选择／关闭则不开始该项新模型请求 | 普通聊天动作仍直接操作，不每轮弹费用确认；查看已有候选仍是翻阅。旧设置保留，未选择的额外MVU使用基础正文解析，账本保留已应用记忆；在原设置入口可明确开启 |
| N-Q01自动偏好复盘 | 原Story Profile页增加独立开关，默认关闭；沿用原轮次资格、队列和检查点。选择保存在本酒馆用户根，与档案和世界游标分开；Node调度及Python每次请求都检查当前选择 | 未选择、拒绝、关闭时不会新发自动复盘；手动复盘不打开自动开关。重开保留选择；关闭后不再开始派生摘要的新请求，已发送请求可能完成／计费；旧档案和偏好保留 |

偏好学习已经保存而派生口味摘要失败时，原管线现在返回`refresh_error`并保留已保存结果；后台游标推进到已处理轮次，记录`preference_saved_refresh_failed`，不重新学习这场已完成复盘。派生摘要仍可用原显式刷新能力处理，没有新增任务系统。读取或打开档案不代替授权。

### 为什么这些实现需要保留

- 格式放行、选择器和工具说明在入口层收敛；内容解析仍用同一后端，不复制六套解析器，也不增加任意附件／远端下载能力。
- 费用选择和配置分开：否则保留原模型就会被误当成批准额外调用，或为关调用而覆盖用户配置。首次接管无Nora标记的旧MVU时，也只补缺省字段，保留其既有模型来源、名称、请求次数和正文解析选择。
- MVU的真实执行配置在**合并卡片覆盖之后**检查选择；只改界面勾选不足以阻止卡片重新开启请求。复用固定上游`7fe9ae7cfe01f13d606f7a2e533a458431fe318c`、原构建脚本和本地缓存依赖，更新受管补丁／产物及缓存修订22，没有升级上游或Hermes。
- 账本在原状态内增加相应用途选择，原恢复路径保留该选择；保留配置、已激活记忆及聊天保护，关闭不解除受保护历史。状态读取和参数保存不替用户同意自动生成。
- 自动复盘可能有“学习→派生摘要”两次请求，因此只在任务起点检查开关不够；Python下一次传输前再次检查，防止关开关后仍启动第二次。已发送请求不承诺撤回／退款。
- Story Profile仍以`story-profile/`为源码，嵌入快照及页面由既有同步脚本生成；没有手工分叉另一份档案、计费系统、服务、定时器或迁移用户内容。前端按现有源码链路编译，同步9份受版本管理的页面bundle／压缩／内联模块产物；公共lib在忽略的构建目录补足，生产bundle合同通过。这些均是本地前端资源，不是安装器或正式发布。

### 关联测试核对与实际验收

测试均使用临时用户根、合成卡／聊天／世界、随机回环HTTP端口和本地可计数模型替身；不用真实Key、不连接真实模型、Windows测试机或生产实例。实际调用生产控制器、MCP控制平面、HTTP路由、World Core、编解码与Python档案适配器；最小DOM替身验证事件及可访问名称，不将它称为真实视口视觉验收。

| 场景／检查 | 实际结果 |
| --- | --- |
| 两个真实界面处理入口＋实际MCP存库／建世界，逐六种格式 | 24组有效格式流程通过；本地建世界通过真实UI控制器，卡库经真实表单事件；MCP返回接管后继续等待真实完成，未把排队当完成 |
| 入口容量与内容拒绝 | 32、64、100 MiB的有效JSON卡分别通过对应真实入口；UI32／MCP64超限、后端100超限、空文件、六种伪内容与WebP完整卡拒绝通过；其他资源格式／容量未改。这是功能边界，不是性能或任意复杂卡承诺 |
| 原创建／删除保护回归 | 原31个故障、续接和删除场景继续通过；本文件合计63个业务子场景，无违规／执行器错误；已有聊天、角色／Persona、两个原世界、世界书及含模型设置的配置逐场景核对摘要保留 |
| 额外MVU许可与真实执行 | 固定上游实际设置计算器在卡片覆盖后阻止未选择／拒绝的额外请求，存量原配置不改；正文变量仍更新。首次错误结果后关闭不发第二次；有效许可沿用原执行／持久化协议 |
| 模型设置与候选界面 | 未选择、拒绝、开启、重开、关闭均通过真实处理函数；原模型和变量保留。末候选显示及辅助访问名称为生成，已有候选为翻页；原候选／发送／保存失败处理回归通过 |
| 账本自动用途 | 历史默认开启不当授权，读状态与调度无新请求；明确开启后执行、关闭后停新请求，恢复保留用途选择。当前会话模型、内容范围和费用在原设置说明；原存量记忆、历史保护及配置回归通过 |
| 自动偏好真实HTTP＋Python | 默认关闭与纯读请求数0；手动复盘可执行但不启用自动；开启后按原轮次执行并去重；重开保留选择；上下文载入期间关闭不开始；第一条回复返回前关闭，后续派生请求被阻止 |
| 偏好部分完成与保留 | 学习保存、摘要503后保留偏好并记录部分错误；重查同轮次不新增模型请求或学习；关闭／读取不清空档案。HTTP流程前后原聊天、角色卡、世界与模型配置保留 |
| 定向自动验收 | 23份入口／模型／档案／账本／UI／国际化测试合计**299通过、0失败、0取消、0跳过**；固定MVU源码与最终产物另**114通过、0失败、0跳过**。合计413项，不把数量外推为全部产品验收 |
| 源码与产物 | MCP锁定版本依赖下TypeScript无输出检查通过；18份业务JS ESLint、13份关联Node用例ES2022 ESLint无错误（保留既有Playwright对Node断言的警告）；Python语法、前端编译、运行资产生成、Story Profile源码／快照一致、20节点外壳合同通过；前端编译仍有体积建议警告 |
| 文档 | 总览／酒馆／诺拉的当前实施状态、工具格式说明及技术入口同步；历史推荐与批准记录按日期保留，后续状态链接到本节，不冒充已上线。文档链接／锚点和7项用户导航检查通过，差异格式检查通过 |

调度旧夹具原先隐含自动开启，现明确建立已获该用途选择的状态，另以新用例验证默认／旧游标不构成授权；没有删除行为／数据保护断言。Story Profile静态用例引用的旧`ops/scripts/profile_memory.py`已改为其现行源码归属`deployment/runtime/profile_memory.py`，原禁止旧模型回路断言保留。受影响测试的字符串引号作等价格式整理；Node 24的ES2022检查与旧Playwright lint分类分别说明，不改业务适配检查工具。初次MCP类型检查缺少本分支依赖，核实五项直接依赖版本匹配后复用现有本机依赖，未更改锁文件或产品依赖；最终完整类型检查通过。

### 剩余边界与交付状态

本轮没有剩余直接阻断。**尚未合并／推送／发布或替换真实用户程序**，现有用户不会因此立即获得新行为。未执行真实第三方模型计费／语义验收、浏览器／WebView目标视口视觉、安装包／线上升级、任意第三方脚本或所有复杂卡组合验收；这些不是本轮隔离源码任务已通过的证据，也不因列在这里擅自启动下一阶段。只验证用户已请求的三项结果及其直接回归，不宣称整个项目无Bug。

本地执行证据保存在忽略目录`local-state/tavern-import-model-consent-20261020/`：`acceptance-final.log`、`mvu-acceptance-final.log`、`mvu-build-final.log`、`frontend-compile.log`、`runtime-assets.log`、`mcp-typecheck-final.log`、`lint-source.log`、`lint-tests-final.log`、`profile-source-final.log`、`ui-shell-contract.log`、`documentation-verification.json`及`completion.json`。临时业务数据、服务、读写环境与缓存定时器由验收finally／after清理；源码分支、既有未提交改动与执行证据保留。


### 用户视觉验收实例

用户随后授权打开独立分支酒馆做视觉验收。沿用1.20、T-Q02／T-Q03／N-Q01与PB-05；仅启动上述源码的本机回环实例，配置、数据、档案和记忆均放在忽略目录`local-state/tavern-import-model-consent-20261020/visual-instance/`，不使用真实模型凭据，不修改生产实例、用户内容或交互。运行身份见该目录`runtime.json`；本次启动／页面可达与用户视觉结论分开记录，不据打开页面声称视觉已通过。未合并发布。

视觉打开后的纠正：首次隔离启动遗漏原生扩展的运行资源，主UI样式URL返回404，用户实际看到默认灰色按钮与未成形的弹层。不能将页面200视为视觉资源完整。仅将本分支的五份原生扩展复制到该隔离用户根，重启同一回环实例；主UI样式200且字节摘要与原源码相同，随后进行浏览器核对。未更改产品源码、布局设计或真实用户目录；不把该准备错误称为新增交互设计。

### 视觉验收续项：新增文案收敛

用户要求检查此次可见变化中冗长、重复的文案。适用PB-01／05、T-Q01／02／03与N-Q01；仅简化现有说明、悬停提示、启用确认和异常文案，保留全部控件、动作、默认值、数据范围与调用许可。验收核对中英文、删除与导入必要信息、确认框模型／费用／停止边界，定向回归原控制器并检查实际页面；不改布局、不合并发布。


<a id="copy-revert"></a>
### 用户撤回全部界面文案改动

用户最新明确要求“凡是文案改动都给我改回去”。本轮撤回本独立分支的模型／账本常驻说明、发送／智能回复／重生成悬停说明、末候选按钮改名、导入说明扩写与Story Profile解释／常驻状态段；恢复原模型和账本控制器、原翻页显示、原导入说明。新偏好开关仅保留功能名称和失败反馈；删除确认不恢复“删除关联聊天”的旧错误承诺，而移除说明正文。创建／删除新故障分支复用既有失败提示，不新增长说明，保留后台防重复、引用／修订保护和保留数据判断。此前1.20的界面告知／名称要求经此次明确指令撤回，设计1.21记录该取消；技术授权、能力与默认值不因撤回文字而取消。未修改真实用户数据或正式程序，未合并推送发布。

验收将检查原呈现、无撤回说明、开关持久化／拒绝和停止、创建重试不重复、删除仍保留数据、支持六格式不缩水；使用原隔离实例和关联定向回归，不重新执行无关全套或打包安装器。

实际结果：原模型管理、账本、消息呈现和界面词典四份源码与基点逐字一致；11份后端／调用许可／偏好调度／MCP功能源码摘要保持。八份定向用例覆盖139项；一条基于已撤回“核验”字样的断言改为错误类型，仍断言缺修订时网络请求数为0；针对其所在适配器及开关界面的最终重跑全部通过，其余已通过场景保留本次证据。前端资源生成、生产bundle合同、20节点外壳、ESLint、档案快照和7项文档导航通过。原隔离页面已刷新，浏览器确认故事档案仅显示新开关名称，无新增说明／正常状态段。完整记录在本地`copy-revert/`；未合并、推送、发布，不宣称全部界面视觉已获用户认可。


<a id="post-revert-audit"></a>
### 文案撤回后功能复核

用户要求再次确认文案撤回没有影响功能修复，并说明独立分支剩余实际改动，不合并发布。按设计1.21、PB-05／07、T-Q01／02及保留的调用开关／N-Q01检查。比较固定基点65a2a7a、撤回前`copy-revert/baseline.json`与当前工作区；查清恢复原文案时一并取消的界面提示／确认及其对真实操作的影响。只做审查、隔离回归与记录，不继续更改产品代码／用户界面，不构建安装器，不连接测试机，不合并推送发布。完整差异与调用许可、创建重试、删除、导入、偏好实际链路分别核对；不以文件摘要相同代替受影响界面处理函数的执行。


本次复核结论：文案撤回没有撤掉防重复创建、界面／MCP同源删除保护、六格式导入、MVU／账本调用开关或自动偏好功能。恢复原模型控制器同时取消新增MVU确认弹窗，直接操作原开关仍会保存调用选择；不是“只更换字符串”，但不绕过开关记录。账本沿用原确认流程；故事档案保留新开关、启用确认和失败反馈，取消说明、正常状态及模型名称展示；卡库删除的保留／部分结果在界面改用原通用失败文字，提示精度降低，后台结果、修订／引用保护和日志事实不改变。格式说明恢复原文案，选择器和真实导入仍支持六格式；“下一页”恢复旧名称，原生成处理函数未变。这些界面取舍来自已确认的文案撤回，不能描述为全部交互逐字未变。

实际执行10份功能回归161通过，固定MVU上游实际执行／持久化／覆盖后开关检查109通过，MVU无界面运行及设置采用35通过，共305通过、0失败、0取消、0跳过。真实控制器、MCP控制平面、本机HTTP、磁盘编解码及Python偏好流程覆盖63组创建／删除／导入子场景；本机模型替身计数覆盖默认／关闭不请求、开启后调用、关闭期间阻止后续派生请求、手动复盘独立、偏好已保存但派生摘要失败不重复学习。原聊天、卡、世界与模型配置的合成样本保护检查通过。没有调用真实模型、操作真实用户数据或连接Windows／Mac安装器。

规范审查：未发现本次撤回破坏数据保护或增加维护／发布逻辑的硬性违规。保留一项非阻断冗余：character-controller.js第141行的两条保留结果分支都显示原“角色卡删除失败”，可收为同一提示，当前不会改变请求、删除范围或结果判定；本次仅审查，没有顺手改产品代码。需求审查：上述五项功能继续满足本轮隔离回归条件，未发现直接功能阻断；真实第三方模型／计费和最终安装包未验，不据此称已部署或所有用户组合已通过。

剩余差异按用户结果归为：①创建意图与逐项续接；②受管删除修订与引用保护；③六格式导入和无效文件拒绝；④MVU／账本显式调用选择、配置保留及采用旧设置不重置模型；⑤默认关闭的自动偏好开关、调度／Python双重检查与部分保存续接。另保留此前模块化产品设计、诺拉运行规则／技能的职责与备份说明纠正、相关测试和前端／MVU／档案生成资源。这些文档与生成副本不是另一套产品功能，诺拉运行说明纠正也不等于本轮修改了更新器、启动器安装／更新／卸载实现。当前HEAD仍为65a2a7a，工作区差异未提交、合并、推送或发布。

核对期间全部非忽略产品源码和资源摘要保持；只追加本报告及忽略目录证据。原模型管理、账本界面、消息显示和主界面词典4份源码与固定基点逐字相同；11份后端调用许可、MCP和偏好实现与撤回前一致。`story-profile-source`与差异格式检查通过。日志与差异分类见`post-revert-audit/`。


<a id="control-style"></a>
### 自动整理控件样式收敛

用户反馈“账本控制样式有问题”并明确指出整体不协调。实际画面确认：故事档案的偏好开关为未按主题处理的原生白色复选框，账本自动整理为另一种原生方框，与现有MVU主题开关不一致。适用设计1.21、T-01／13／22及N-Q01，沿用本轮文案撤回。控件盘点：保留故事档案开关、启用确认、失败反馈、账本开关及原参数／重整／重置／返回控件，保留全部名称、选择默认值、存储和调用处理函数；不隐藏／合并／新增控件，不增加解释文案。仅将两处开关沿用MVU既有30×18主题开关几何、颜色和状态，偏好行采用同一左文右控对齐；补禁用、焦点及减少动效状态。核对两处真实画面、开关状态及宽窄布局，使用原隔离数据，不调用真实模型或修改正式程序，不合并发布。

实际验收：两处开关均已按现有主题显示为30×18控件，故事档案549px窄窗口和账本1280px窗口的实际画面已核对。账本沿用原确认流程完成开启、关闭，最终恢复关闭；故事档案保持关闭，并验证键盘焦点为2px主题描边。10项关联界面检查全部通过，CSS语法解析及档案资源同步检查通过。控制器、后端、偏好调度与词典文件未改变；actor.js除标签布局外保持一致。未增加文案或调用真实模型，未合并、推送、发布。亮色主题、系统减少动效及禁用态本轮仅核对规则，未作实际画面验收。证据位于本地control-style/。

<a id="ledger-panel-style"></a>
### 账本面板整体视觉收敛

用户指出上轮只调整开关未覆盖整体协调性，本轮按明确要求检查账本布局、字号、间距及按钮；适用设计1.21、PB-05、T-17／23／25。对照现有模型表单与扩展设置，实际画面与计算样式确认重置按钮15px、保存按钮12px，参数输入圆角6px而按钮10px，状态与参数对齐及分区间距不统一。仅收敛账本样式：统一文字层级、名称／值与参数输入对齐、输入与按钮几何、分区节奏和窄屏滚动。保留自动整理及原确认、全部状态与错误、重新整理、高级设置及三项参数、保存、重置及确认、返回／关闭和草稿保护；不增删控件、不改任何文案、调用处理、默认值或数据。使用原隔离实例查看展开／收起与窄屏，定向核对原控制器用例及源码摘要；不调用真实模型、不操作正式数据、不合并推送发布。

实际结果：账本统一13px操作／12px次级文字、38px按钮与输入高度、10px圆角、16px分区及同列对齐；高级参数在宽屏左右排、480px及以下上下排，避免原占位文字被截断。保留现有标题栏、返回层级与内容区滚动。控制器仅为原高级参数增加一个样式容器；移除该容器后文件摘要与本轮改动前完全相同，所有文案、控件与处理函数均未改变。另仅修改账本CSS、再生entry.js及两份压缩副本和本记录，其余2033份基线文件核对无新增变化。

本轮10项关联界面检查通过；CSS解析、前端生成与压缩内容一致性、生产bundle合同通过。实际页面检查1280×720、549×893、390×844、320×568：宽窄排版切换正确，无横向溢出，短屏可滚动且底部控件可通过键盘到达。参数300→301保存后读回，再恢复300；未保存关闭后取消、重置确认取消、开启自动整理确认取消均按原流程执行。最终保存按钮因无修改而禁用，自动整理保持关闭；完整可见文字与修改前一致。初次视觉回看发现原生details不能直接承担该网格，采用上述唯一容器解决后重新生成前端及核验；没有保留中间布局实现或新增长期样式测试夹具。仅核对当前暗色主题和本机浏览器，未据此声称真实手机／其他主题或安装包已验收。截图和检查证据在本地ledger-panel-style/，当前独立分支仍未提交、合并、推送或发布。

<a id="preference-default-on"></a>
### 自动整理故事偏好默认开启

用户最新明确要求“整理故事偏好默认开启”，据此将N-Q01改为默认开启，并保留用户已保存的关闭／开启选择。只改变不存在该项选择时的默认值，同步Node调度与Python逐请求读取，保持手动复盘、原轮次资格、去重、部分保存续接、开关关闭后停止新请求及数据保护；不改变MVU或剧情账本默认值、不增加界面说明。不存在设置文件或有效设置尚无该项时启用；损坏／无法读取的已有记录仍不自动调用，不覆盖记录。核对默认开启调度、关闭跨重开保存、历史选择、HTTP→Python的真实本地替身调用、关闭后阻止派生请求；检查文档和嵌入快照一致，不合并推送发布。

实际结果：设计版本同步为1.22。Node及Python已采用相同默认规则；保存仍沿用原格式，无迁移、不伪造用户启用记录。五份关联用例27项通过、0失败／跳过：尚无选择时默认开启并完成HTTP→Python→本地计数模型的复盘；只读查询调用数0；原检查点去重；关闭跨重开保留；历史无noticeVersion的关闭选择保留；损坏记录拒绝自动请求；手动复盘不覆盖开关；请求间关闭阻止派生模型请求；部分学习保存后不重复学习；原档案、聊天、角色、世界及配置保护通过。相关旧默认关闭断言据用户新要求改为默认开启，关闭保护断言保留，没有删除或跳过原场景。

故事档案嵌入快照同步及源码一致性检查通过；界面源码和文案没有变化。原隔离实例已加载新后台实现，并确认其此前保存的关闭选择仍为关闭，不以新默认值强制覆盖。新增用户默认显示开启由原界面处理函数的关联用例验证，未另做新用户浏览器画面验收；未调用真实模型、使用正式数据或构建安装包，未提交、合并、推送或发布。证据在本地preference-default-on/。

<a id="merge-design-check"></a>
### 合并前产品设计一致性检查

用户最新要求：此独立分支合并时检查是否符合产品设计文档。这是合并前必须完成的核对，不是本次合并或发布授权。以合并当时最新的总览、启动器、诺拉、酒馆四份现行设计及用户后续明确指令为准；当前设计为1.22，不把历史推荐稿或旧验收当作现行要求。

- 固定拟合并差异，对每项实际产品改动记录对应条款、用户结果、保留行为及实际验收证据，核对合并期间主线变化是否影响结论。
- 本分支重点核对创建未知结果续接／防重复、UI与MCP删除保护、六格式导入及原容量限制、MVU／账本调用选择与关闭保护、自动故事偏好默认开启且保留已保存关闭选择、全部用户数据保护。
- 界面核对以文案撤回及账本／档案样式确认后的要求为准，不重新加回已取消说明、按钮改名或其他交互；文档、作者源码和生成副本分别对账，不由过期测试倒改产品规则。
- 发现不一致时先明确是实现偏差、文档未同步还是缺少验证，处理相关项后再给出合并结论；未验范围单列，不把源码通过称为安装包或上线验收。规则变化取得确认，符合既有规则的修复按授权推进。

本次仅登记上述合并检查要求，未执行新的全分支一致性审查，未修改产品代码、合并、推送或发布。

<a id="premerge-design-review"></a>
### 产品设计审查、关联验收与本地主线合并

用户授权现在对照最新产品设计检查此分支，无设计偏移、用户数据保留且关联验收通过后合并本地主分支，不推送发布。固定基点为本地主线65a2a7a76619ae199761aaf116ca0e93673edf1e；当前改动尚未提交，审查范围是该基点至当前工作区的已跟踪差异及新增产品文档／四份测试。依设计1.22和最新明确指令，按code-review的规范与需求两个维度直接审查，不额外分派小任务。现有产品设计及报告提供规格来源，无需新建issue追踪流程。

合并条件：①全部实际变化可追溯到模块化产品文档、创建／删除修复、六格式、MVU／账本调用选择、自动偏好默认开启、文案撤回和样式统一的已确认范围；②相关业务及失败／重试／关闭／部分完成场景通过，合成聊天、角色、世界与模型配置摘要保留；③源码、MCP类型、嵌入档案及生成资源一致；④正式安装／更新／卸载实现、用户程序及真实数据未被改动。当前只合并源码，不要求本轮未请求的安装器、真实模型或线上渠道验收。

审查先发现文档一致性问题：当前条文仍混有被明确撤回的界面说明／按钮改名，以及兼容导航中固定的旧设计版本号。按最新已确认要求纠正文档正文，历史报告保留其当时结论，不借文档整理增加界面行为。测试选择覆盖创建／导入／删除的真实控制器→HTTP→MCP／磁盘流程、客户端与适配器、调用开关、档案HTTP→Python、账本原保护和固定MVU实际源码／最终bundle；不重跑未变化的启动器安装、更新或卸载门禁。执行命令与结果保存在本地premerge-design-review/，通过后封存提交再合并。

#### Standards：规范与维护审查

未发现本次合并范围内的硬性规范违规。创建续接复用现有World Core操作／pending记录，删除复用已有受管后端，六格式复用真实编解码，调用控制在相应真实执行边界检查；没有新增独立维护服务、更新系统或用户数据迁移。Story Profile只改作者源码并同步嵌入快照，MVU沿用固定上游补丁及最终vendor产物。保留一项非阻断冗余：character-controller.js的保留结果提示两分支相同；删除它不能增加产品保障，当前不为此改产品代码、重建前端。

#### Spec：现行需求一致性审查

对照设计1.22、用户文案撤回和默认开启指令，通过以下逐项核对：创建未知结果续接原任务／原键，批量只补未完成项；界面和MCP使用相同修订／引用保护，不连带删聊天；六格式和32／64／100 MiB入口限制保持；MVU／账本分别记录选择、关闭后不发新的对应请求并保留配置／已有内容；自动故事偏好尚无选择时默认开启、历史关闭跨重开保留、Python逐请求检查且部分保存不重复学习；账本和档案样式沿用主题且无说明文案恢复。模型面板、消息呈现和主界面词典与基点逐字一致，账本控制器移除新增样式容器后也与基点逐字一致。诺拉运行说明的更新职责／前端插件／本地模型配置恢复边界纠正与已确认设计一致；没有更改启动器、更新器、卸载、CI或发行工具实现。

本轮发现并解决两类直接检查问题：①现行正文残留已取消文案、候选改名、过期实现状态及导航版本号，现按最新确认同步，并将合并／部署状态集中链接到本节；②nora-presentation-boundary第147行旧断言仍要求已取消的“生成新回复”，初跑300项中299通过、1失败。原呈现源码已按用户要求恢复，故只改该断言为原“下一页”／原辅助访问名称，同时增加末页索引、原right入口与非禁用检查；该文件和消息／动作调度40项复验通过，之后完整关联组重新执行325项全通过。没有删除或跳过原场景，也没有为测试改回产品文案。

| 最终检查 | 实际结果与能证明的范围 |
| --- | --- |
| 24份相关业务／界面用例 | 325通过，0失败／取消／跳过；涵盖真实控制器→HTTP→MCP／编解码／磁盘、创建故障重试、引用／修订拒绝、各格式与容量、调用开关、偏好HTTP→Python和账本原保护 |
| 固定MVU实际源码及持久化合同 | 109通过，0失败／取消／跳过；卡片覆盖后开关检查和关闭后的重试阻止实际执行 |
| 隔离业务数据保护 | 63组子场景，违规0、执行器错误0；合成聊天、角色／Persona、世界／世界书、群组和模型设置按场景核对摘要，未操作真实用户数据 |
| Story Profile Python | 6项通过；既有档案、偏好和投影行为保留 |
| 用户导航／仓库布局 | 24项通过；文档链接和版本另行全量核对 |
| 静态／生成资源 | MCP TypeScript无输出检查、16份适用业务JS ESLint及档案UI专用全局检查通过；生产bundle、20节点外壳、档案源码／嵌入一致性通过；最后产品源码和资源摘要与受验版本一致 |
| 文案及范围 | 撤回内容保持；启动器安装／更新／卸载、发布工具和依赖未改变，未发现本次合并范围外的产品行为 |

执行方式更正单独记录：初次外壳合同调用未传两个必需文件参数，补齐后通过；初次将独立档案UI套用通用lint时缺其HTML提供的I18N／TavernUI全局及原空catch约定，按该页面实际宿主配置独立检查后通过。未修改这些工具或产品来掩盖错误，原始日志保留；这两次调用结果不计作已通过验收。

合并前结论：本次范围未发现未授权的产品设计偏移，相关验收通过，用户数据保护场景通过，无剩余直接合并阻断。账本／档案的本机浏览器视觉证据复用本报告前述检查，源码摘要一致；没有重新做所有主题、真实手机／WebView、真实第三方模型计费语义、正式安装包或线上升级验收。本次批准的是本地源码合并，不据此宣称正式用户已获得更新或项目全部功能无缺陷。封存提交与实际合并结果随后补记。
