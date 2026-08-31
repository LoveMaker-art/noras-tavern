# 剧情账本插件：实现与交付边界

日期：2026-08-30。状态：已部署本地 8799 服务并执行真实模型接口测试；随后经用户授权部署远端（SSH 11746、PID 9771），账本与投影技术检查通过。没有提交 Git或完成真实卡片的浏览器验收。真实测试结果见 `TAVERN-STORY-LEDGER-LOCAL-30-ROUNDS.md`；最新部署记录见 `TAVERN-STORY-PROFILE-LEDGER-PROJECTION.md` 末尾。

## 1. 已确认的产品规则

- 默认启用、无插件管理 UI，每个用户 / World / Story Session 分开保存。
- 一轮指一个非系统用户消息及其后续回复，不是两条任意消息。
- 最新用户轮保持原文；凑够 **15 个可压缩历史轮**才后台处理。
- 第 16 轮有回复保存后，首次可处理 1–15；第 31 轮可处理 16–30，合并成累计账本 1–30。
- 完整 JSONL 不因压缩而删除。只有主动编辑历史会按用户确认的规则删除其后的对话。
- 摘要生成、校验、持久化只得到 `pending`，不立即禁止编辑。
- 实际发送时，摘要必须进入最终模型请求。后端校验最终请求体，收到上游成功状态后将其标记 `active`。
- `active` 覆盖的历史隐藏编辑按钮，服务端也拒绝改写；`force` 保存不能绕过。
- 未压缩历史可以编辑。编辑用户消息会删除该消息的旧回复及其后全部消息，再生成；编辑助手回复保留编辑后的回复、删除其后消息，沿用“保存”而非擅自重新生成的交互。
- 轮数从当前保存的聊天重算，不维护只增不减的计数器。

例如：已启用 1–15，目前聊到 25。修改用户第 18 轮后，保留 1–17 和修改后的用户18，删除旧助手18及19–25，然后生成新的助手18。已启用的 1–15 不变。

## 2. 对原 Python 的实际参考

来源为 Git `v1.24.12`（`aaa1afceb2e40512cdd52b91e6db4924387c2db9`），未恢复已删除的旧项目目录：

- `app/backend/story_ledger.py`：按轮覆盖、前缀签名、有效账本检查。
- `app/backend/story_state_service.py`：批次划分、整轮分段、字段与实体引用校验、容量裁剪、记忆丢失检查。
- `app/backend/server.py` 的 `_merge_story_state_batch` / `_summarize_story_state` / `_schedule_story_state`：前账本与新增整批合并、后台调度、提交前检查原历史是否变化。
- `app/backend/actor.py` 的 `_fit_history` / `_story_state_block`：账本和未覆盖原文共同进入上下文。

保留的账本字段：`timeline`、`facts`、`open_threads`、`objects`、`secrets`、`scene`、`style_notes`。没有改成固定五轮摘要。

账本上限 15,000 字符；批次输入估算 50,000 tokens，过大时仅按完整轮切段；单个特别大的轮不截断。模型调用温度 0.1；输出上限原沿用 Python 的 6,000 tokens，2026-08-30 按用户要求提高为 **20,000 tokens**，仅作用于后台账本压缩，不修改正常聊天的模型额度或思考设置。同模型最多六次校验/暂时性 HTTP 错误重试，总 deadline 仍为 120 秒。失败保留原文和上一份可用账本。

**没有复制原版的另一个 `runtime_cast` 角色状态压缩模块**。当前 Nora 角色卡 / MVU 是已有状态来源，本次不建立第二套角色状态系统。2026-08-30 补充接通已生效账本到 Story Profile `shared_story_memory` 及 Hermes `MEMORY.md` 的原版投影，见 [投影规则与验证](TAVERN-STORY-PROFILE-LEDGER-PROJECTION.md)。Nora World 当前没有原版的人物 roster；因此仅提供真实存在的 `__user__` 引用。其他人物的名字和知情事实保留在文本内容中，不伪造人物 ID。原版完整人物引用结构需要真实 roster 才能恢复，不能声称本插件已迁移整套人物状态系统。

## 3. 模块与接入点

### 后端账本模块

`app/engine/sillytavern/src/nora-story-ledger/`

- `schema.js`：纯规则、严格结构校验、完整轮分段、裁剪与质量检查。
- `core.js`：候选 / 启用状态、后台任务、短写入锁、发送期间的临时保护、原子分支编辑。
- `runtime.js`：通过 World Core 确认 Session 的真实聊天文件绑定，读写独立状态。
- `model.js`：读取当前 Nora 的文本模型及服务器端密钥，增量压缩。请求过程中固定同一 endpoint / model / key，不把切换后的密钥发给先前供应商。
- `state-file.js`：统一状态文件定位与 Session 删除清理；删除世界时不遗留剧情摘要，迟到的后台结果不重新创建已删除 Session 的状态。
- `profile-projection.js`：读取并验证 active 账本，调用原 Story Profile 投影；合并同步请求、后台重试、删除清理、进程首次使用恢复。不增加模型调用，不改变偏好复盘与原版页面。

状态位于用户数据根目录 `nora-story-ledger/<World+Session 的 SHA-256>.json`。不相信客户端回传的“已压缩”元数据，不把密钥写入状态，不以角色卡文件名作为业务身份。

### 前端插件

- `app/native-extensions/nora-ledger/`：托管插件入口及 manifest。
- `public/scripts/nora-story-ledger/history.js`：前后端共用的轮数、覆盖范围和前缀语义。
- `public/scripts/nora-story-ledger/client.js`：状态投影、历史来源标记、发送计划与编辑请求。
- Nora webpack 入口与 ST import-map 使用同一 `Symbol.for` 页面状态注册表，防止加载出两个互不相通的插件实例。
- 插件由 Nora runtime 组装启动，扩展加载器标记其为已内置，避免重复执行另一份源码。
- `native_lifecycle.py` 把 `nora-ledger` 加入托管列表，并从旧扩展清理名单中移除。

### ST 与 Nora 的必要接入

- ST `setOpenAIMessages` 保留来源标记。
- `prepareOpenAIMessages` 在**原始历史完成世界书扫描之后**，以账本替换已覆盖历史，账本参与 ST 的 prompt token 预算。
- 如果预算组装失败、账本 prompt 被关闭、或最终请求缺少账本文本，恢复完整历史的原生组装路径；仍遵守原生上下文预算，并不承诺超长原文全部能塞进模型窗口。
- `sendOpenAIRequest` 携带内部账本证明；后端在 custom body / prompt 后处理之后检查实际请求体，证明不转发给模型。
- `/api/chats/save` 做服务端前缀保护，锁内完成校验和同步原子 JSONL 写入。
- Nora 编辑用 `/edit` 一次删除后续分支，避免每删一条就发一次远程保存；保留 ST 的编辑正则、宏、bias 和 MESSAGE_EDITED / MESSAGE_DELETED 事件。
- Nora 历史编辑禁用旧的“每次输入自动保存”，只在明确保存时执行分支修改。
- 原生聊天重命名/删除不能绕过 World 删除操作解绑受管 Session；导入聊天不允许覆盖一个已存在的目标文件。

## 4. 一致性与失败语义

1. 压缩时复制完整目标批次和签名，释放写锁后调用模型。
2. 提交候选前重新检查该批次的签名和前一检查点。追加新轮不会使旧批次失效；改写相关历史会使结果失效。
3. 候选生成期间仍允许编辑未启用内容。
4. 请求即将发送时，后端临时保护该候选覆盖的前缀，避免在网络等待期间被另一请求改写。
5. 最终请求体中必须包含精确账本文本。上游非 2xx / 连接失败会释放临时保护，不推进 `active`；非流式 JSON 的显式 error 也不推进。
6. 流式以最终请求已发出、上游返回成功响应头为启用点；这表示上下文已交付，不代表保证整次模型回复不会中途失败。
7. 关闭后台压缩、刷新、重启均不解除已经启用的前缀保护。
8. UI 缓存不是权限来源。过期浏览器、脚本直写、强制保存都经过服务器检查。
9. 锁定叙事文本、作者/角色、消息顺序、当前 swipe、bias、媒体和工具调用；不冻结 MVU `stat_data`、token 缓存和思考显示缓存。

后台状态请求不返回到 ST 事件等待链，发送时不新增串行 status RPC。保存响应携带账本状态；只有后台任务在运行时才继续短周期查状态。

## 5. 若棠可调用的明确接口

所有接口沿用 Nora 的用户认证与 CSRF，均为 POST：

| 路径 | 参数 | 作用 |
| --- | --- | --- |
| `/api/nora-story-ledger/status` | `worldId`, `sessionId` | 查询轮数、候选、启用范围、运行/错误状态；可恢复符合条件的后台任务 |
| `/api/nora-story-ledger/configure` | 上述身份 + `enabled: boolean` | 开关后续自动压缩，不解除旧锁 |
| `/api/nora-story-ledger/compress` | 上述身份 | 手动调度符合 15 轮规则的任务，不强制压缩不足一批的内容，不等待模型完成 |
| `/api/nora-story-ledger/edit` | 身份 + `messageId`, `text`, `bias`, `expectedSignature` | 有版本检查的原子编辑/截断；使用完整聊天的绝对消息索引 |

页面内同时提供 `NoraStoryLedger.status()`、`.configure({enabled})`、`.compress()`，作用于当前世界。

## 6. 本次兼容范围，不作扩大承诺

- 当前 Nora 主聊天使用的 Custom / OpenAI-compatible 通道（包括通过当前配置接入的 Hermes 默认模型）接入压缩与发送证明。
- TavernHelper 默认 `generate()` 使用当前完整聊天与原生 OpenAI prompt builder 时共享同一策略。
- `generateRaw()`、显式 `overrides.chat_history`、限制历史长度或另选预设走独立 builder 的调用，不擅自替换其自定义上下文。
- 非 Custom provider 维持原有原文路径，没有把未经验证的 provider 转换器宣称为已接通。
- 第三方插件自行替换整个生成协议、直接调用外部模型或删除生成来源信息，不属于该统一链路的保证范围。
- 没有进行旧账本数据迁移、Story Profile 页面改造、独立角色状态模型调用、任意历史解锁/重建功能。Story Profile 的账本投影适配已在本地实现和隔离验证，并随后经用户授权部署远端。

## 7. 验证记录

- 66 项定向 Node 测试通过：新账本规则/客户端/编辑接线、原有消息 Adapter、消息控制器、Story Core、Helper action、MVU loader、双语接口。
- 额外隔离 HTTP 测试通过：使用真实后端 router、临时 World/JSONL/设置、仅本机模拟模型，实际覆盖模型适配器 → 候选 → 最终请求校验 → 非流式/流式启用 → 上游 503 不推进 → force 保存被拒绝 → 一次性编辑截断。
- World Core 与聊天分页相关检查通过；压缩不修改聊天窗口协议或 World 生命周期。
- 插件/适配文件 ESLint、ST 接入文件语法检查、相对导入、关键启动、发布包、UI 壳契约通过。
- `npm run build:nora` 通过；保留已有的 webpack 资源体积警告，没有把该警告解释为插件功能失败或整体性能验收。

以上是最初的模拟测试记录。后续按用户授权部署本地并使用当前 DeepSeek 真实模型追加 30 轮接口验收，消耗了真实模型额度，详见独立测试报告。未操作浏览器，尚未证明真实复杂卡在 Liveware 上的完整可见交互；未部署远端。页面展开/编辑按钮的视觉状态、复杂卡的分支/MVU 交互仍需单独验收。

## 8. 真实测试发现的身份约束补充

首次真实运行发现结构化字段把 NPC 阿岚错误映射为 `__user__`，尽管同一账本的文本描述正确。现在压缩请求从 World Persona 传入玩家名字，明确 `__user__` 只指玩家本人；未登记 NPC 的物品持有人字段留空，并在文本 status/location 中保留姓名。场景同一身份重复出现会被严格校验拒绝，进入既有的同模型纠正重试。不增加 NPC roster、不写 MVU、不手工改模型摘要充当通过。此约束和单个真实样本不能保证模型在任意故事下语义百分之百准确。
