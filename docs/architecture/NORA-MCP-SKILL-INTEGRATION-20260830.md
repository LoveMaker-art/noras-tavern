# Nora MCP 接入与技能收敛评估

日期：2026-08-30。状态：分析完成，未实施 MCP 接入、工具改造或技能替换。

## 1. 结论及范围

可以沿用本机 `../nora-mcp`，作为若棠控制当前 Tavern 的唯一 MCP 入口。
不需要重写 ST、World Core、剧情账本或 Story Profile；但当前工具集不能不加限制地全部交给若棠。
需要补齐产品操作入口，修正旧 ST 写操作与 Nora 规则之间的冲突，并更新已经过期的技能命令。

本次对照的是当前工作树、远端实际安装的技能和 Hermes MCP 加载器，而不是仅复述旧架构文档。
没有声称逐行读完全部第三方 ST/Helper/MVU 代码，也没有把工具发现或类型检查当成复杂卡行为验证。

保留：现有 UI、ST 卡解析和插件执行、World Core 权威绑定、账本规则、Story Profile 原版生成逻辑。
改变范围（待实施）：MCP 的参数/权限/操作映射、技能路由及陈旧命令、必要的只读查询边界。
不做：第二套世界数据库、另写模型调用流水线、改写卡脚本、将 MVU 移到 Python 执行、重复部署 st-mcp。

## 2. 实际核对结果

- 本机 MCP 目录：`../nora-mcp`；`npm run typecheck` 通过。
- 使用 MCP SDK 建立真实 stdio 连接并执行 `tools/list`：84 个工具，24 个 `nora.*`、60 个 `st.*`；剧情账本工具为 0。
- 远端 `/opt/data/config.yaml` 的 `mcp_servers` 当前没有配置项，尚未接入该 MCP。
- 远端 Hermes `/opt/hermes/tools/mcp_tool.py` 支持 stdio，以及 `tools.include/exclude` 精确名称或 glob 筛选；优先复用它，不另造权限代理服务。
- 远端只读检查：`GET /api/productions` 返回 404；带合法 CSRF 的 `POST /api/nora-worlds/list` 返回 404；`GET /api/nora-worlds-v2/worlds` 成功。
- 未调用真实模型、未修改世界/聊天/MVU、未用浏览器测试 MCP 操作。

## 3. 当前工具的具体缺口

| 问题 | 当前代码依据 | 实际影响与处理方向 |
| --- | --- | --- |
| 只有查世界、修复、删除，没有创建/导入产品工具 | `../nora-mcp/src/server.ts:826` 起的 Nora 注册；后端 `src/endpoints/nora-worlds-v2.js` 已有 `imports/library-imports/worlds` | 补薄适配，沿用现有幂等操作和 operation 查询；不让 Agent 拼世界 JSON |
| 没有剧情账本工具 | `tools/list`；`src/endpoints/nora-story-ledger.js` 已有 status/configure/compress/edit | 补状态、启停、重试、受约束编辑；不要让技能独立数 15 轮、生成/写账本 |
| ST 编辑不符合 Nora 的历史分叉规则 | `../nora-mcp/src/st/control-plane.ts:1938` 编辑只替换一条；1963 删除只 splice 一条 | 未压缩的中间消息也必须经 Nora 编辑入口截断后续消息；不能继续保留基于旧内容的后文 |
| MVU 写入绕过浏览器生命周期 | 同文件 `patchMvuChatState` 直接改 `variables[0].stat_data` 再保存聊天 | 默认不开放该写工具。需要修改变量时必须有原运行时的执行和确认，不能拿文件保存成功冒充卡状态已更新 |
| 普通小修改会制作大范围备份 | `../nora-mcp/src/st/snapshots.ts:27`、`snapshotItems`；大量写工具先 `snapshots.create` | 可重复复制整个 userDataRoot、插件、配置，含聊天与敏感设置；没有保留上限。这会再次堆积磁盘并放大延迟 |
| “有备份”并不等于正确回滚 | snapshots 的 rollback 删除再恢复整个目标；source.write 的备份清单不包含任意被改源码 | 后续改成受影响资源快照，明确锁/前置版本及保留预算；整实例恢复只允许维护流程在停服状态执行 |
| 源码/命令/回滚混在日常工具中 | `server.ts` 暴露 source.write、dev.run、rollback、plugin.install；dev.run 允许 sh/bash/node/python3 | `confirm:true` 由模型填入，不是独立授权边界。默认白名单排除维护工具；维护请求另行授权 |
| 页面状态桥只有观测，没有执行控制 | `../nora-mcp/src/st/bridge-templates.ts` 只有 health/snapshot/history，定时上传浏览器快照 | 不能据此声称 MCP 已能点击发送、重生成、停止或执行 MVU。需要时适配已有 Story Action Dispatcher，并获取执行回执 |
| 有状态写接口不等于能力已激活 | `nora.capability.settle` 可接收 READY/evidence；`world.open_plan` 只读计划 | 日常 Agent 不应手工将能力标成 READY。保留真实页面/插件执行结果为判断依据 |
| 超时和费用语义不准确 | `src/config.ts` 默认 HTTP 30 秒；Story Profile 后端部分操作上限 360 秒；reflect-preview 也调用 `model.complete` | 区分“只读不落档”和“不调用模型”；按操作设置期限/结果查询，超时后先查结果，不能盲目重试付费写操作 |
| 进程控制工具目前未接线 | `server.ts` 构造 ST 配置时硬编码 `runtimeCommands: {}` | 工具虽然存在，start/restart 返回未配置；不能让技能承诺它已可重启服务 |
| 安装包依赖本机兄弟目录 | 当前 node_modules 链到 `../st-mcp/node_modules`，无独立 lockfile，package 无 test script | 发布前固定自己的依赖锁，在无 st-mcp 的干净目录安装、构建和启动验证 |

重要限定：当前后端已经保护压缩并激活的历史，ST 保存接口也经过账本守卫。
因此这里不是“所有 ST 工具都能绕过锁”，而是未压缩编辑语义、MVU 生命周期及泛化文件/命令工具仍不适合日常使用。

另外，当前账本 HTTP `status` 会顺便 schedule 恢复符合条件的后台压缩。
它“不等待模型”不等于“绝不触发模型”。接入只读巡检前，应提供不调度的查询方式；不得将有副作用的接口伪装成纯查询。

## 4. 旧技能为何需要一起收敛

1. `ops/SKILL.md` 仍推荐 Story Profile 的旧 CLI。`ops/scripts/tavern_cli.py:56` 用已退役的世界列表地址解析世界，导致 recall/reflect 按世界调用在进入复盘前就失败。
2. 远端 `tavern-continuity/scripts/tavern_repair.py` 仍读取 `/api/productions`、`/api/production`，写 `productions/<id>.json`，导入旧 `actor` Python 模块。它不是当前账本插件的修复入口。
3. `ops/references/shared-contract.md` 还说账本“以后可能作为插件回归”；当前账本已存在，这条说明过期。
4. 远端 world/runtime-plugins 技能仍含 `pending_first_load`、旧 import journal 和 sidecar 描述。应改成当前 World Core operation、会话绑定和真实能力状态，不能直接复制文字换工具名。
5. 本仓库 `ops/specialists` 目前只有 Story Profile 专项，而远端还装着多份 Tavern 专项。需要明确各技能的唯一源码和版本清单，避免本地代码更新、远端技能仍停在旧模型。

以上是 Agent 操作入口的问题，不等于网页的 Story Profile 数据生成接口失效。
技能不应为了继续兼容而恢复已经删除的 Python 世界模型。

## 5. 接入方式：一套进程、同一份数据

推荐将 nora-mcp 作为独立部署组件放在 Tavern 同一远端机器，由 Hermes 通过 stdio 启动，HTTP 只访问本机 `127.0.0.1:8799`。
无需给 MCP 创建 Liveware App、开公网端口，或再启动一套 Tavern 后端。

关键配置必须显式指向实际部署路径：

| 配置 | 此机器应指向 |
| --- | --- |
| NORA_MCP_BASE_URL | `http://127.0.0.1:8799` |
| NORA_MCP_ST_ROOT | `/opt/data/apps/tavern-runtime/engine/sillytavern` |
| NORA_MCP_STATE_ROOT | `/opt/data/tavern-state` |
| NORA_MCP_NATIVE_DATA_ROOT | `/opt/data/tavern-state/native` |
| NORA_MCP_USER_DATA_ROOT | `/opt/data/tavern-state/native/default-user` |
| NORA_MCP_CONFIG_PATH | `/opt/data/tavern-state/native-runtime/config.yaml` |

`PROJECT_ROOT` 不能照搬本机仓库布局：远端应用根没有额外的 `app/` 目录，现有 configLocations 等仍拼接 `projectRoot/app/...`。
应先明确部署根与仓库根的区别；运行模式不需要也不应开放源码修改。
MCP 安装位置、受限快照位置在实际实施时确定，本文没有创建这些目录。

不能只把 Mac MCP 的 BASE_URL 改为远端域名：它同时调用 HTTP 和读写本地文件，可能查的是远端、改的是 Mac。
如开发机需要访问远端，使用 SSH 启动远端 MCP，保持工具执行和数据在同一机器。

权限先使用 Hermes 现成的 `tools.include` 精确白名单，禁用不需要的 resources/prompts 通用入口，避免资源工具成为额外旁路。
初始只放经审查的状态、世界列表/详情、角色/世界书摘要和档案查询；不使用 `nora.*` 全匹配，也不把 reflect-preview 当免费查询。
这是减少模型可调用面的手段，不是操作系统安全沙箱；若要对不可信 Agent 隔离，仍需账户/进程权限和后端鉴权。

## 6. 技能设计：复用现有名称，不增加一套业务架构

沿用一个 `tavern` 路由技能，按用户结果选择专项；不把 84 个工具和所有操作手册每次塞进提示词。
路由技能只写：该找谁、当前实例怎么确认、不能跨越哪些数据边界。

| 技能 | 收敛后的职责 | 不应做的事 |
| --- | --- | --- |
| tavern-world | 卡库、世界创建/导入、世界与会话绑定、世界书和 Persona | 手工拼状态文件、用创建替代失败重试、把模板和世界实例混成一个对象 |
| tavern-continuity | 剧情账本、上下文覆盖情况、历史编辑约束、生成连续性诊断 | 调旧 productions API、另数一套轮数、凭摘要文本手写 active 标记 |
| tavern-story-profile | 明确偏好、偏好复盘、原年表/口味、USER/MEMORY 投影的解释与核对 | 把虚构经历当真实用户属性、手工追加托管块、重新实现账本压缩 |
| tavern-runtime-plugins | 插件启停与配置、复杂卡能力、Helper/MVU 真实执行状态 | 凭持久化变量存在就说 MVU 已运行、直接改 stat_data、虚构 READY |
| tavern-frontend / tavern-world-visuals | 保留各自 UI/卡片显示/背景主题职责，只更新真实控制路径 | 顺手重写卡脚本或改后端状态模型 |
| tavern-ops / tavern-updater | 保留模型/健康/注册与发布各自边界；高权限工具按维护任务授权 | 把重启、源码写入、插件安装开放为普通对话默认能力 |

不因名称数量多就合并：现有拆分按结果有意义。真正要删除的是重复步骤、过期入口和两套互相矛盾的所有权说明。
Tavern 之外的原始卡创作技能可以继续提供标准卡文件，不需要塞进 nora-mcp。

每份专项只需包含：

- 触发条件与数据所有者；先读哪个最小状态；需要的 worldId/sessionId/version。
- 正常路径调用哪些工具；哪些操作会付费、删除后文、修改全局设置。
- 返回结果怎样区分“排队中、服务端已保存、页面已执行、用户可见”。
- 冲突、未打开页面、模型未配置、超时的处理；禁止自动绕过或静默换链路。
- 成功验收标准。字段和罕见错误详情放 references，工具参数以实际 schema 为准。

## 7. 核心操作必须遵循的当前规则

### 世界导入

复用后端 imports/library-imports/worlds → 稳定 idempotencyKey → operationId 查询。
结果验证绑定和目标世界 ID；“导入数据完成”和“浏览器 MVU 已激活”分开报告。
断线重试用原操作，不重新创建第二个世界。

### 编辑与剧情账本

按 worldId + sessionId 定位，读取当前签名、轮数和 active/pending 状态。
压缩成功只是 pending；实际进入发给模型的上下文并激活后才锁对应历史。
未锁定编辑必须使用现有账本 edit：校验 expectedSignature、修改目标、删除其后消息、使失效 pending 作废并按当前记录重算。
通用 ST 编辑/删除不能作为该操作的 fallback。

### 发送、重生成、停止和 MVU

HTTP 保存聊天不能代替页面的 ST/Helper/MVU 执行。
后续若要求若棠操作正在玩的会话，应复用现有 `story-action-dispatcher.js`，用受限语义命令而非任意 JS/DOM 点击，并绑定当前世界、会话、请求 ID 和页面执行回执。
现有 MCP bridge 只是快照观察，尚不具备这些命令；若没有页面运行，应明确返回不可执行，而不是绕过卡插件直接调用模型。
这部分是有边界的后续接入项，不在本次图标和名称变更中实现。

### 用户偏好与剧情投影

- 偏好复盘 / 用户明确偏好 → 原 Story Profile `taste_profile` → `/opt/data/memories/USER.md` 托管块，正文预算 900 字符。
- 已激活账本 → `shared_story_memory` → `/opt/data/memories/MEMORY.md` 托管块，正文预算 1300 字符；最近 3 个世界，每世界最多 4 事件、2 线索。
- 保留托管块外内容；Agent 不能自行将剧情抄进 USER.md，也不能覆盖完整记忆文件。
- 复用现有模型选择、后台任务和幂等投影；投影本身不增加模型调用。

## 8. 索引如何处理

`nora-mcp/docs/upstream-st-index.md` 仍是 2026-08-27、旧 `/Users/sorrymakerx/Desktop/项目/SillyTavern` 的 ST 1.18.0 索引，不是当前 Tavern。
`nora.local_index` 仅统计数据文件数量，不是源码调用图。
这与仓库另有 Codebase Memory 图是两回事，不能相互冒充。

现有 index-upstream-st 脚本的路由正则只处理字面量 router 方法，例如账本循环生成的路由会漏；它的 stRoot 范围也不包括外层 Nora 扩展和 Python adapter。
只重跑旧脚本不能声称“整个项目已解析”。

实施时应建立能力对照清单：用户动作 → MCP 工具 → 后端/浏览器入口 → 权威数据 → 是否付费/是否写入 → 回归证据。
结合最新 Codebase Memory 图与源码文件哈希，覆盖 engine 自有改造、native-extensions、Story Profile 核心/adapter、ops 和 nora-mcp。
打包 JS、动态事件、iframe、外挂扩展必须明确覆盖限制；不把无入边或未被 regex 扫到当作冗余代码。

## 9. 可执行顺序与验收门槛

1. 固定 MCP 可独立安装的依赖、真实路径和版本；确认只有一个控制入口，初期只开放审查过的读工具。
2. 完成能力清单；修正旧技能地址；复用 World Core 补导入/创建，复用账本补状态/配置/压缩/编辑。
3. 收紧通用写工具：Nora 管理的聊天/世界必须走 Nora 规则；MVU 不走裸 JSON 修改；快照按资源和预算收敛。
4. 更新各专项技能及共享契约，统一源码发布清单。保留有用 CLI 作为薄兼容入口，不能与 MCP 继续各养一套业务规则。
5. 若需操作前台会话，再实现受限 Dispatcher 接入和真实回执；不要提前宣称 MCP 支持完整游玩控制。
6. 在隔离实例跑状态、导入、幂等重试、编辑截断、压缩失败/pending/active、MVU 页面不存在、费用/超时、投影和权限回归；随后经用户授权接入远端 Hermes。

必须证明：重复导入不重复建世界；压缩失败不锁历史；压缩已生效的消息不能改；未压缩编辑删除后文并正确重算；只读查询不触发付费任务；暂停页面不会伪报执行成功；普通任务看不到维护工具；有限修改不会复制整份用户数据；USER/MEMORY 投影不串内容且保留非托管文本。

当前证据级别：MCP 类型检查与工具发现通过；实际接入和以上业务验收尚未进行。
技能设计遵循“小入口、清晰所有权、按需加载”的规则，本次没有改动技能文件来掩盖接口缺口。

## 附：本次授权的远端维护结果

- 删除 69 项已核对的 Tavern 旧备份/部署暂存/非活动测试运行目录。实际空闲空间增加 4,389,249,024 字节，约 4.09 GiB；旧备份不可恢复。未删除其他 Hermes 系统备份。
- 世界、聊天、档案、模型设置及 USER/MEMORY 校验不变；两个记忆文件的托管标记均真实存在。
- ClawChat 注册名已回读为 `tavern` / `story profile`；保留原 App ID、URL 和 public 访问策略。底层 Liveware 管理记录的历史 name 字段没有通过不存在的 rename 命令修改。
- 酒馆 favicon 哈希不变；Story Profile 增加独立书本 SVG，服务端 HTML title/rel=icon 已校验，静态资源 HTTP 200。
- 已同步本地原 Story Profile 源文件、嵌入快照和注册脚本默认名称，防止下次发布覆盖。未提交 Git。
- 远端服务 PID 10012，健康检查通过；未控制客户端浏览器，因此不宣称已目视验证用户端图标缓存刷新。
- 变更时仅临时备份受影响文件，成功后清除该远端临时备份；本机保留小型变更记录。远端清理与部署回执在 `/opt/data/tavern-state/native-runtime/deployment-receipts/`。
- 图标/标题读取机制依据平台官方固定版本示例：[liveware-sample/server.mjs](https://raw.githubusercontent.com/clawling/clawchat-plugin-install-cli/skills-v1.7.0/livewares/openclaw/liveware-sample/server.mjs)。
