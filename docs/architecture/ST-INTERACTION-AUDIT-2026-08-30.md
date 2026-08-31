# ST／复杂卡交互适配审计：远端版本 cd7cf216e868460f

日期：2026-08-30。对象：当前 Nora Tavern；不包含 Story Profile 重构。

## 1. 结论与本次工作边界

当前不能声称“交互入口全部适配完成”，也不能保证电锯人的按钮接上以后其他卡就不会再出现无响应。

原因不是存在若干套独立后端，而是**同一个 ST 运行时有多种进入方式，Nora 新增的任务管理只接住了其中一部分；消息写入、异步完成、取消和世界归属仍有不一致**。

本轮只做审计、源码核对和隔离复现。新增清单和诊断脚本，未修改业务实现、未提交 Git、未部署、未重启服务、未调用模型、未修改真实世界或聊天数据。

已达到的证据级别：

- 静态清点和关键路径分析完成，范围见下一节。
- 两类电锯人相关机制已用卡内真实脚本／真实适配器在隔离环境复现。
- 本轮另有五项针对实际函数或现有适配器的隔离检查失败，列于第 4 节。
- **未达到**真实远端浏览器点击验收、全部动态脚本解析、修复完成或部署完成。

## 2. 分析依据：以远端实际文件为准

远端应用目录：`/opt/data/apps/tavern-runtime`。

取证时远端进程 PID `6312`，资源版本 `cd7cf216e868460f`，World V2 状态接口正常。2026-08-30 01:59:13 UTC 的哈希比对结果：

| 核对对象 | 结果 |
| --- | --- |
| 分析范围内本地应用文件与远端应用文件 | 325 / 325 一致，无仅远端存在的文件 |
| 运行数据目录中的托管扩展副本与应用源码 | 44 / 44 一致 |
| JavaScript AST 解析错误 | 0 |
| 远端现有世界 | 5 个，均读取其实际 Runtime Card，而非本地样卡 |

哈希范围包括 ST `script.js`、`public/scripts`、入口 HTML、Nora 构建产物，以及 Nora UI、Helper、MVU 扩展中的 JS/JSON/HTML/CSS 等。**不是整个仓库或远端操作系统的完整审计。**忽略 AppleDouble 元数据；第三方通用 iframe 库未逐行分析。

固定清单见 [机器可读清单](ST-INTERACTION-INVENTORY-2026-08-30.json)。其中包含文件依据、命令名称、别名、回调位置、Context 成员、Helper 成员、命名调用点、旧控件引用和角色卡字段位置，不存储聊天正文或模型密钥。

## 3. 实际入口清单及覆盖状态

### 3.1 数量究竟代表什么

- 发现 **239 个字面量命令定义**、**124 个不同的字面量别名**；另有 1 个接收动态命令名的通用定义包装器。它们不是“239 套架构”，也不是当前浏览器一定已注册的命令数。
- 其中 ST 核心 `slash-commands.js` 有 91 个定义，其余分布在变量、世界书、角色、扩展等源码和 Helper 中。部分内置扩展当前被禁用。
- ST `getContext()` 顶层对象有 **162 个成员**，包括状态、常量和函数，不能把它们全部叫成模型调用接口。
- Helper 顶层对象有 **157 个成员**，另有 **34 个 `_bind` 成员**会转换成 iframe 全局函数。这些计数也不是“157 + 34 个互不重叠的业务功能”。
- 找到 81 个指定函数名的调用点、49 个指定旧控件选择器的字符串位置。这是定位辅助，不是完整跨文件调用图，也不表示有 49 个已发生的故障。

命令注册是动态的：`SlashCommandParser.addCommandObject()`、旧 `registerSlashCommand()` 和扩展脚本还可以添加命令。静态计数不能代替运行时注册表。

### 3.2 按真正的行为区分，不按按钮文字区分

| 进入方式 | 当前执行路径 | 审计结论 |
| --- | --- | --- |
| Nora 发送、重生成、编辑、Swipe | controller → StoryActionDispatcher → ST message adapter | 已实现集中入口；任务生命周期仍有下述缺口 |
| 卡片 `request_chat_completion`／`request_chat_stop` | card-action-gateway → dispatcher | 已映射；仅授权当前消息中直接 iframe 的 source |
| 卡片 `slash-command` | gateway 未识别该名称 | 返回 unrelated-message；没有执行命令，也没有结果回执 |
| `TavernHelper.generate()`／`generateRaw()` | 新 Proxy → sidecar.run → Helper 原实现 | 仅在取到新 Proxy 时成立；早期复制的函数不会自动替换 |
| `TavernHelper.stopGenerationById()`／`stopAllGeneration()` | 新 Proxy → 取消任务／原生停止函数 | 调用接口存在；未等同于 Nora 可见停止按钮已管理全部 Helper 任务 |
| `triggerSlash()`／`triggerSlashWithResult()` | Helper kq → ST executeSlashCommandsWithOptions | 原生直通，没有经过 Nora Story dispatcher |
| `/send`、`/trigger`、`/regenerate`、`/continue`、`/swipe` | ST 命令回调 → 原生消息／生成函数 | 语义不同，不能统一粗暴替换成“发送并生成” |
| `/gen`、`/genraw`、`/sysgen`、`/ask`、`/impersonate` | 各自回调 → quiet/raw/Generate 等 | 不经过 Helper Proxy；有返回值、角色、上下文等额外语义 |
| `/stop` 与 `/abort` | 前者停止 ST 生成；后者终止 Slash 执行控制器 | 两者不是同一个停止动作，不能无条件互换 |
| `SillyTavern.getContext()`、脚本直接 import | 原生导出函数／可变状态 | 保留兼容性入口，同时可以绕过 Nora 顶层封装 |
| Helper 消息增删改、旋转、变量和世界书函数 | 原生 Helper → chat／变量／世界书逻辑 | 不需要每次调用模型，但需要正确的会话归属、序号和写入顺序 |
| iframe 全局 `generate`、`eventOnButton` 等 | Helper 注入代码复制函数并绑定 `_bind` | 必须覆盖函数分发和事件触发，不只是 window.TavernHelper 对象 |
| 旧 DOM 点击、快捷键、第三方嵌套 iframe | 取决于具体监听器与 source | 不可因搜到选择器就宣布支持；已删除控件不能作为有效执行入口 |

特意纠正一个容易误判的点：ST `Generate()` 本身已有 `ensureNoraFullChatLoaded()` 和启动 prerequisites 等待（`script.js:4531`）。因此不能笼统说“所有原生生成都完全没有前置保障”。真实缺口包括 `/send` **先修改，再进入保存时补历史**，以及 Nora 模型准备／任务所有权未在所有入口统一。

## 4. 已定位问题与可重复证据

### A. Helper 就绪与函数发布存在竞态

- `st-card-adapter.js` 在扩展激活返回后立即调用 attach；返回 false 就判失败。
- Helper 的 `Rq()` 发布 `globalThis.TavernHelper`，但调用位于 jQuery ready 回调中；模块导入完成不等于这个回调已完成。
- 当前 `tavern-helper-action-adapter.js:68` 只检查当下对象，没有等待真实发布的握手。
- 远端电锯人、萧凡宇宙最近保存的 Helper 记录均为 `NORA_TAVERN_HELPER_ACTION_ADAPTER_UNAVAILABLE`；同次 MVU 后续记录为 READY。能力状态是历史检查证据，不证明点击瞬间所有接口都不可用。
- 隔离复现：检查时 unavailable，延后的 Helper 发布后 attach 成功。
- 另一个相关缺口：Helper iframe 注入字符串会复制父窗口函数。已复制的原始函数不会因父窗口后来套 Proxy 而更新。隔离复现中调用次数 1、登记任务数 0。

### B. 电锯人的后备消息未被接收，卡内却显示成功

原始 Runtime Card 的 `data.extensions.regex_scripts.8.replaceString`（自由模式）和 `.6`（主线模式）使用 Helper Slash，缺少 Helper 时回退发送 `{ type: 'slash-command', content: ... }`。

`card-action-gateway.js:12` 的名称识别只包括若干 `request_*` 和 `nora.card.*`；它不包括 `slash-command`。事件监听器也未向 iframe 回传接收／失败／完成结果。

隔离回放自由模式实际脚本，姓名年龄已填、Helper 不可用：卡内状态变成“初始化完成”，gateway 结果为 `ignored/unrelated-message`，任务数量为 0。

**证据边界：**这是确定存在的失败分支。未读取实际浏览器点击现场，不能认定用户每次点击都一定走这个分支。缺姓名或年龄时原卡会主动 alert，这与丢消息是不同情况。

### C. 长会话中的原生 `/send` 可以返回成功却丢掉刚写入的消息

实际顺序：

1. `sendUserMessageCallback()`（`slash-commands.js:4611`）调用 `sendMessageAsUser()`。
2. `sendMessageAsUser()`（`script.js:6071`）先对当前 `chat` push/splice。
3. `saveChatConditional()`（`script.js:9707`）才调用 `ensureNoraFullChatLoaded()`。
4. 当只加载了聊天窗口时，后者读取已有磁盘历史并用 `chat.splice(...data)` 替换当前数组（`script.js:735`），覆盖第 2 步新写入的消息。

隔离测试执行这三个真实函数，仅替换 I/O 和浏览器依赖：已有 60 条、内存仅最后 20 条，发送一条后函数返回 `new-message`，但最终内存和模拟保存结果中均没有它，仍是 60 条。

这是**已复现的顺序错误**，不是“推测有可能慢”。它不证明远端某一次开局已经发生了数据丢失；电锯人当前短开局不一定满足该条件。其他先改 chat 再保存的 Helper 接口也需要逐项补同类验证，不能直接宣布它们全都已经复现。

### D. Slash 错误与异步完成不能可靠传回调用者

- `executeSlashCommandsWithOptions()` 的解析错误分支默认处理 toast 后返回新的 `SlashCommandClosureResult`，未设置 `isError`；其默认值为 false。
- Helper `kq()` 只检查 `result.isError`，因此解析错误仍可正常 resolve。真实函数隔离复现结果为 resolved，而非 rejected。
- `/trigger`、`/regenerate`、`/swipe` 默认 `await=false`。原生函数返回，含义可能只是“安排后续执行”，并不是“模型回复已经完成”。
- `/gen`／`/genraw` 的部分异常被捕获、显示 toast，最后返回空字符串。上层必须区分这些返回约定，不能统称成功。

### E. 任务取消、重复请求与世界归属没有形成完整约束

`story-action-dispatcher.js`：

- cancel 标记只在 catch 分支转成 cancelled；若底层停止后正常 resolve，then 仍产生 completed。隔离复现已确认。
- `lastFailure` 未携带 World/Session ID，retry 也未验证世界。A 世界失败、切换为 B 后 retry，会在 B 执行 regenerate。隔离复现已确认该 dispatcher 行为。
- `active.has(scope)` 返回同一个 Promise，并没有比较命令内容或请求 ID。两个不同操作也会被当成重复请求；现有测试甚至把两个不同文本的这种行为当成预期。
- `index.js` 向 WorldController 传入 `isGenerating`，但当前 WorldController 参数未接收、内部也未调用它。世界操作锁与 story／sidecar 锁不是同一个约束。不能据此直接断言实际发生了跨世界写入，但阻止它的完整机制尚未建立。

### F. Helper 生成状态和停止交互并未真正全部统一

- Helper 的 EK 仍维护自己的 generation map 和 `bindToStopButton` 集合，源码仍监听已删除的 `#mes_stop`。
- Nora `message-controller.js:215` 从 dispatcher 的 story scope 同步生成状态；Helper 被登记为 sidecar，不会因此自动显示主聊天停止状态。
- Helper 显式 stop 接口被代理，不代表旧按钮监听已被替代。`bindToStopButton=true` 的调用如何出现在 Nora UI、用户点停止要取消哪类任务，必须明确并验证。
- MVU bundle 包含全局 `generate`／`generateRaw` 调用。是否经过 Proxy 取决于 iframe 获得函数的时机；不能因为父窗口对象被代理就宣布 MVU 全路径受管理。

### G. 现有清单、日志与测试提供了过强的“完整”观感

- 旧 manifest 只列 13 类能力。它的测试检查手写清单自身，不能发现清单之外的原生入口。
- `story.swipe` 在旧清单标为 `model_output: none`，但 message adapter 右划到末尾会准备模型并可能生成新回复。这是文档错误。
- `unknown_card_action_policy: explicit-error` 实际仅对已识别前缀下的未知名称成立，`slash-command` 不在其中。
- `__NORA_ACTION_LOG__` 是浏览器内存中最多 100 条的数组和 console 日志。不是全部持久化到远端的交互日志。已有启动观测不等于所有卡片操作可追踪。
- 本轮既有相关单测 **16/16 通过**，新增诊断 **5/5 暴露缺口**，二者并不矛盾：覆盖的场景不同。

## 5. 五个世界的实际样本

| 世界 | 检测到的相关内容 | 尚需验收 |
| --- | --- | --- |
| 电锯人 | 开局菜单修改 Swipe；主线／自由模式使用 `/send | /trigger`；后备 `slash-command`；Helper 世界书更新 | 两种 Helper 状态下都能进入开局；变量和世界书写入正确；解析／模型失败不假成功 |
| 萧凡宇宙 | `request_chat_completion`；`createChatMessages + /trigger`；消息、变量、世界书写入 | 不重复插入消息；真实开局完成；长会话后按钮仍有效 |
| 废土机娘 MVUZOD 4.0 | 输入框操作；声明外部前端页面与 MVU／schema 资源 | 外部前端实际载入内容、嵌套 iframe 路由、MVU 开关和停止 |
| 噬血狂袭 夜之帝国 | Helper 脚本及声明的 MVU／schema 外部模块 | 外部模块实际解析路径、变量更新与消息归属 |
| 六道轮回 | 本轮关键入口 token 扫描未匹配 | 不等于无交互；仍需要 Nora 发送／编辑／重生成／长会话验收 |

远端安装的托管扩展为 Helper、Nora MVU、Nora UI。全局 Helper 脚本树读取到启用的 `Nora MVU Runtime` 一项。

部分卡声明未固定提交版本的外部 JS，或者 beta 标签、远程 HTML。部分声明可能被现有 managed runtime 重写为本地资源；本轮未把声明地址当成实际网络请求，更未把所有外部代码宣称为已经审计。完整兼容认证需要记录实际解析出的资源和版本。

## 6. 下一步修复范围：按共同机制推进，而非按卡增加特例

这是基于本轮证据收敛的实现顺序；**不是已经完成的修复清单**。

### Part 1：消息变更的顺序与会话归属

- 把“绑定 World/Session → 补齐必要历史 → 转换消息序号 → 修改 → 保存”的保证放在共同的消息写入 seam。
- 首先覆盖原生 `/send`、Nora 发送、Helper create/set/delete/rotate 的异步写入路径。
- 不再把保存时的全量替换当作修改前准备；不能用另一层事后恢复补丁掩盖顺序问题。
- 不强行把所有世界启动都改成加载全量历史，避免用启动变慢交换正确性。
- 保留 Helper 同步读取接口的签名。同步读取完整历史与当前窗口模型之间的兼容语义仍需明确，不能悄悄改为 Promise 或声称已等价。

验收：60 条历史的诊断通过；序号、已有 Swipe、变量、聊天头均不被覆盖；失败保存不能回报持久化成功。

### Part 2：Helper 发布与稳定接口

- extension import、API 发布、可调用 readiness 分开；在真正发布点进行握手，而不是一次立即检查或任意加长 timeout。
- 保证 iframe 复制到的函数始终进入有效的执行入口；只替换父窗口对象不够。
- 不改卡片源码，不增加隐藏的 `#send_but/#mes_stop/#options_button`。

验收：冷启动、延迟发布、重入初始化、切世界后重建 iframe 都正确；不出现“稍后成功但能力永久降级”。

### Part 3：Slash 与消息传输适配

- 保留 ST Parser、闭包、变量、管道、命名参数和扩展注册能力，**不自建简化 Slash 解析器**。
- 适配实际命令执行 seam 和副作用函数，不只适配 `triggerSlash` 名称；直接导入原函数也不能绕开必要保证。
- `/send` 仍只插入用户消息，`/trigger` 才请求回复；不能把 `/send | /trigger` 映射成两次生成。
- 生成执行的内部重入要携带明确任务上下文，避免 dispatcher → adapter → core → dispatcher 自锁，也避免用一个全局 bypass 布尔值破坏并发。
- 授权当前有效 iframe 后识别 `slash-command`，传给原生解析链；对支持回执的协议回报 accepted/failed/completed，不把提交等同完成。旧卡不监听回执时由 Nora 给出可见结果。
- 外部来源、已销毁 iframe、未知相关命令要按规则拒绝并记录；无关系统 postMessage 不应全部报错。

验收：普通文本、复杂转义文本、管道、`await=false/true`、非法命令、命令抛错、重复点击；模型只调用预期次数。

### Part 4：取消、重试与世界切换

- task 绑定 World ID、Session ID、请求 ID；重试只能重试原任务或明确拒绝过期任务。
- 取消是可验证的终态，不因底层正常 resolve 又变 completed。
- 不同请求不能仅因 scope 相同就假装成功合并；明确返回忙碌／排队语义。
- 按 `bindToStopButton` 和任务类型连接 Nora 可见停止入口；保留 Helper ID stop 与 Slash abort 的区别。
- 切世界必须显式处理在途任务，不让旧任务更新新世界的 UI、变量或聊天。是等待、取消还是禁止切换需要固定一种产品行为，不能隐藏猜测。

验收：取消前、流式中、完成边界取消；失败后切换世界；副任务和主聊天并行；不会取消其他世界任务。

### Part 5：可观测验收与清单更新

- 用 actionId 关联 iframe 来源、命令、World/Session、解析、消息写入、模型开始／结束和错误；不记录密钥和完整提示词。
- 将必要的脱敏事件汇入现有观测设施，避免另起日志系统，也避免仍只能依赖浏览器内存数组。
- 用测试扫描实际注册和实现，而不是只校验一份手写白名单。
- 更新旧 manifest：区别声明支持、已实现、隔离验证、真实卡验收、明确不支持和未审计。
- 远端验收需要实际交互证据；本轮未获浏览器操作授权，不冒充已经点击验证。

## 7. 验收矩阵与停止条件

每一入口至少核对以下维度，不能仅通过单张卡初次点击：

| 场景 | 必须观察到的结果 |
| --- | --- |
| 刷新后立即点击、Helper 延后就绪 | 等待有明确状态，ready 后可执行；失败有准确原因 |
| 切走再切回／iframe 重建 | 新入口有效，旧入口不能写入当前世界 |
| 重复同一请求／连续不同请求 | 同请求幂等；不同请求不被静默丢弃 |
| 超过初始聊天窗口的长会话 | 新消息、编辑、变量、Swipe 保存后仍存在 |
| Slash 解析失败／命令失败 | 调用者或 Nora UI 明确失败，不显示初始化成功 |
| 无模型／模型拒绝／空回复 | 错误状态可恢复，不重复插入已经保存的用户消息 |
| 停止主生成／停止指定 Helper 任务 | 停止正确对象，终态 cancelled，其他任务不受误伤 |
| 外部代码／嵌套 iframe | 明确解析版本、来源授权和支持范围；未审计不得标为通过 |

任何一 Part 完成后，应复查：是否改了公开语义、是否增加启动串行等待、是否修改单张卡、是否真正跨越失败链路验证。出现数据错写或世界串线先停后续扩展，修正共同机制。

## 8. 可重复执行的方法

在仓库根目录：

```sh
node ops/scripts/audit-st-interaction-surface.mjs source "$PWD/app" /tmp/nora-interaction-source.json
node ops/scripts/replay-st-interaction-gaps.mjs
```

第一条只扫描源码，输出 JSON。第二条是固定本次版本的诊断，不在正常测试套件里；当前预期退出码为 1，五条 `pass:false` 对应本轮证实的缺口。它使用真实函数和隔离的 I/O，并非浏览器端到端测试；函数结构变更后需同步审查提取位置，不能把诊断失效误报成问题修好。

远端扫描脚本支持 `fingerprints` 和 `cards` 两个只读模式，经 SSH 标准输入执行即可，不必安装到远端 runtime。命令行的 root 参数必须使用实际应用路径；远端数据定位固定为当前部署目录布局。

本报告的最终结论：**当前入口范围已得到比原 13 项清单更完整、可复核的清点；关键缺口有实际源码和失败复现。但尚未完成统一适配，更没有证据承诺任意复杂卡今后永不失效。**
