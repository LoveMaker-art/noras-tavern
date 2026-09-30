# SillyTavern 1.19.0 上游升级评估

日期：2026-09-29。当前证据等级：**已实施、技术验证通过，并经授权部署本机 8799；未做本轮目标页面验收**。实现位于 `codex/helper-upstream-upgrade`；整合及部署证据见 6.5。第 1–5 节为实施前评估，第 6 节为按时间追加的实施记录。

## 1. 目标与证据边界

目标是确定 Nora 内嵌 ST 核心的可靠升级目标，列出会影响自定义前端、酒馆助手、MVU 和存储的行为变化，为后续范围确认与合并提供依据。本轮仅新增本文件。检查时工作区已有 Helper、MVU、Nora 构建产物及存储设计文档的未提交改动，全部保留。

核查起点由工具 UTC 时钟确认为 `2026-09-29 09:03:43 UTC`；版本结论同时依据 GitHub 实时 API 和官方发布页，不由本机日期推断。项目实际基线是 **1.18.0**：主任务核查了 `app/engine/sillytavern/package.json`；本地 [Phase 0 基线](../architecture/PHASE-0-RUNTIME-BASELINE.md) 也记录上游兼容提交 `51ad27fb86d39a3daca3adaa970375c9670c12df`。因此不以 1.13.4 为升级起点。

实施状态见第 6 节；前文保留升级前的评估证据，不代表当前仍未实施。

## 2. 可复核的版本锁定

| 对象 | 核查结果 | 来源 |
| --- | --- | --- |
| 最新正式发行 | `1.19.0`，`prerelease=false`，发布于 `2026-09-14T18:05:11Z` | [官方发行页](https://github.com/SillyTavern/SillyTavern/releases/tag/1.19.0)、[latest API](https://api.github.com/repos/SillyTavern/SillyTavern/releases/latest) |
| 正式 tag 对应提交 | `7e8663cd9c184a550b37238218bdd32c6efc68e9` | [tag API](https://api.github.com/repos/SillyTavern/SillyTavern/git/ref/tags/1.19.0) |
| `release` HEAD | `06bde939fb1e9c4c8d8641d810f0a916b5bce127`；比 tag 多 1 个 npm 发布工作流修复，只有 `.github/workflows/npm-publish.yml` 变化 | [固定比较](https://github.com/SillyTavern/SillyTavern/compare/7e8663cd9c184a550b37238218bdd32c6efc68e9...06bde939fb1e9c4c8d8641d810f0a916b5bce127) |
| `staging` HEAD | `bc81b9f7e33f39afe3f919a66faaf93079276a1c`，提交时间 `2026-09-23T21:19:13Z`；比 tag 多 8 个提交 | [固定比较](https://github.com/SillyTavern/SillyTavern/compare/7e8663cd9c184a550b37238218bdd32c6efc68e9...bc81b9f7e33f39afe3f919a66faaf93079276a1c) |
| 1.18.0 → 1.19.0 | 官方比较 API 返回 86 个提交、102 个变更文件；包含测试、文档及界面文件，不代表 102 个 Nora 运行文件必须替换 | [版本比较 API](https://api.github.com/repos/SillyTavern/SillyTavern/compare/1.18.0...1.19.0?per_page=100) |

建议以 **1.19.0 固定 tag/SHA** 做可复现的升级评估。官方将 `release` 定义为推荐稳定分支，`staging` 为可能随时破坏的开发分支；不能把开发分支当作另一个正式发行版本。[官方分支说明](https://docs.sillytavern.app/installation/)

当前 staging 中主要功能增量是 GPT-6 Sol/Luna、Claude Opus 5.5 和 Gemini 3.8 Flash 的支持；其余新增提交包括 npm 工作流同步、注释/README 拼写与 API 测试费用文案。它们不应混入“1.19.0 已发布内容”。[模型支持 PR #6070](https://github.com/SillyTavern/SillyTavern/pull/6070)、[固定 staging 比较](https://github.com/SillyTavern/SillyTavern/compare/7e8663cd9c184a550b37238218bdd32c6efc68e9...bc81b9f7e33f39afe3f919a66faaf93079276a1c)

## 3. 1.19.0 的相关变化与接入风险

以下“影响/验收”是基于上游行为对 Nora 的工程推断，不能视为已发生回归或已经兼容。

| 范围 | 上游事实 | Nora 影响与必要验收 |
| --- | --- | --- |
| 聊天完整性 | 非空文件头无法解析为 JSON 对象时拒绝普通覆盖；兼容 BOM、空文件及旧版无 integrity 元数据头。`skipIntegrityCheck` 和入参无 slug 的既有绕过语义仍存在 | 将校验融合到现有保存路径；验证损坏头保留原字节、错误明确返回、旧数据能读。不能宣称有 slug 检查就防住所有覆盖。[#5928](https://github.com/SillyTavern/SillyTavern/pull/5928) |
| 分支/检查点 | 新建分支和检查点使用新 UUID integrity slug | 验证 Nora 会话身份、恢复 receipt、消息变量、候选回复及账本关系不误复用父会话身份。[#5943](https://github.com/SillyTavern/SillyTavern/pull/5943) |
| 备份 | 非 ASCII 名增加原始名的 SHA-256 短摘要；节流由用户级改为用户与传入名称联合键 | 上游按名称消冲突不等于 Nora world/session/resource 归属。Nora 已有队列和保留策略，应保留其权威身份，不重新引入原生 `backupChat` 双写。[#5944](https://github.com/SillyTavern/SillyTavern/pull/5944) |
| 聊天列表 | 末行损坏仍返回降级预览；扫描时删除文件不会导致进程错误 | 验证 Nora 列表不把降级预览当成空聊天而覆盖；文件消失与权限错误分别处理。[#5969](https://github.com/SillyTavern/SillyTavern/pull/5969)、[#5871](https://github.com/SillyTavern/SillyTavern/pull/5871) |
| 消息格式化 | `getContext().messageFormatter` 新增正则前、正则后、Markdown 后同步字符串 hook；所有 hook 均在 DOMPurify 前 | 保留 Nora 定制消息渲染和脚本/iframe 生命周期；不可据此把异步 Helper 渲染直接搬入 hook。核对新模块打包、context 暴露、正则顺序和净化边界。[#5652](https://github.com/SillyTavern/SillyTavern/pull/5652)、[固定源码](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/message-formatter.js) |
| 候选回复 | `/addswipe switch=true` 改为调用标准 `swipe()`；不切换时更新计数/按钮；保存后不再重载完整聊天 | 依赖聊天重载事件的 Helper/MVU 初始化需要核查；验收新增/切换候选时变量恢复、脚本仅执行所需次数和消息状态持久化。[#5903](https://github.com/SillyTavern/SillyTavern/pull/5903) |
| 消息删除 | 删除 assistant 消息默认连同前置的工具调用系统消息；`deleteMessage` 新增第 4 参数，`/cut`、`/del` 支持 `toolcalls` | 验证消息索引、MVU 回滚、账本截断及删除范围；不能默认仍是一条消息变更。[#5949](https://github.com/SillyTavern/SillyTavern/pull/5949) |
| 连接/预设 | `PresetManager.selectPreset()` 返回 Promise，等待 OpenAI 预设事件应用完成，以免后续 `/api`、`/model` 被旧设置覆盖 | Nora 的同名方法已是 async 且有自定义应用入口，不能照搬再叠一层；需要最终 provider/model/preset 一致性验证。[#5930](https://github.com/SillyTavern/SillyTavern/pull/5930) |
| 自定义请求 | Custom OpenAI-compatible headers、include/exclude body 在发送/状态检查等路径解析宏 | 检查 Helper/MVU 请求是否同样走此构造器、是否重复展开，以及世界切换后读取的变量和配置归属。[#5627](https://github.com/SillyTavern/SillyTavern/pull/5627) |
| 扩展发现 | 服务端跳过无 manifest 文件夹；前端剔除无法加载 manifest 的扩展名 | 验证受管 Helper、MVU 与 nora-ui manifest 均可读，缺失扩展产生清楚的能力状态而非永久等待。[#5934](https://github.com/SillyTavern/SillyTavern/pull/5934) |
| 宏/世界书 | 数组/对象变量宏、作用域注释和空白处理修复；世界书改名更新更多绑定，排序交互优化 | 检查复杂卡提示词、包含管道符的参数、World 知识绑定改名后的读写。不要把上游宏变量等同于 MVU 全量状态协议。[#5649](https://github.com/SillyTavern/SillyTavern/pull/5649)、[#5643](https://github.com/SillyTavern/SillyTavern/pull/5643)、[#5644](https://github.com/SillyTavern/SillyTavern/pull/5644)、[#5610](https://github.com/SillyTavern/SillyTavern/pull/5610)、[#5637](https://github.com/SillyTavern/SillyTavern/pull/5637) |
| 卡片导入/更名 | BYAF 使用精确 ArrayBuffer 切片，避免 Buffer 池无关字节；角色更名的目录复制增加过滤器规避 Windows cpSync 问题 | 保留 Nora 原件与运行卡分离、真实 avatar 身份和 Helper 扩展字段保存逻辑。ST 升级本身不是 Helper 同名卡持久化问题的修复。[#5917](https://github.com/SillyTavern/SillyTavern/pull/5917)、[#6012](https://github.com/SillyTavern/SillyTavern/pull/6012) |

其他已发布收益包括更新模型支持、Google 模型全分页、工具调用流式 ID 去重、HTTP 200 错误体展示、OpenAI tokens 修正及移动端自动补全优化。它们可改善日常使用，但应以 Nora 实际暴露的提供商与路径决定验证范围。[1.19.0 发布说明](https://github.com/SillyTavern/SillyTavern/releases/tag/1.19.0)

## 4. 安全变化：区分新增与既有

1. `/api/search/visit` 禁止 localhost 与 `.localhost`，识别带括号 IPv6，并通过 `getUntrustedRequestAgent()` 对 DNS 结果、重定向和连接地址执行限制；启用全局私网过滤或出站代理时委托既有 agent 链。接入涉及 `search.js`、`private-request-filter.js` 与启动初始化参数，不能只复制 URL 字符串判断。[#5749](https://github.com/SillyTavern/SillyTavern/pull/5749)
2. 账户重置新增失败尝试速率限制配置，默认 5 次/300 秒并返回 429，重置码变为 6 位。主任务确认 Nora 不包含 `src/endpoints/users-private.js`；应按实际可达账户流程判定适用性，不能为了移植这个修复新增账户子系统。[#5603](https://github.com/SillyTavern/SillyTavern/pull/5603)
3. `.npmrc` 增加 `allow-directory/file/git=none`；`allow-remote=none` 因 npm 问题被注释，不能声称已禁止所有远程来源。已有 `ignore-scripts=true` 和 `min-release-age=7` 继续保留；需检查 Nora 构建所用 npm 的支持情况及本地依赖方式。[#5663](https://github.com/SillyTavern/SillyTavern/pull/5663)、[#5668](https://github.com/SillyTavern/SillyTavern/pull/5668)

官方公开 advisory API 本次返回的修复版本均为 1.18.0 或更早：例如密码变更后会话失效、SSO header 注入、CORS proxy SSRF/XSS 等已标注在 1.18.0 修复。不能把这些全部算成这次 1.18→1.19 的新增收益；也不能据当前列表断言 1.19 没有未知漏洞。[官方 advisory 列表 API](https://api.github.com/repos/SillyTavern/SillyTavern/security-advisories)、[会话失效 advisory](https://github.com/SillyTavern/SillyTavern/security/advisories/GHSA-wmm3-h9qj-p5v6)

## 5. 本地融合边界与建议验收

主任务的本地只读检查补充了这些高优先级边界（该检查不是运行验收）：

- `src/server-startup.js` 仍挂载 `/api/search`；本地 `/visit` 仍使用旧式 IP 拒绝检查、没有严格 agent，因此该安全修复有具体可达的合并价值。
- `src/endpoints/chats.js` 的 `trySaveChat` 已有 `resolveStoryLedger().writeChat(activityToken)`、恢复 receipt、部分保存保护和 `queueChatBackup`；应逐段融合完整性/扫描修复，保留上述所有者与存储语义。本地还有 `verifyWriteBase`、`getChatData` 和账本保存保护，因此“缺少上游损坏头显式拒绝”不等于已经证明可以覆盖损坏文件；要用故障夹具验证实际路径。
- `public/scripts/preset-manager.js:436` 已通过 `applyOpenAIPreset(name)` 异步直接应用配置；`openai.js:4943` 是 Nora 无原生界面依赖的入口。应保留直接应用流程，不能退回依赖原生 DOM change 事件的上游等待模型。
- `bookmarks.js` 创建分支/检查点的新元数据仍缺少上游的独立 integrity UUID。`src/chat-backup-store.js:142` 则已核实 manifest 所有权后按 `[worldId, sessionId]` 摘要建立备份身份，运行队列按文件归组；这已经超出上游按名字解决 Unicode 冲突的方案，不应退回原生备份子系统。
- Nora 单用户 workspace 流程主动移除了 `users-private` 等原生模块；升级不能恢复原生多账户、插件菜单或被移除的 UI 子系统。

主任务通过 GitHub compare 与 Git tree blob SHA 对 102 个上游变化路径进行比较：28 个本地文件与 1.18.0 字节相同，37 个本地已有改动，37 个在 Nora 路径中不存在。不存在的集合混合了上游新文件与 Nora 主动移除区域；它不是 37 个缺陷。已有改动也不是已经确认的 37 个合并冲突。没有文件与 1.19.0 最终 blob 字节相同，不排除 Nora 已实现等价行为。

主任务随后下载官方 1.18.0/1.19.0 源码到临时目录 `/tmp/nora-st-core-review.1IBwFq/`，对 37 个本地修改文件运行 `git merge-file -p` 三方只读演练（本地、1.18.0、1.19.0）：**17 个文本冲突、20 个文本自动合并干净**，没有写回应用文件。这是文本合并证据，不是实际合并、语义兼容或测试通过。17 个冲突路径为 `default/content/settings.json`、`public/index.html`、`public/script.js`、`public/scripts/{authors-note,bookmarks,extensions,group-chats,openai,preset-manager,reasoning,slash-commands,st-context,tokenizers,world-info}.js`、`src/endpoints/backends/chat-completions.js`、`src/endpoints/chats.js`、`src/endpoints/extensions.js`。

升级建议安排在当前 Helper 版本冻结之后的独立阶段，以安全边界、聊天损坏头拒绝和分支 integrity 等缺失行为为优先级。当前 Helper 4.11.2 manifest 的最低客户端版本是 1.13.0（主任务本地检查），因此不能把 ST 1.19.0 当作安装该 Helper 版本的强制前提。

允许进入实现前，应由主任务给出精确三方差异与保留清单。推荐的可观察验收目标：

1. 既有 Nora 界面入口、角色卡导入、Helper 脚本保存/重新加载、普通聊天保持原有行为；两个同名世界不能互相改写。
2. MVU 卡在生成、切换候选、删消息、恢复聊天、切换世界后保持正确变量与模型路由；不得依赖被上游删除的全聊天重载副作用。
3. 损坏头保存失败保留原文件；正常保存/备份分别报告状态；现有恢复、并发控制与保留预算不被上游按名字的备份逻辑替代。
4. 新 formatter 文件及相关 context 接口进入发布构建；插件缺 manifest 时明确失败，不阻塞 Nora 基础聊天。
5. 安全回归覆盖 localhost、IPv6、私网解析/重定向及实际出站代理配置；不得靠放松限制掩盖兼容问题。

Node 要求在固定 1.19.0 的 `package.json` 为 `>=20`；官方两版本 `package.json` 差异仅版本号，因此本次上游跨度未新增 Node 主版本或依赖声明迁移需求。这不等于 Nora 打包/锁文件可以跳过核查。[固定 package.json](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/package.json)、[官方比较](https://github.com/SillyTavern/SillyTavern/compare/1.18.0...1.19.0)

本评估没有证明第三方 Helper/MVU 全面兼容，也没有完成产品流程、性能或视觉验收；实施、部署与真实数据操作仍是后续独立阶段。文档站可能滞后于发行，遇到“仅 staging 可用”等旧描述时，应以固定 tag 代码和发行记录确认该版本事实。

## 6. 按确认范围实施 ST 1.19.0（2026-09-29）

用户确认执行第 5 节的融合方案。本轮在原独立分支保留 Helper 4.11.2 和 World ID 授权工作，使用固定 1.18.0 / 1.19.0 源码进行三方融合。`package.json`、锁文件根版本同步到 1.19.0；不是用上游目录覆盖 Nora，也不是把版本号改成 1.19 而不合入代码。

### 6.1 具体处理

| 边界 | 本轮实现与保留 |
| --- | --- |
| 聊天保存 | 合入损坏非空文件头拒绝、损坏末行的降级预览、扫描时文件消失处理。保留 `trySaveChat` 内的 Nora 保存协调、账本、恢复回执、备份队列。未恢复上游按名字限流的 `backupChat` / `getBackupFunction`。 |
| 聊天分支 | 分支与检查点生成新 integrity UUID；保留本项目单世界会话入口，不恢复 ST 群聊。 |
| 消息与候选 | 合入工具调用消息随正文删除、`/addswipe` 走标准候选切换事件而不重载整段聊天。没有修改 MVU 提示词、协议或执行核心。真实卡的候选 iframe 生命周期仍待页面验收。 |
| 预设 | `/preset` 等待选择完成；保留 `applyOpenAIPreset` 的无 DOM 状态入口，并提供上游 `getPresetApplicationPromise` 等待接口。未依赖被移除的设置下拉框。 |
| 模型请求 | 合入上游模型参数、流式工具 ID 合并、Google 模型分页等变更；新会话亲和密钥通过现有 `workspace.js` 获取，不复活已移除的 `users.js`。保留 Nora 独立 MVU 端点与密钥路由。 |
| 消息格式化 | 新 `message-formatter.js`、三个格式化 hook 和 `getContext().messageFormatter` 进入源码及发布资源。修正上游实际传入 `ch_name` 与文档 `characterName` 的不一致，同时保留前者别名；所有 hook 仍在 DOMPurify 之前。 |
| 扩展发现 | 保留插件库授权和延迟激活；缺 manifest 的残留目录、断链不再被发现。前端只剔除已尝试加载但失败的 manifest，不把“用户主动停用”误判成扩展不存在。 |
| 网页抓取 | 合入不可信 URL 的连接级私网过滤；测试覆盖 localhost、IPv4/IPv6、DNS 解析成私网、后续目标检查、已配置代理不被直连绕过。显式白名单的本地模型端点仍可用；未验证真实远端代理服务。 |
| 世界书与宏 | 合入世界书重命名绑定、排序 UID、宏数组/对象以及 token 计数修复；保留 Nora 世界书副本与私有绑定保护。 |
| UI / 安装策略 | Nora 首页、中文默认预设、主题和插件管理不被 ST 页面替换；不恢复上游多用户、群聊及已移除扩展 UI。保留 `.npmrc` 策略：项目仍有受控的 `file:vendor/*` 依赖，未机械引入禁止所有 file 依赖的上游设置。 |

### 6.2 回归中实际发现并处理的问题

1. 上游空思考块禁止展开会影响 Nora 等待阶段的标题点击。已保留 `pending` 时允许用户主动展开，完成后的空/隐藏块仍被拦截；原生思考流测试通过。
2. 三方文本合并漏掉世界书排序所需的 `setInfoBlock` / `clearInfoBlock` 导入，已补齐。新符号静态检查与 156 个前端模块的 ESM 链接检查通过；检查只链接、不执行页面代码。
3. 原账本 HTTP 测试直接调用旧的删除 materializer，缺少重构后的确认计划及 DELETING 状态。测试改为正式 `World Core.deleteWorld` 入口，保留生产保护，没有为过测试放宽删除条件。
4. 旧能力合同仍要求两个参数，未反映上一阶段 World ID 接入。已加强为要求 `{ worldId }` 第三个参数，与已通过的实际授权隔离测试一致。

### 6.3 验证结果与未完成边界

- 集中回归：37 个测试文件，共 328 项，327 通过、0 失败、1 跳过。跳过项是调用真实模型的流式测试，本轮未授权真实模型调用。范围包括 Helper 同名/同 avatar 世界隔离、延迟授权、脚本保存、预设权限、独立 MVU 路由、消息反馈、聊天保存/备份/恢复/删除、世界重开和静态资源。
- 专项合同：headless runtime、headless config、MVU headless、backend surface、World core、World capability 通过。只证明合同涉及的边界，不等同于整个 ST 或所有插件兼容。
- `sync-story-profile-runtime --check`、Webpack、运行资源生成、公共库构建通过。Webpack 仍有默认大资产警告，不隐藏该告警。
- 用户明确同意启动资源门槛从 555,000 改为 560,000 字节。最终 Brotli manifest **559,138 字节**，shell **25,077 字节**，预算检查通过。未为削减体积移除功能。
- `git diff --check` 通过；变更代码相对基线没有新增未定义或未使用符号。未宣称整库 lint 全通过。
- 未提交、合并主分支、推送、发布或同步 8799。未打开浏览器、运行真实用户脚本、修改现有世界或聊天。目标页面的实际游玩、视觉、外部模型和外部代理验收仍待授权后进行。

源代码状态与安装状态必须区分：独立分支 ST 核心 1.19.0 / Helper 4.11.2，不能据此宣称用户当前安装已升级。

### 6.4 本机同步预检（2026-09-29，尚未覆盖）

用户授权同步 8799 后，实际启动合同检查发现 `app/native-runtime.json` 与引擎 `.nora-upstream.json` 仍为 1.18.0，`verify_source()` 报版本不一致。已将两份清单同步到固定 1.19.0 提交，并增加直接检查随包源码的回归用例；通过发布投影运行依赖与启动锁测试共 17 项通过。此前核心测试不能替代安装合同验证。

同步差异预览发现，本机 8799 已包含 `codex/tavern-mcp-parity` 的未合并功能，涉及页面控制、预设删除版本校验及库管理接口。实际安装的 `page-controls.js`、`preset-manager.js` 与该分支逐字节相同。直接覆盖当前升级分支会移除部分接口或使新旧调用不匹配，因此暂停部署，等待用户确认先整合这批已部署改动。没有停止服务、覆盖本机程序、清理数据或迁移旧记录；同步计划仅保存在临时目录。

### 6.5 整合本机 MCP 功能并部署 8799（2026-09-29）

用户确认先整合再同步。只读取 `codex/tavern-mcp-parity` 的 46 个改动文件，原工作区未改动，整合后复核其内容摘要未变化。保留页面控制、插件/预设控制、当前世界会话绑定保护，以及发送失败后的已保存用户消息回执。四处冲突逐处融合；MCP 库卡删除调用重构后的索引/存档清理流程，继续检查修订和引用，不另留一条只删 PNG 的旁路。库卡去重保留原有独立操作。技能说明补齐删除预览与确认令牌、存档清理边界。

- 最终交叉回归 27 文件、261 项通过；MCP 20 项通过；发布投影下启动/更新器 64 项通过；六项专项合同通过。新增用例覆盖生成占用包装器传递保存回执、MCP 删除同步清理未引用存档、重新导入相同卡后可再次明确删除。未调用真实模型或真实数据的写入接口。
- 前端构建及资源生成通过；启动清单 559,047 字节，保留 560,000 门槛。定向引擎 lint 与 `git diff --check` 通过；测试文件仍有 Playwright 风格提示，不宣称全仓无告警。
- 147 个程序/技能/安装依赖标记文件同步到现有实例；只替换选定文件，不整目录覆盖，也不重装依赖。依赖锁仅根版本变化，所有直接依赖已核对；原先有效的依赖准备标记对应更新后的锁摘要。
- 受影响文件原件及哈希清单在 `/Users/sorrymakerx/Library/NoraTavern/local-fix-backups/storage-st119-M2DAPI`。通过原有 launchd 提交任务停止/恢复相同服务名称与命令，8799 新 PID 为 36703；正式源码/依赖合同验证为 ST 1.19.0，Helper manifest 4.11.2。
- 7 个世界的 API 列表与升级前完全一致；根页面、CSRF、库卡读取、新备份清单及新旧扩展资源均 HTTP 200；新的独立 stdio MCP 发现 58 个工具，包含删除预览和原库管理工具。
- 349 个核对文件中，348 个用户文件字节不变；服务 `config.yaml` 被 ST 启动初始化补齐三项 `backups.chat.retention` 默认值并重新序列化，启动日志只报告这三项新增、没有迁移日志。未主动覆盖模型/用户配置。旧备份 181 份、新受管备份 0 份，未超预算；未清理/转换旧备份或恢复真实聊天。
- 未重启 Hermes 网关或向 ClawChat 发消息；现有常驻 MCP 连接仍需通过 Hermes `/reload-mcp` 重连后才能加载新增工具。本轮只验证新 stdio 进程的发现结果，不冒称既有会话工具已刷新。

没有提交、合并主分支或发布 GitHub。页面交互、实际卡片续聊与恢复的用户验收仍待执行。
