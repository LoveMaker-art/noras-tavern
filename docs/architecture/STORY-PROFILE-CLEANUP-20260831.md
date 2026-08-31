# Tavern / Story Profile 定向收敛记录

日期：2026-08-31。依据前一轮 `37368` 远端只读审查，在本地实施；未提交、未部署、未重启远端。

## 范围与保留项

保留当前档案页面结构和交互、深浅色与移动端样式、ClawChat 语言选择、人格编辑、档案生成、15 轮复盘、账本和 Hermes 投影，以及 ST / Helper / MVU 能力。不更改用户数据。

仅收敛已经确认的旧转接、World v1 字段回退、档案页无关资源和重复维护脚本。全量聊天统计、其他旧运维 CLI、插件基础库共用和依赖安全不在本次修改范围；不声明全仓零冗余或正式发布就绪。

## 具体变化

- 删除 `app/story_profile_adapter.py` 和引擎 `src/nora-story-profile-checkpoint.js`。测试直接使用实际 CLI / checkpoint 实现；保留禁止旧入口重新出现的契约。
- `src/nora-story-profile.js` 仅读取 World v2 的 `world_id`、Runtime Card 和默认 Session；测试覆盖冲突旧字段不被采用、缺失新绑定时不退回旧聊天。
- 独立 `story-profile/public/console.css` 按实际 HTML 与渲染模板选择器裁剪；保留声明值、顺序、深浅色与移动端规则。`i18n.js` 保留38个实际界面键、原值与人格名称覆盖，移除旧酒馆词条和无人调用的名称替换函数。
- 样式从59196字节降至7687；翻译从67788字节降至8534。合计126984 → 16221字节（未压缩文件大小，不是实测网络传输或秒数）。HTML、actor.js、security.js 保持本轮前内容。
- 将 `ops/specialists/tavern-story-profile/scripts/profile_memory.py` 原样移动至 `ops/scripts/profile_memory.py`。其 SHA256 仍为 `b8ac19e4198d9452ad565d579053b814e2181ca4d6299e4c6b605c8d4dccc02b`，离线维护能力未删。
- 安装器把该工具放在唯一的 `skills/creative/tavern/scripts/profile_memory.py`，备份后退役两处字节相同的旧副本；被定制过的旧副本会阻止迁移。当前日常技能仍使用 MCP，不增加技能或工具注册。
- 通过现有同步脚本更新随包档案快照，无新增构建框架或生产依赖。

## 验证证据

- 修改前针对性 Node 测试：15项中12通过，3项失败。失败为旧 HTML 哈希、11文件清单和旧注册/绑定形式断言；修正这些过时契约，未回退实际产品行为。
- 修改后7个相关 Node 测试文件：36项通过，0失败；包含真实 Python 投影、人格读写、复盘/重试、进程截止时间、CSRF 与两个 Liveware 根路径。模型调用使用夹具。
- 安装器隔离测试：20项通过，包括迁移备份、重入幂等、定制文件拒绝和失败回滚。
- 独立 Story Profile Python 投影测试：6项通过。
- 单进程契约、快照 `--check` / `--check-source`、JS/Python 语法和修改范围内 diff 空白检查通过。13个快照文件与独立来源一致。
- 资源回归使用清理前提取的保留 CSS 规则摘要以及各语言/人格覆盖的翻译摘要；页面 HTML 和 actor.js 保持原哈希。不是浏览器截图或目标 Liveware 视觉验收。
- 本地未安装 ESLint 可执行文件，未宣称 ESLint 通过，也未为此安装依赖或执行全仓测试。

## 后续部署边界

尚未授权本轮部署。当前远端的旧文件/旧技能副本仍存在，不能称已远端清理。

获得授权后需备份并应用本轮精确差异，显式退役两个应用旧入口（仅覆盖新文件不会删除旧文件），按安装器计划迁移重复 helper，验证新资源访问与缓存版本，随后核对健康状态。不得把本地其余未提交改动整体上传。

本轮本地原文件备份：`/tmp/nora-profile-cleanup.Z8S8ub/before.tgz`；资源原文另保留于该临时目录。原有未提交业务改动未回滚。

## 后续授权部署与远端复查

用户随后明确授权部署。本节更新前述“未部署”状态；本地 Git 仍未提交。

- 目标：SSH 37368，`/opt/data/apps/tavern-runtime`。只应用本轮精确差异，未全量上传本地脏工作树。
- 部署前对12个目标核对旧哈希和源文件哈希。7个写入目标、5个退役文件均通过部署后哈希验证，另外移除7个已空的旧技能目录。
- 备份：`/opt/data/tavern-skill-backups/migration-zcuidlwb`。回执：`/opt/data/tavern-state/native-runtime/deployment-receipts/profile-cleanup-20260831.json`，包含每个目标的前后哈希和验证结果。
- 部署检查发现档案 CSS/JS 引用无版本标识；在现有快照同步步骤中加入内容哈希查询参数，避免继续请求旧缓存地址。独立来源 HTML 不变。不是清空缓存，也不是测得 CDN 命中率。
- Tavern PID 11714 → 12838，健康检查通过。Hermes Gateway 12128、MCP 12180 保持运行，未重启。
- 源站 `/`、`/_liveware/story-profile/`、`/actor.html` 均200；根页面标题分别为 tavern / story profile。两个内容版本资源均200且与 URL 中哈希匹配。
- 世界仍为5个；世界列表和档案卡接口的 JSON 内容哈希与部署前一致。未修改世界、聊天、模型、人格或档案数据，未调用付费模型。
- 加入资源 URL 验证后37项相关 Node 测试通过；原20项安装器、6项投影测试记录仍适用。目标 ClawChat 浏览器视觉和 CDN 实际缓存命中未验收。

### 剩余代码与交付残留（只读检查，未额外修复）

1. `/opt/data/skills/creative/tavern/scripts/tavern_cli.py:56` 的世界查询仍 POST `/api/nora-worlds/list`；带有效源站 CSRF 的只读请求实测404。`recall`、通过世界名触发复盘等依赖此查询的旧 CLI 路径失效。当前 MCP 不调用这个脚本/旧接口；不能扩大为当前 UI 世界列表失效。
2. 同目录 `package-release.mjs`、`verify-product-workflows.mjs` 按源码仓库布局解析 `../..`，但远端该目录并无 `app/engine/sillytavern` 或 Git checkout。此类开发脚本不适合作为运行时分发文件。引擎 tests 还残留一份约11KB的 `nora-world-theme.test.mjs`。
3. `src/nora-story-profile.js:244` 仍逐世界同步读取聊天并聚合统计；checkpoint 在判断15轮是否到期前加载上下文。这是剩余重复计算与规模成本，未测成当前用户延迟，也未在本轮加入缓存。
4. ST / Helper iframe 基础库的字节副本仍有真实引用；内置档案快照13文件校验通过。未发现第二套正在运行的完整酒馆后端，不能将这些整体认定为垃圾删除。

### 剩余磁盘占用（约值，不能全部称垃圾）

| 路径 | du 占用 | 分类 |
| --- | ---: | --- |
| `/opt/data/.cache/ms-playwright` | 656MiB | 浏览器工具安装缓存，不是 Tavern 项目代码；移除可能触发再次下载 |
| `/opt/data/.cache/pnpm` | 157MiB | 可重建包缓存 |
| `/opt/data/.cache/uv` | 97MiB | Python 工具缓存 |
| `/opt/data/.cache/node` | 42MiB | Node/Corepack 缓存 |
| `/opt/data/.npm` | 189MiB | npm 缓存及 npx 内容 |
| `/opt/data/tavern-updates/nora-tavern-app.tar.gz` | 42MiB | 旧安装包，涉及恢复/升级来源 |
| `/opt/data/deployments/nora-mcp-20260830.Qj4awr` | 19MiB | 旧部署 staging，含 companion/npm-cache |
| `/opt/data/tavern-state/native-canary` | 32MiB | 测试运行目录，含聊天/用户数据，不直接删除 |
| `/opt/data/tavern-stage-state-20260827-203039` | 5.7MiB | 旧测试状态，含用户数据，不直接删除 |
| `/opt/data/tavern-state/native-runtime/deploy-staging/world-visuals.sOSgXP` | 4.4MiB | 上轮视觉适配回滚备份 |

上述新发现目录均未删除。活动 `native/_cache` 约56MiB包含分词器下载缓存，不应因目录名叫 cache 就清空。当前整个 `/opt/data` 约2.5GiB，Tavern 运行目录约238MiB（含依赖），两者不可混称项目源码大小。

## 后续授权：远端运行目录与磁盘清理

用户随后明确要求清理远端旧 CLI、运行目录冗余及磁盘冗余，同时询问更好的统计方法。本节更新上节“新发现目录未删除”的状态。统计实现不在本次修改范围，本地业务源码与开发工具未删除。

### 实际清理与保留

- 删除远端 `skills/creative/tavern/scripts/` 下 `tavern_cli.py`、其专用依赖 `native_tavern.py`，以及 `package-release.mjs`、`package-release.sh`、`release-source.mjs`、`index-project.mjs`、`audit-world-architecture.mjs`、`audit-st-interaction-surface.mjs`、`replay-st-interaction-gaps.mjs`、`smoke-st-world-materializer.mjs`、`verify-product-workflows.mjs`、`migrate-nora-worlds-v2.mjs`。这些开发脚本依赖源码布局，不在当前运行调用链中。
- 删除无 `SKILL.md` 的退役 `tavern-world`、`tavern-continuity` 残留目录及后者的旧修复脚本，避免旧 CLI 留下失效指引。当前 Tavern / 运维 / 更新 / Cardforge 技能入口和 AGENTS 未修改。
- 删除引擎残留的 `tests/nora-world-theme.test.mjs` 及其空目录。保留两个日志分析工具、`runtime.sh`、`bringup-native.sh`、`provision.sh`、`profile_memory.py`。
- 删除 npm `_cacache`、pnpm 缓存、uv 缓存及旧 Python 字节码。删除前核实进程文件句柄、映射与已安装环境符号链接未使用这些目标。未来安装/运行基于缓存的工具时，可能需要重新下载；没有删除实际安装的 Tavern / MCP 依赖。
- 删除旧 `native-canary` 和 `tavern-stage-state-20260827-203039` 测试实例。核实二者无聊天/World Core 记录，canary 的29张角色卡、1份世界书与引擎默认内容逐字节相同；不把它们当作用户世界删除。未来执行部署 prepare 会重新创建 canary。
- 删除旧 `tavern-updates/nora-tavern-app.tar.gz` 和对应 `SHA256SUMS`；它们不是当前运行程序，已安装旧 updater 预期的包格式也不同。该安装包本轮不另留副本；删除不代表旧 updater 已适配当前项目。
- 删除 `deployments/nora-mcp-20260830.Qj4awr` staging；其原有 runtime/config 回滚文件与部署记录先复制校验并移入本轮备份，再删除解包副本、npm 缓存和传输包。
- 保留 Playwright 浏览器、Corepack、npx 环境、活动分词器缓存、当前用户数据、现有视觉/档案回滚材料及其他项目文件。未重启或重新注册任何服务。

清理按24个精确目标及删除前哈希执行。回滚目录：`/opt/data/tavern-skill-backups/remote-retirement-mihae7ik`（约34MiB，含代码/测试状态归档、旧 MCP 回滚材料和完整清单）；回执为其中 `receipt.json`。代码与测试状态归档逐文件读取验证后才删除原文件。下载缓存没有备份。

本轮回执记录净释放513900544字节，约490MiB；文件系统显示 `/opt/data` 由约2.5GiB降至2.0GiB。本次清理临时目录也已删除。Tavern 12838 / MCP 12180 / Hermes 12128 未变；两个页面入口均200。5个世界列表、档案卡响应、聊天、角色卡、世界书、World Core 及档案状态文件均通过清理前后哈希核对，未改变用户内容。未进行浏览器视觉验收或模型调用。

范围限制：本轮只清理远端，不改本地开发脚本。旧 updater 仍被兼容性检查规则限制，不能直接执行其旧版覆盖安装。后续正式发布还应收窄 ops 包的运行文件名单，避免把保留在源码中的开发工具重新带到运行目录；本轮没有擅自修改发布机制。

## Story Profile 统计优化建议（已分析，未实施）

### 已确认的现状

远端 `src/nora-story-profile.js`、`story_profile_runtime/adapters/nora/preference-checkpoint.js` 和聊天写入实现与本地对应文件 SHA256 一致，本节不是只依据历史讨论。

- `loadStoryProfileCard()` 逐 World 取默认 Session 的完整聊天，同步读 JSONL、解析并重新计算轮数、字数，再读取角色信息组合档案。
- `checkpoint()` 先 `loadContext()` 读取完整聊天，随后才判断是否达到15轮。这使未到复盘时间的检查也承担完整读取成本。
- 展示统计、生成内容分离：`knows` 来源于已确认的 `profile.preferences`，`timeline` 来源于 `profile.recent_timeline`。减少聊天统计读取，不替代这两者的模型生成或改变语义。
- 本次两次源站卡片检查约50ms和20ms，只有5个世界；不能据此声称这是当前数秒打开等待的主因，更不能把清理前后差异归因于代码优化。统计代码本轮未改。

### 建议：按会话保留可重建的统计快照

按照 codebase-design 的深模块原则，用一个统计 Module 集中管理 Interface、版本验证和重算，调用方不各自做计数或缓存。复用现有 World / Session 身份和本地存储方式，不新增数据库、独立进程或模型请求。

1. **保持现有统计口径。** 按数据根目录、World ID、Session ID、聊天绑定标识隔离快照；档案仍只汇总每个 World 的默认 Session，不擅自扩大到所有历史分支。分别保留展示轮数与复盘有效轮数：当前展示计入符合消息结构的用户消息，checkpoint 排除空文本，两者不能未经确认直接共用一个计数。
2. **没变的会话不重读。** 快照保存消息来源版本、轮数、字数等小量结果，不复制完整聊天。打开档案时检查聊天绑定/文件版本，再汇总有效快照。角色名称/标签、人设、档案 revision、默认 Session 切换也需要独立失效规则；出道天数在读取时根据当前时间计算，避免整页缓存跨日失真。
3. **只更新变化的会话。** 优先复用成功保存时已有的消息内容计算统计或标记脏版本，不再额外读一次文件。ST 保存通常是全量重写，不能直接假设只追加；最稳妥的第一版先只重算变化 Session，避免复杂的逐消息增减账。若后续需要更细增量，必须先验证编辑/重生成的消息差异。
4. **所有真实写入路径都要覆盖。** 当前普通保存经过 `trySaveChat()` / ledger 写入保护，但导入、重命名、删除和其他写入并非都集中于同一处；必须逐入口核实，不可只监听 UI 点击。外部脚本修改以文件版本检查兜底。已有 World manifest revision 不等于聊天 revision，不能单独拿它作为命中条件。
5. **15轮检查先看统计。** 未到阈值不构建完整复盘上下文；到期后再读取该 Session 的原始聊天，并验证上下文对应版本。继续保留现有成功后推进游标、失败可重试、进行中去重逻辑；编辑/截断与异步完成的竞争必须检查历史版本，不能让旧任务推进新历史的游标。轮数回退后的复盘语义应单独验证，而不是清零后无条件再次调用模型。
6. **统计可丢弃，聊天不能丢。** 初次、缺失、损坏或版本变化时异步重建对应快照，完成前不把旧结果标成最新。版本确认后原子发布；相同 Session 的同时请求共用一次计算，较老计算不能覆盖较新结果。快照重建失败不阻止聊天成功保存，后续档案读取应报告/重试，不能悄悄返回零值。持久化快照使服务重启后可验证复用，不靠进程内缓存硬撑。

### 实施验收要求

- 所有现有字段与原算法对照相等，包括 Unicode 字符数、首条角色消息排除、亲密度、角色去重、默认 Session 选择及标签顺序。
- 连续读取且无变化时，不打开/解析完整 JSONL；只改变一个会话时，其余会话不重读。
- 编辑、删除后续消息、重生成、导入、重命名、切换默认 Session、删除 World、后台写入后统计更新正确。
- 14/15/16/30轮触发行为、失败重试、并发去重、重启恢复与现有要求一致；模型任务不能因过期快照重复调度。
- 关闭剧情账本仍可统计；不把 Story Profile 统计依赖在账本压缩启用状态上。
- 记录实际文件读取数量、重算次数和接口耗时；用当前数据及扩大数据量的隔离夹具对比，不用测试数量代替产品验证。

这是控制历史增长成本的合理优化，不是通过缓存生成内容掩盖问题，也不能消除 Liveware 网络延迟或模型生成等待。本轮仅提出方案，远端统计仍是现有实现。

## 后续执行：统计快照与发布清单已实现并部署

用户确认执行后，完成本节范围。前节的统计建议由本节的实际实现/证据替代；不扩大为全项目发布认证。

### 实际实现

- 新增引擎 `src/nora-story-statistics.js`，提供集中式统计读取、持久化、同一 World 的并发读取合并和已删除 World 的缓存回收。以用户数据根、聊天根、World、默认 Session、实际绑定及文件 dev/ino/size/mtimeNs/ctimeNs 组成版本。每个 World 只保留当前默认 Session 的一个记录，不每次请求增加文件。
- 使用**读时校验、变化会话惰性重算**，没有在每个聊天写入口增加监听/补丁，也不把计数加入发送路径。普通保存、编辑截断、重生成、导入、文件原子替换/重命名、外部修改都由文件版本识别；首次统计按 World 顺序读取，限制峰值内存。
- 原算法的展示轮数、Unicode 字符数、首条角色消息排除和复盘有效轮数口径不变。档案组合仍即时读取角色名称/标签、人格、偏好/年表状态和当前日期；未缓存整页结果。
- 快照使用校验和、原子写入与源文件前后版本核对。坏缓存重建，聊天损坏/权限失败不再静默变成零统计；缓存写入失败只报告并返回当次真实计算结果，不影响聊天写入。重复读取和新进程可复用持久快照。
- `loadStoryProfileCard()` 使用统计记录，移除旧 `readWorldChat()` 同步全量读取及只服务该函数的辅助逻辑。手动/自动复盘的完整上下文也使用同一版本化读取模块。
- 独立 Story Profile 的 `adapters/nora/preference-checkpoint.js` 增加必需的 `loadProgress` Interface；Nora 负责提供计数/版本，不让 Profile 反向依赖 Nora 源码。未到阈值不读取完整上下文，到期后核对 Session、版本和轮数再调模型。资格检查串行化但不持有模型等待，保持失败重试、15轮间隔、持久游标和进行中去重。修复同步抛错的模型适配器可能遗留 running 状态的问题。
- 通过已有同步构建更新嵌入 checkpoint 和13文件清单，只改变2个快照文件；没有重建/改动前端 UI、静态资源、技能或模型配置。
- `collectRuntimeFiles()` 对 ops 部分使用明确允许名单，仅交付生命周期/日志分析/profile维护/技能安装器及3个当前技能的说明。完整开发源码仍可用于构建/测试，但退役 CLI、开发打包/测试/迁移/索引脚本、旧 specialist 和 ops 测试不再进入运行包。没有删除本地开发工具，也没有重新启用旧 updater。

实现边界：本轮保留原有按 World 记录的复盘游标和“使用触发时聊天快照生成”的语义，没有自动撤销已生成的历史偏好，也没有重构模型执行期间历史修改后的结果回滚机制。统计正确更新不等于自动重做历史复盘。变更发生在资格检查与上下文读取之间时，本次返回 `history_changed`、不调用模型，后续检查可重新判定；不额外自动重试付费调用。

### 本地针对性验证

47项测试通过，涵盖：

- 同时12次读取只解析一次聊天，重复读取及新 reader 复用持久快照；
- 增加回复、编辑截断、重生成、等长文件重写并恢复 mtime、删除重建、重命名、默认 Session 切换、World 缓存回收；
- 坏缓存、缓存写权限失败、聊天解析/权限失败，以及读取/发布快照途中源文件变化；
- 档案全部输出与原投影算法一致，角色和偏好修改/跨日正确更新且不重读无变化的聊天；
- 真实隔离 JSONL 驱动14/15/16/30轮，只有15和30触发模型替身；并发检查去重、版本变化拒绝调度、同步模型异常清理、失败重试和重启后游标恢复；
- 发布包排除退役文件，而源码中这些开发文件仍然存在；原有语言、样式、CSRF 和进程截止时间契约继续通过。

快照 `--check-source`、JS语法和改动范围空白检查通过。没有执行真实付费模型调用，没有进行浏览器视觉验收。

### 远端部署与实测

- 精确部署5个后端文件，旧文件/新文件哈希校验通过。部署摘要 `e3056309a01ffb15f1bd6c969eefc816e525de901534ad6311473d345bcb5a13`；备份 `/opt/data/tavern-skill-backups/migration-hqlpmjx0`，含原文件清单、native配置副本、部署前数据摘要及 `verification.json`。
- 部署前无在线控制页面、5个 World 的复盘均非 running，四个受管理扩展的源/部署内容一致。Tavern PID 12838 → 13002，健康检查通过；Hermes 12128、MCP 12180 未重启。
- 两个页面入口200；5个世界、档案输出、聊天/角色卡/世界书/World Core 以及档案持久状态均与部署前哈希一致。
- 生产统计记录为5份、内容合计1230字节（文件系统分配约24KiB）。首次部署后档案接口约38ms，后续5次源站请求分别13.88、12.60、16.00、23.49、11.53ms；这些不是 Liveware 前端打开时间，也不是严格同负载前后基准。
- 使用部署后的统计模块、远端真实5个世界进行独立进程文件读取探针：

| 探针场景 | 打开完整聊天文件 | 读取聊天字节 | 统计耗时 |
| --- | ---: | ---: | ---: |
| 读取生产环境已生成的快照 | 0 | 0 | 4.17ms |
| 隔离空快照目录，读取真实聊天 | 5 | 2532921 | 34.05ms |
| 同一隔离目录再次读取 | 0 | 0 | 1.29ms |
| 新 reader 读取该持久快照 | 0 | 0 | 1.32ms |

四种结果的统计值一致。探针没有修改真实聊天；隔离快照目录运行后已删除。发布清单改变属于本地打包逻辑，不把打包器再次上传到远端。远端仍只保留6个有用途的运维脚本，旧 CLI/开发脚本未重新出现。
