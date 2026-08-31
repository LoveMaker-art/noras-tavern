# Tavern 架构、冗余与发布就绪审计

日期：2026-08-30。审计对象：本地 `tavern`，`main@9f0ba72634e1fbbd93bb915d4a9c61cd25b50ab5`。

本轮开始时 Git 工作树干净。本轮只生成索引、诊断夹具和审计文档，未修改业务实现、未提交 Git、未部署、未操作浏览器或调用付费模型。隔离构建没有回写当前运行目录。本文取代旧架构文档中对“当前版本全部通过”的泛化解读，不抹去历史执行记录。

## 一、结论

**当前不宜作为“下载后可放心使用”的正式稳定版发布。可以继续受控测试，但不能把 Git 干净、能编译、旧测试记录通过，等同于产品已经可靠。**

不是“两套完整酒馆后端同时运行”，也不是必须推倒重写：World v2 权威存储、服务端导入事务、ST 兼容执行、Nora 产品控制器的主方向成立。当前问题是若干关键契约没有收口，并且后续修改没有与测试和交付流程一起维护。

本轮确认的重点是：

1. 打包边界不安全：被 Git 忽略的运行数据、日志和凭据仍可能进发布包。
2. 空工作区首次发送存在 readiness 等待不结束的路径。
3. World Store 的跨世界并发提交能使资源引用索引与磁盘记录不一致。
4. 操作层宣称的超时上限没有覆盖挂起的 HTTP 请求。
5. 冷分词器存在重复下载/实例化与无显式下载超时。
6. 当前测试、架构契约和工作流门禁没有通过，且部分门禁已经过时。

这些不是同一件事，也不能靠“再加一层缓存”“再隐藏几个控件”一起解决。

## 二、范围与证据等级

验收对象是用户能安装、打开、创建/导入、聊天、编辑/重生成/智能回复、从卡库建世界、刷新/重启恢复，并且分发时不携带作者数据。

本轮已做：

- 全仓 Git 文件清单、文件哈希、MCP 图覆盖核对；重点阅读当前重构计划、模块组装和主链路实现。
- World/Session/资源/操作日志、浏览器激活、生成、插件、模型配置、Story Profile 接口、生命周期与打包路径审查。
- 当前 Nora 行为测试、全部架构契约、Lint 和五流程技术门禁；失败项分类。
- 从 `git archive HEAD` 导出的独立目录执行离线干净安装、构建、重复构建和打包排除规则测试。
- 用真实实现、假数据和可控依赖复现 readiness、分词器、资源索引、HTTP deadline 和 CSRF 问题。

**未达到的等级：** 未做当前版本的完整真实浏览器五流程、远端 Liveware 冷/热 P95、真实复杂卡全矩阵、完整安全渗透或所有供应商验证。也没有在 Linux 干净机器上完成安装验收。静态调用图不能证明第三方动态脚本和所有事件分支正确。

因此，这是一轮全仓架构/交付审计和关键故障技术复现，不是“已逐行证明全部代码无缺陷”。本文列出的确认项不是全项目潜在缺陷的总数。

## 三、现在的真实架构

```text
Liveware / 浏览器
  └─ Tavern Node 服务（单工作区）
       ├─ Nora World Core v2：World 身份、Session 绑定、资源引用、持久操作
       ├─ ST 兼容内核：卡文件、chat JSONL、世界书、提示词、模型请求
       └─ Story Profile Adapter → Python 子进程 → 随包快照的档案逻辑

浏览器产品层
  Nora UI 控制器 → 具名 Story 域 → ST Adapter → ST 运行时
  世界选择 → World Snapshot → ST 激活事务 → 增强能力独立加载
  消息/卡按钮/Helper → 交互适配 → StoryActionDispatcher → 执行接口
```

Python 生命周期工具不是第二个 Web 服务；Story Profile 按需 Python 子进程也不是第二套 World 后端。`app/story_profile_runtime` 是兄弟 Story Profile 项目的交付快照，不是应随意删除的重复业务实现。

| 模块 | 当前职责及代码依据 | 判断 |
| --- | --- | --- |
| World Core | `src/nora-world-core/service.js`、`store.js`、两个 journal、materializer | 真正拥有 World 语义；不是只给 ST 换皮 |
| ST 资源与生成 | `src/endpoints/{characters,chats,worldinfo}.js`、`public/script.js` | 为复杂卡复用而保留；不宜全部删除 |
| Story 域 | `public/scripts/nora-story-core/index.js:7` | UI 得到具名域；原 `story.runtime` 临时桥已不在这里 |
| 世界打开 | `nora-worlds/world-core-runtime.js:138`、`world-core-client.js:125` | 在线使用 Snapshot；验证 World/Session/卡绑定 |
| 增强能力 | `world-capability-controller.js`、`st-card-adapter.js` | 基础世界与能力状态分离；需要继续真实兼容验收 |
| 产品交互 | `nora-ui/story-action-dispatcher.js`、Helper Adapter | 主入口统一，但取消、等待、UI 投影仍须一起验证 |
| 生命周期 | `app/native_lifecycle.py`、`ops/scripts/runtime.sh` | 单 Node 进程，运行数据外置方向合理 |

旧 `/api/nora-worlds`、legacy browser reader 已退出在线路径。`src/server-startup.js:139` 只挂载 World v2；离线 `legacy-migration.js` 保留有实际迁移用途。不能因为它名字有 legacy 就认定仍有双架构。

## 四、必须收口的发布问题

### R01 — P0：打包脚本会把 Git 忽略的私人文件带进去

代码：`ops/scripts/package-release.sh:26-45`。

它对整个 `app` 做 tar，仅排除一组固定开发目录；没有按 Git 版本导出、没有完整排除 `.env`、日志、引擎 `data`、密钥文件。`.gitignore` 对 tar 没有保护作用。

复现：在隔离副本里放三个明确的假文件，提取并执行原脚本的 tar 命令。压缩包实际包含：

```text
app/.env
app/audit-runtime.log
app/engine/sillytavern/data/default-user/secrets.json
```

没有读取真实密钥做测试，也没有发布这个夹具包。当前已跟踪文件的常见凭据模式扫描未发现命中，不能由此推断现有打包方式安全，更不能推断已发生真实泄漏。

处理：从确定 commit 的干净 staging 目录组装发布包，显式列出源文件与必要构建产物；增加包内禁止路径扫描和假凭据回归。不在活动源码目录直接 tar，不只依赖越来越长的排除名单。

### R02 — P1：空工作区首次发送可能永久等待

代码：`public/script.js:971,1067-1083,4534-4541`；`nora-ui/startup-controller.js:82-110`。

启动时先建立 `waitForNoraUsable()` Promise。没有世界时，`finalizeUi()` 加了 `nora-runtime-ready` class，却不发 `nora:usable`。已经等待的 Promise 不会因为后来 class 改变而重新求值；发送又等待由它派生的生成前置 Promise。

最小复现运行真实 `finalizeUi()` 和抽取的真实等待函数：

- runtime-ready class：已存在。
- 先注册的等待：未完成。
- 后注册的等待：立即完成。
- 手动发送正确事件的正向对照：原等待完成。

这是两个“ready”语义混用造成的时序问题。不能用无世界时伪报“世界可用”掩盖。

处理：分离“引擎/生成基础依赖就绪”“应用空态可交互”“当前世界可用”；依赖就绪使用可重复查询的状态和同一个 Promise，用户可用事件只作真实结果观测。加入空数据首次创建→直接发送的完整回归。

### R03 — P1：World Store 跨世界提交会留下过时的资源引用表

代码：`src/nora-world-core/store.js:111-155`。

`put` 只持有 `world:<id>` 锁，但 `#commit` 会提前从全体世界计算 `ResourceCatalog`，等待文件落盘后再把整个 catalog 赋回。两个不同世界的写入可以交错：两份 manifest 均落盘，但最后一份 catalog 只知道自己计算时的世界集合。

可控文件系统延迟的复现结果：

```text
已保存世界数：2
内存中共享资源引用：[owner]             ← 少了 shared
owner 的 deletionPlan：允许删除该资源   ← 与两份 manifest 不一致
新建 Store 重新加载后：[owner, shared]  ← 磁盘记录没有丢失
```

这里确认的是 Store 接口不变量破坏和错误删除计划，未删除任何真实数据，未声称正常生产已发生误删。常规新导入的世界书被 materializer 标为 shared，实际误删还取决于资源 ownership 和随后操作；不能把该夹具扩大成“所有导入都会丢世界书”。

处理：跨世界唯一性校验、持久提交与全局资源索引更新必须共享一致性边界；可以用短的 store commit 锁或正确的串行提交队列，不必因此换数据库。保留每个世界 revision，增加跨世界并发创建/能力更新/删除的组合测试。

### R04 — P1：120 秒操作上限不能约束挂起的网络请求

代码：`nora-worlds/world-core-client.js:178-238`；相关调用 `nora-ui/world-controller.js:124-199`。

`waitForOperation` 在 `await operation()` 返回之后才检查总时间；请求本身没有 AbortSignal deadline。Snapshot 读取也没有请求级截止时间。网络请求若不返回，轮询上限、后续世界选择与 UI 释放都没有机会执行。

复现把 deadline 缩为 10ms，并让第二个真实 client 请求保持 pending：60ms 后操作仍 pending，两次请求都没有 signal；后来才返回 COMPLETED 时，操作还能按成功结束。

处理：传输层有明确请求 deadline 与真实 abort；持久操作保留可恢复 ID；世界打开超时释放 UI，不伪造后端失败或重复导入。此处不需要新建一套网络框架。

### R05 — P1：冷分词器初始化没有合并并发请求

代码：`src/endpoints/tokenizers.js:80-145,232-254`；DeepSeek 等远程 tokenizer 定义在同文件后续位置。

`WebTokenizer.get()` 只缓存完成后的 instance，不缓存正在初始化的 Promise。四个并发调用可重复取模型并初始化四次。下载用 `fetch(model)`，未设置显式超时；fallback 只有抛错后才能执行，不能解决一直等待。

真实类实现的依赖隔离复现：4 次并发 get → 4 次模型获取、4 次实例化；完成后下一次调用才复用实例。

处理：每个 tokenizer 单一 in-flight 初始化，下载 deadline、失败清理与可重试，缓存文件完整性检查；在安装/预热期准备必要模型，或者按明确策略使用近似计数。**已有磁盘缓存有用，不是每次刷新都重新下载；缓存不能替代冷路径正确性。**

### R06 — P1：当前发布门禁不通过，而且不能准确代表用户流程

在正确引擎工作目录、允许本机测试端口后：

| 检查 | 当前结果 |
| --- | --- |
| Nora 行为测试 | 276 项：266 通过、9 失败、1 跳过 |
| 架构契约逐项执行 | 25 项：21 通过、4 失败 |
| Lint | 79 个错误；全部是两个引擎文件的缩进错误 |
| 五流程技术门禁 | 总门禁失败：架构契约失败；不等于浏览器五流程已验收 |
| Story Profile 快照核对 | 当前标准兄弟目录布局下通过 |
| 干净离线 npm ci（含生命周期脚本） | 在本机隔离副本通过 |
| 完整构建 / 同目录重复构建 | 均通过；重复构建所比较文件无差异 |

9 个行为失败须分类，不是 9 个已确认用户 bug：

- 3 个 Story Core 测试：假 runtime 清单没跟上新增 `runSlash` / `prepareMutation`。
- 3 个 presentation 测试：旧字符串/控制流断言与新版不符，Fake DOM 缺 dataset；这不能证明真实 DOM 同样异常。
- 1 个 dispatcher 测试：仍把不同文本、无相同 actionId 的两次请求当作“应共享一个 Promise”；当前实现拒绝忙时新请求。
- 2 个 Helper 测试：旧同步返回假设失败；之后未释放全局 bridge 引出第二项污染。停止接口测试单独运行通过。

4 个契约失败也不是同类：brand/shell 仍绑定旧名称；chat-window 要求 hydrateHistory 必须为函数第一条语句，不接受前置取消检查；ui-modules 则发现 `pending-message-view.js` 真实直接依赖 ST DOM，见 R07。

此外 `verify-product-workflows.mjs:39` 仍引用已删除的 `nora-interaction-controller.test.mjs`。本机 Node 22 的这次运行没有因该路径缺失而失败，反而显示这一流程技术组通过；不能只看退出码，必须先验证清单文件存在。它也没有因此覆盖替代的 dispatcher/Helper 新测试。

处理：先依据当前产品行为修正测试假设，不能把错误断言一删了之。给核心流程增加跨真实 Interface 的回归；工作流清单存在性校验；浏览器报告绑定 commit、环境和采样时间。现有 Lint 不覆盖 `app/native-extensions` 与 ops，要补自有代码检查范围。

## 五、冗余与模块设计债务

### R07 — P2：消息展示职责又出现越界，并且“思考时长”混入准备耗时

代码：`nora-ui/pending-message-view.js:6-57`、`nora-compat/reasoning-view.js`、`public/scripts/reasoning.js:1233`。

pending view 自己识别 `.mes_text`、`.mes_reasoning`、`is_user`，并且用文本指纹判断新内容；原本的 `st-message-view-adapter` 也负责 ST 消息 DOM。这里存在重复的结构知识，改 ST 消息模板时必须同时修改多处。

等待框复用原生 details 是正确方向，不应退回第二套独立“假思考正文”。但原生点击处理仍禁止空 reasoning 展开，和“先点开等流式内容”的需求有冲突，相关假 DOM 测试未运行真实事件处理器。

`public/script.js:4534` 在准备历史/依赖前记录 generation_started，`:5593` 将它交给 StreamingProcessor，后者交给 ReasoningHandler。因此用户看到的思考时长可能包含准备和 token 等待，并非模型纯思考时间。

处理：把消息节点/内容归属判断集中回 ST message view Adapter；pending view 只消费结果。区分准备、请求、首个 reasoning、首个正文、结束时间，不擅自把模型没有返回的内容当作 reasoning。

### R08 — P2：存在可以退出的旧接口，但不是第二套在线架构

以下为清理候选，需依照调用证据和兼容承诺收缩，而不是按名字删除：

| 候选 | 当前证据 | 建议 |
| --- | --- | --- |
| `executeStActivationPlan` | MCP 入站路径只找到 `nora-world-core-client.test.mjs`；在线 runtime 使用 executeStActivationSnapshot | 退出旧浏览器执行器和只测它的测试；保留后端 plan schema，因为 Snapshot 仍包含 plan |
| `st-worldbook-adapter.listRecentWorlds` | 仍导出到 Story worldbook 域，实际调用 recent chats；当前产品控制器未见调用 | 移出产品 Worldbook Interface；不要借此误删 ST 原生 recent-chat endpoint |
| `prepareCharacterRuntime` / `waitForCharacterRuntime` | 老的整卡激活/等待接口仍导出，现行 World 能力链使用 ensureCharacterCapability；旧测试仍覆盖前者 | 在确认无外部契约后退出旧整卡等待入口，保留每项能力自己的执行实现 |
| 旧静态架构断言和状态文案 | 已证明与当前命名/接口不一致 | 同业务接口一起维护，不继续堆新测试同时保留失效旧测试 |

按命名规则选出的 98 个自有非测试源文件没有整文件 SHA 相同的重复项；这个范围不包含全部 ST 直接修改。MCP 相似度命中中还出现“外层工厂与它的内层函数相似”，不能把这种嵌套算成复制粘贴。真正的冗余主要是旧接口、重复状态判断、重复契约知识，不是整套目录重复。

### R09 — P2：交付源码、编译产物与插件补丁的来源管理不完整

代码：`build/sync-story-profile-runtime.mjs:10,81-105`、`package.json:119-128`、`.nora-upstream.json`、两个插件的 `UPSTREAM.md`。

- 单独导出 Tavern 后，快照 check 仍去读旁边的 Story Profile 源码，得到 ENOENT。README 说明了兄弟目录要求，所以这不是“安装必然失败”，但源码交付必须同时给出正确目录、依赖来源和固定版本。
- 指定现有兄弟源码后，完整构建通过，快照 changed=0。但 manifest 没有固定 sibling commit；同一 Tavern commit 的构建仍可能被兄弟仓库后续变化影响。
- 隔离重建与当前提交有 15 个产物路径字节不同；两份 gzip 解压后相同，JS 差异主要表现为 webpack module ID 数字变化。重复构建稳定。**这不能证明业务源码没打进包**，但说明不能把不同环境的任意构建产物混合上传、只看文件名判版本。
- ST 有上游 commit 元数据，但未找到计划 Workstream E 所要求的逐文件 patch manifest 与漂移门禁。Helper/MVU 有上游说明，但仓库主要交付修改后的编译实现，没有完整可执行的本地补丁重建链。

处理：发布记录固定 Tavern commit、Story Profile commit、Node/npm/依赖锁和构建指纹；必要产物一次性从同一 staging 构建。插件应有固定上游源码取得方式、可重复应用的变更和验收，不继续手改 dist 后只更新说明。

这不是要求消灭 ST 代码、改所有包名或立刻更换打包技术。许可证文件与来源应保留；本轮未给出法律合规认证。

### R10 — P2：Story Profile 原 UI 在 Tavern 宿主的请求适配有漏项

代码：`public/actor.js:144-152`、`public/actor.html:39-41`、`src/server-main.js:198-233`。

原 UI 的人格保存 POST 只有 Content-Type，没有获取/携带 X-CSRF-Token。Tavern 默认启用 CSRF，兼容路由在保护之后；security.js 没有补 token 的请求封装。

执行真实 savePersonality 函数、接真实 csrf-sync 中间件的隔离复现得到 403/EBADCSRFTOKEN；给正确 header 的正向对照通过。

范围限定：这是 **Tavern 内嵌 actor 页面在 CSRF 开启时** 的问题，不是对另一独立 Liveware Story Profile App 的运行结论，也不是说故事年表/偏好生成失败。修复应在宿主请求适配层完成，不能为了迁移 UI 而关闭整个服务的 CSRF。

`nora-story-profile.js` 的旧 World 字段 fallback 与 `runAdapter` 缺少统一子进程超时/输出上限也是维护候选；尚未复现故障，不与上述已确认 403 混为一谈。

### R11 — P2：旧文档的“当前状态”已经失真

`PROJECT-ARCHITECTURE.md` 仍描述临时 runtime bridge、已退出的 imports 路由、旧 overlay 和旧测试通过结果；原 INDEX-COVERAGE 指向旧提交。它们会让下一位维护者沿已退出路径继续修补。

本轮新增本文，刷新内容索引/覆盖说明，并给旧架构与发布基线加历史提示；没有擅自重写原重构计划。后续每次实现都需把变更、有效测试和当前架构事实一起更新。

### R12 — P3：有规模型性能债务，但不是当前推翻后端的理由

- `WorldStore.#load` 逐个世界重建 ResourceCatalog，并检查此前全集，启动加载有累计二次工作。
- 每次 `#commit` 重新构造 candidateWorlds、资源目录和所有索引；不是严格的增量索引更新。
- list 会排序并深拷贝全体 manifest，浏览器再作投影；Snapshot cache Map 没有显式容量/生命周期淘汰。
- Story Profile 聚合会读取多个世界的聊天；大量历史下应按实际测量考虑增量统计。

这些有代码依据，但本轮没有测出在目标数据规模下超预算。不建议仅为“先进”换数据库、加微服务或把所有控制器再包一层。先修正确性，再以规模基准决定是否优化。

## 六、哪些保留是合理的

- ST 的提示词、卡 schema、chat JSONL、世界书、Regex、Helper/MVU 执行环境：复杂卡兼容的代价，不是可整体删除的废代码。
- World manifest 与 ST chat metadata：前者权威身份，后者兼容投影；不是两个可随意互相写回的真相。
- StoryActionDispatcher 和 UiOperationRegistry：分别管理模型任务与非模型管理操作，职责不同；不能因为都有 busy 状态就合并。
- 磁盘 tokenizer cache、浏览器静态 HTTP cache、World Snapshot 内存重验证：缓存对象和一致性规则不同，不是“缓存重复了所以全删”。
- 离线迁移、必要许可证、插件依赖、Story Profile 随包快照：有明确用途。
- 单 Node + 原子 JSON + 内存索引：当前部署规模合理。需要修索引事务边界，不等于必须换数据库。

## 七、对外发布形态必须说清

`src/workspace.js:61-82` 固定使用 default-user；当前模型是 **每个用户/Agent 一个隔离实例或工作区**，不是同一个 Node 服务承载多个互不信任租户的 SaaS。

把程序分发给别人、由对方自己安装，方向可行；把当前实例开放给所有人共用，无法据此承诺世界、密钥和资源隔离。Liveware 访问控制与绑定环境本轮未审计，不应把 localhost 监听当成公网授权证明。

任意第三方扩展会依赖动态 DOM、运行时全局对象和远程脚本。只声明经过明确矩阵验证的能力，不能宣传“所有 ST 插件无条件兼容”。这与计划第 17、21、23.6 节一致。

## 八、建议执行顺序与退出条件

| 批次 | 工作 | 退出条件 |
| --- | --- | --- |
| 1：安全交付 | R01；固定发布输入与依赖身份 | 干净 staging、包内禁止项扫描、假敏感文件不会进包 |
| 2：基础可靠性 | R02/R03/R04/R05 | 空工作区首发可结束；并发资源引用一致；挂起网络可取消恢复；冷分词器单次初始化 |
| 3：接口收口 | R07/R08/R10 | 一处拥有消息 DOM 适配；旧无调用接口退出；原 UI 请求适配完整；思考原文和计时语义一致 |
| 4：发布证据 | R06/R09/R11 | 当前测试/Lint/契约全过且不是删断言得来的绿；同一构建身份；准确文档 |
| 5：目标验收 | 真实五流程 + 复杂卡矩阵 + 冷/热观测 | 每项匹配 commit/环境/数据条件；P95 达既定预算或明确接受差距 |

执行时每批按“现象与失败证据 → 改同一个责任模块 → 对原链路复测 → 对照计划”收口，不扩大到换框架、重写 ST、拆微服务或修改已确认 UI。

在上述门槛达到前，建议版本标记为测试版，并明确实例隔离、支持范围和已知问题；不要称为重构全部完成或正式稳定发布。

## 九、本轮索引与诊断材料

- 主 Codebase MCP 项目：`tavern`；全量索引基准为上述 HEAD。初次基准：826 File、246121 nodes、325222 edges。
- 主图覆盖 1121 个跟踪路径中的 826 个；476 个代码路径中 459 个进入主图。数字口径包含继承代码，不是自有代码量。
- 其余代码主要是构建产物、iframe vendor；MVU `vendor/bundle.js` 单独索引为 `tavern-mvu-runtime`。
- 尝试的 `tavern-helper-runtime` 只出现 CSS File，**不计作 Helper JS 已索引**。Helper JS 与 actor.js 通过 TypeScript AST 和 SHA 补充核对，均无语法诊断；分别识别 2004 与 11 个函数/类声明。不能把 AST 清单冒充完整 MCP 语义调用图。
- 内容哈希索引：`project-index.json`，覆盖口径及排除项见 `INDEX-COVERAGE.md`。MCP 主图和内容哈希各回答不同问题。
- 脱敏结论数据：`TAVERN-RELEASE-AUDIT-2026-08-30.json`。
- 本机详细日志与复现脚本：Git 忽略的 `local-state/architecture-audit-20260830/`。关键脚本为 run-checks、reproduce-boundaries、reproduce-store-concurrency、reproduce-transport、reproduce-profile-csrf、inspect-clean-release、verify-build-repeat、parse-index-gaps。

这些诊断 FAIL 表示成功复现了缺陷，不是本轮已经修复。隔离构建目录与假数据保留供复核，不进入源代码发布包。
