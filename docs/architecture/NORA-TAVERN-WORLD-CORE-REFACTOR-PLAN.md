# Nora Tavern World Core 完整重构计划

> 文档状态：执行中；Phase 0–6 主体实现已进入本地发布基线 `0e0928e`，Phase 7 与架构收口尚未完成
> 编制日期：2026-08-28
> 代码基线：`main@7a2eaa95274e912f24c77721c514d2b0f8b4ef90`
> 实现基线：`main@0e0928e` （2026-08-29，220/220 Nora 行为测试与 24/24 仓库契约通过）
> 适用范围：仅当前 `nora-tavern/tavern` 代码库
> 索引依据：`../st-mcp/docs/nora-tavern-index.json`、`../st-mcp/docs/nora-tavern-index.md`、`docs/architecture/project-index.json`
> 状态说明：Phase 执行评审文档是当时证据快照；当前差距和必要收口以本文第 23 节为准

## 1. 计划结论

当前项目可实现用户要求的产品，但不能继续通过“在 ST 页面外层加 Nora UI、再用浏览器状态拼出 World”的方式演进。

本次重构的正确方向是：

1. 保留 SillyTavern 作为复杂卡、聊天、提示词、世界书、生成和扩展的兼容引擎。
2. 新建一个后端权威的 `NoraWorldCore`，让 World 成为真实持久化业务对象，而不是角色卡与聊天文件的临时组合。
3. 将导入、创建、删除、修复做成可重试、可观察、可恢复的 World 命令；打开使用幂等 Activation Plan 和可重试的浏览器激活。
4. 将 MVU、Tavern Helper、Regex 等扩展能力从“World 是否存在”的前置条件，降为 World 的异步能力状态。
5. Nora UI 只消费 Nora 的 World 读模型和命令，不再自行协调 ST 全局变量、角色、聊天和注册表。

这不是重写 SillyTavern，也不是更换技术栈。它是一次围绕 World 语义重新分配所有权的架构重构：Nora 管业务真相，ST 管兼容执行。

## 2. 用户目标与可验收结果

### 2.1 产品目标

项目必须同时满足两个核心目标：

- 合理复用 ST 的成熟能力，能够导入并运行 V2/V3 PNG、JSON、CHARX、内嵌世界书、Regex、Tavern Helper 脚本、MVU 等复杂卡。
- 建立 Nora 自己的 World 核心模型，使产品从数据、交互、错误和生命周期上都具有独立语义，而不是一眼可见的 ST 包装层。

### 2.2 用户可见验收标准

重构完成后必须能证明：

1. 导入一张受支持的复杂卡只生成一个 World；网络重试、双击和刷新不会重复创建。
2. 用户明确选择“用同一张卡再创建一个 World”时，可以生成新的 World，不被来源 SHA 错误拦截。
3. World 创建后立即出现在列表；刷新、重启和重新注册 Liveware 后仍然存在。
4. World 列表不会因为角色数组尚未加载、最近聊天未返回或扩展未初始化而暂时消失。
5. 首条消息为空的卡不会表现为“导入成功但进入后一片空白”；UI 会明确显示可开始对话的空场景状态。
6. MVU 或其他扩展初始化失败时，基础 World 仍可打开；UI 明确显示“能力降级”及可重试入口。
7. 删除 World 不会误删被其他 World 共用的角色卡或世界书。
8. 用户看到的是 World、人物、设定、剧情和能力状态，不暴露 `character_avatar`、`chat_id` 等 ST 内部身份。
9. 冷启动到基础 World 可操作的目标为 P95 不超过 10 秒；常规打开目标为 P95 不超过 5 秒。
10. 导入点击后 1 秒内必须出现持续进度或明确状态，不允许长时间无反馈阻塞。

### 2.3 兼容性承诺边界

“兼容 ST 扩展”不能等同于承诺所有第三方扩展无条件可用。兼容性分三类管理：

| 扩展类型 | 目标 | 处理方式 |
| --- | --- | --- |
| 数据/事件型 | 默认支持 | 通过稳定事件与数据适配器接入 |
| 依赖 ST 全局上下文 | 重点适配 | 由浏览器兼容适配器提供受控上下文 |
| 强依赖 ST 原生 DOM | 逐项认证 | 建立兼容矩阵；必要时提供单扩展适配器，不宣称默认兼容 |

## 3. 范围锁定

### 3.1 本计划包含

- Nora World 领域模型、后端核心、持久化和索引。
- 角色卡导入到 World 创建的完整链路。
- World 打开、恢复、删除、修复和状态查询。
- ST 后端资源适配和浏览器运行时适配。
- 复杂卡能力探测与异步加载。
- Nora UI 的 World 数据源和交互流程切换。
- 启动和 World 打开关键路径性能。
- 现有 World 数据的一次性审计、迁移和冲突报告。
- 自动化测试、兼容夹具、远端灰度和回滚方案。

### 3.2 本计划不包含

- 不重写 SillyTavern 的聊天、提示词、模型请求或世界书引擎。
- 不移除 ST 内核，也不 fork 每一个第三方扩展。
- 不重构同级 `story-profile` 仓库。
- 不修改 `app/story_profile_runtime` 的业务逻辑；它仅作为已交付运行时保留。
- 不进行视觉风格重设计；仅调整为新 World 状态所必需的交互。
- 不在本计划阶段部署远端、迁移用户数据或执行实际业务重构。

## 4. 索引与代码证据

### 4.1 本次 MCP 索引覆盖

新索引只扫描当前 Tavern 仓库，排除了同级项目、运行时数据、依赖目录、发布副本和 Git 元数据。

| 指标 | 当前值 |
| --- | ---: |
| 重构分析前的基线索引文件 | 997 |
| 写入本计划后的最终索引文件 | 998 |
| 源文件 | 400 |
| 源模块 | 400 |
| 依赖边 | 2,654 |
| 后端路由 | 223 |
| Nora 路由 | 22 |
| 测试文件 | 74 |
| 索引行数 | 243,696 |
| 权威源码未解析相对导入 | 0 |

代码分区表明，ST 兼容引擎仍占绝大部分代码；Nora 自有后端、浏览器运行时和 UI 的体积并不大。真正的风险是所有权和调用方向，而不是简单的仓库字节数。

索引先于本计划生成，满足“先基于完整代码建索引、再写重构计划”的顺序；文档完成后又执行了一次最终刷新，因此最终文件数多出本计划本身。

### 4.2 当前链路的客观事实

#### World 身份不是真正权威对象

- `src/nora-world-registry.js` 使用 `character_avatar + chat_id` 作为绑定键。
- 注册表 `list()` 每次同步扫描并解析全部 World JSON。
- 浏览器 `world-runtime.js` 会把注册表、最近聊天和临时 World 再合并一次。
- 当角色数组中暂时找不到 avatar，或最近聊天中暂时找不到 chat，注册表记录可能不进入 UI 读模型。
- ADR 0001 将聊天元数据中的 `nora_world.id` 定义为权威身份，但聊天本身仍由 ST 文件和浏览器上下文控制。

结果是：World 是否“存在”和是否“显示”依赖多个异步投影同时正确，而不是依赖一个权威 World 状态。

#### 导入存在两套未统一的实现

- 原生 CLI 使用 `nora-import-registry.js`，只记录 `staged -> imported`，并未完成整个 World 生命周期。
- Web UI 的 `world-creation-controller.js` 不使用该导入日志，而是在浏览器中导入角色、刷新全量角色、检查重复，再调用 `worldRuntime.create()`。
- 浏览器的 busy 状态只能防止当前标签页重复点击，不能抵抗刷新、断线和请求重试。

结果是：同一操作可能被执行两次；同一来源卡因生成了不同聊天绑定，可以产生两个注册表 World。

#### 创建和打开由浏览器承担了后端事务

当前 `worldRuntime.create()` 同时负责：

1. 读取 ST 全局状态。
2. 展开角色卡并识别能力。
3. 创建 World ID 和聊天 ID。
4. 创建或复用世界书。
5. 在浏览器中选择角色和聊天。
6. 保存聊天元数据与 persona。
7. 等待 MVU/扩展初始化。
8. 最后写入 World 注册表。

失败补偿只覆盖部分聊天和浏览器上下文，无法完整回收已导入卡、已建世界书、注册表和扩展副作用。

结果是：浏览器刷新或任一步超时都可能留下半完成资源；后续代码只能不断增加补偿和 reconcile 补丁。

#### 扩展能力被放进基础 World 的关键路径

- `st-card-adapter.js` 检测 Regex、脚本、世界书和 MVU。
- 当前打开流程会等待 MVU；嵌入式 MVU 默认轮询约 5 秒，未就绪则抛错。
- UI World 控制器和启动控制器又会分别预热或提示能力，形成重复或串行等待。

结果是：MVU 没初始化被等同于“世界打不开”，即使角色、聊天和基础消息功能已经可用。

#### 空首条消息被静默接受

ST 的 `getChatResult()` 只在 `getFirstMessage().mes` 非空时插入首条消息；首条和候选开场白都为空时，只保存聊天头。

结果是：系统技术上创建了聊天，但用户看到空白页面，并误以为 World 丢失或创建失败。

### 4.3 已观察到的运行时症状

以下为此前远端运行证据，必须进入回归用例：

- 一张卡导入后产生两个 World，其中一个报错。
- 新卡导入成功但没有可见消息，聊天文件只有 header。
- World 打开被 `MVU variable runtime did not initialize in time` 阻断。
- 隐藏超时错误后，用户仍无法判断 MVU 是否真实加载成功。
- 创建后不显示、右侧人物/世界书丢失、World 无法打开等问题呈现非确定性。

## 5. 根因结论

当前问题不是单一代码漏洞，也不是单纯后端过重，而是四个架构问题叠加：

1. **业务真相分裂**：聊天元数据、World JSON、角色文件、世界书和浏览器状态都承担了部分真相。
2. **事务边界错误**：持久化创建由浏览器流程组织，刷新和超时会切断事务。
3. **身份概念混淆**：World ID、卡来源 SHA、avatar、chat ID 和一次导入操作没有严格区分。
4. **基础可用与增强能力耦合**：MVU/脚本 readiness 决定 World 是否能打开。

因此，继续修改等待时间、隐藏错误、追加 reconcile 或在 UI 层查重，只能降低某个症状出现概率，不能消除数据竞争和半完成状态。

## 6. 目标领域模型

### 6.1 核心概念

| 概念 | 定义 | 是否权威 |
| --- | --- | --- |
| World | Nora 的持久故事容器，拥有稳定 ID、默认会话、资源引用和能力状态 | 是 |
| Story Session | World 内的一段持久对话，映射到 ST chat，但不以 chat 文件名作为产品身份 | 是 |
| Runtime Card Resource | 执行当前故事所需的 ST 角色卡资源 | Nora 记录引用，内容由 ST 存储 |
| Knowledge Resource | 世界书或其他设定资源，具有稳定资源 ID 和 ST engine name | Nora 记录引用，内容由 ST 存储 |
| Capability Set | 卡声明和实际可用的 Regex、脚本、MVU 等能力及错误 | 是 |
| Import Operation | 一次可重试的用户导入命令，具有幂等键和阶段状态 | 是 |
| Activation Plan | 后端根据 World 权威状态生成的浏览器执行计划 | 短期权威指令 |
| ST Binding | avatar、chat filename、worldbook name 等兼容引擎定位信息 | 否，仅适配字段 |

### 6.2 身份规则

- `worldId`：稳定 UUID；重命名卡、聊天或 World 不改变它。
- `sessionId`：稳定 UUID；ST chat filename 只是当前绑定。
- `resourceId`：Nora 资源 ID；avatar 或世界书名字只是引擎定位字段。
- `sourceSha256`：识别导入字节，不代表 World 身份。
- `idempotencyKey`：识别一次用户操作的重试。

同一个 `idempotencyKey` 重试必须返回同一个 World。同一来源卡如果用户明确选择“再创建一个”，必须使用新的 `idempotencyKey`，从而合法生成另一个 World。

### 6.3 状态模型

为避免把每个扩展组合编码成 World 状态，基础生命周期与能力状态分离：

```text
World lifecycle:
CREATING -> READY -> DELETING -> DELETED
    |          |
    +------> FAILED

Capability status:
PENDING -> READY
    |         |
    +----> DEGRADED
```

语义：

- `CREATING`：后端正在解析卡、创建资源或初始会话。
- `READY`：World、默认会话和基础 ST 绑定完整，可以进入和聊天。
- `FAILED`：基础创建失败；必须包含失败阶段、错误码和可重试信息。
- `PENDING`：World 可用，浏览器增强能力尚未完成。
- `DEGRADED`：World 可用，但一个或多个增强能力失败。
- `DELETED`：逻辑删除完成；共享资源是否回收由资源所有权决定。

## 7. 目标架构

### 7.1 总体结构

```text
Nora UI
  -> Nora World API / Read Model
      -> NoraWorldCore
          -> World Store + In-memory Index
          -> Operation Journal + Keyed Lock
          -> Import / Open / Delete Services
          -> Resource Catalog
          -> ST Backend Compatibility Adapter
              -> ST card parser/import
              -> ST chat serialization/storage
              -> ST worldbook storage

Nora UI
  -> Browser Activation Adapter
      -> receives Activation Plan from NoraWorldCore
      -> selects ST runtime card/session
      -> loads Regex/Tavern Helper/MVU
      -> reports READY or DEGRADED to NoraWorldCore
```

调用方向必须单向：Nora 业务层可以调用兼容适配器；Nora 领域模型不能直接依赖 ST DOM、jQuery、全局变量或文件名语义。

### 7.2 深模块边界：`NoraWorldCore`

`NoraWorldCore` 应隐藏存储布局、ST 绑定、幂等、锁、补偿和迁移细节，对外只暴露少量高价值接口：

```js
createWorld(command, { idempotencyKey })
getWorld(worldId)
listWorlds(query)
prepareOpen(worldId)
reportActivation(worldId, report)
deleteWorld(worldId, { idempotencyKey })
retryOperation(operationId)
inspectWorld(worldId)
```

禁止把 `readRegistryFile()`、`selectCharacter()`、`ensureWorldbookByName()` 等低层动作暴露给 UI。

### 7.3 后端与浏览器职责

#### 后端负责

- World、Session、Resource 和 Operation 的身份。
- 导入幂等、并发锁、阶段记录和失败恢复。
- 调用 ST 服务端解析/导入角色卡。
- 世界书物化和冲突安全命名。
- 创建符合 ST 格式的初始聊天文件。
- World manifest 的原子提交和内存索引。
- 生成 Activation Plan。
- 接收浏览器能力加载结果并持久化。

#### 浏览器负责

- 执行既有 Activation Plan，不自行创建业务身份。
- 调用 ST 浏览器上下文选择角色和聊天。
- 加载依赖浏览器的 Regex、Tavern Helper、MVU 等能力。
- 对基础激活进行短时、可验证的检查。
- 将每项能力的成功、失败和耗时报告给后端。

浏览器不得再负责生成 World ID、决定导入幂等或合并多个 World 数据源。

## 8. 持久化设计

### 8.1 第一阶段不引入 SQLite

当前是单 Node 进程，Liveware 交付还需要控制原生依赖。第一阶段使用：

- 每 World 一个 schema v2 manifest JSON。
- 启动时一次性建立内存索引。
- 写入时原子临时文件替换。
- 按 `worldId`、`idempotencyKey` 和资源键加 keyed mutex。
- 独立的持久 Operation Journal。

这样可以消除当前每次 `list()` 都同步扫描目录的问题，又避免立刻引入数据库迁移和 native module 风险。

只有在真实数据量和性能剖析证明 JSON + 索引不足时，才单独通过 ADR 决定 SQLite；不得在本轮重构中无证据更换存储技术。

### 8.2 World manifest v2

建议结构：

```json
{
  "schema_version": 2,
  "world_id": "uuid",
  "revision": 1,
  "name": "World display name",
  "persona": { "name": "", "description": "" },
  "lifecycle": { "status": "READY", "error": null },
  "source": {
    "type": "character-card",
    "sha256": "...",
    "original_name": "...",
    "import_operation_id": "..."
  },
  "runtime_card": {
    "resource_id": "uuid",
    "engine": "sillytavern",
    "avatar": "internal.png"
  },
  "sessions": {
    "default_session_id": "uuid",
    "items": [{ "session_id": "uuid", "engine_chat_id": "..." }]
  },
  "knowledge": [
    { "resource_id": "uuid", "engine_name": "...", "ownership": "owned" }
  ],
  "capabilities": {
    "declared": ["regex", "mvu"],
    "status": "PENDING",
    "items": {}
  },
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

Manifest 只引用 ST 内容，不复制角色卡、聊天和世界书正文。

### 8.3 资源所有权

- `owned`：由该 World 导入并仅由该 World 使用，可在删除后回收。
- `shared`：被多个 World 引用，删除单个 World 不得删除资源。
- `external`：用户原本已有的 ST 资源，Nora 永不自动删除。

资源目录维护引用计数或引用集合。所有物理删除必须在后端再次检查引用，不信任 UI 传入的 ownership。

## 9. World 创建与导入事务

### 9.1 标准流水线

```text
接收命令
 -> 获取 idempotency lock
 -> 创建/恢复 Import Operation
 -> 暂存上传并计算 SHA
 -> 调用 ST parser 解析并标准化
 -> 生成兼容性预检报告
 -> 分配 World/Session/Resource ID
 -> 导入或复用 Runtime Card Resource
 -> 物化内嵌世界书并记录稳定映射
 -> 创建初始 ST chat
 -> 写入 chat metadata 的 Nora 投影
 -> 原子提交 World manifest READY
 -> 返回 World read model + Activation Plan
 -> 浏览器异步加载增强能力并回报
```

### 9.2 事务与补偿

每一步都写入 Operation Journal：

```text
RECEIVED
PARSED
CARD_MATERIALIZED
KNOWLEDGE_MATERIALIZED
SESSION_CREATED
WORLD_COMMITTED
CAPABILITIES_PENDING
COMPLETED
```

失败时不依赖一个长 try/catch 猜测清理：

- 未提交 manifest 的 owned 临时资源由补偿器清理。
- 已提交 `READY` 的 World 不因浏览器扩展失败回滚。
- 进程崩溃后由 journal 判断继续执行还是补偿。
- 同一幂等键再次请求时读取 journal，不重复导入。

### 9.3 空首条消息策略

卡的 `first_mes` 和 alternate greetings 均为空时：

- 后端仍创建合法默认 Session。
- Session 标记 `opening_state: empty`。
- Nora UI 显示“故事尚未开始，发送第一条消息”空状态。
- 该状态是正常结果，不伪装成有消息，也不显示加载失败。

### 9.4 兼容性预检

导入前报告：

- 卡格式与 schema 版本。
- 首条消息/候选开场白情况。
- 内嵌世界书和条目数。
- Regex 数量与作用域。
- 脚本类型及其依赖。
- MVU 模式与依赖。
- 已知不兼容或 DOM 耦合扩展。

预检不应无故阻塞导入。只有卡格式损坏、必要资源不可解析等基础错误才拒绝；增强能力问题进入 `DEGRADED` 风险提示。

## 10. World 打开链路

### 10.1 基础打开

1. UI 请求 `prepareOpen(worldId)`。
2. 后端验证 manifest、默认 Session 和资源引用。
3. 后端返回带版本和短期 token 的 Activation Plan。
4. 浏览器适配器按计划选择 Runtime Card 与 chat。
5. 适配器验证当前 ST 上下文与 plan 一致。
6. UI 进入基础可操作状态。
7. Regex/MVU/脚本在独立能力任务中继续初始化。

### 10.2 不再允许的行为

- 打开 World 时临时 claim 一个新的 World ID。
- World 不在注册表时从 recent chats 自动伪造临时 World。
- MVU 未就绪直接抛出“世界打开失败”。
- UI 根据角色数组是否已加载决定 World 是否存在。
- 多个控制器重复执行 worldbook prime 和 capability wait。

### 10.3 能力加载反馈

每项能力单独报告：

```json
{
  "capability": "mvu",
  "status": "READY | DEGRADED",
  "duration_ms": 3200,
  "error_code": null,
  "diagnostics": {}
}
```

UI 只显示 Nora 语义，例如“变量系统未加载，可重试”，不显示原始 `globalThis.Mvu` 或轮询异常。

## 11. API 设计

建议在 `/api/nora/worlds/v2` 下建立版本化接口，旧接口仅用于迁移期：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/imports` | 创建或恢复幂等导入操作 |
| `GET` | `/operations/:operationId` | 查询持久进度与错误 |
| `GET` | `/` | 返回权威 World 读模型列表 |
| `GET` | `/:worldId` | 返回单个 World 详情 |
| `GET` | `/:worldId/open-plan` | 获取只读、可重复请求的 Activation Plan |
| `POST` | `/:worldId/activation-report` | 回报基础激活和能力状态 |
| `POST` | `/:worldId/repair` | 执行经过验证的修复动作 |
| `DELETE` | `/:worldId` | 幂等删除 World |

所有命令返回 Nora 错误码、`operationId` 和可重试性，不直接返回 ST 异常字符串。

## 12. ST 兼容引擎边界

### 12.1 服务端适配器

复用现有 ST 能力，但统一封装：

- `parseCard(upload)`
- `materializeCard(normalizedCard)`
- `materializeWorldbook(book, desiredBinding)`
- `createChat(session, openingPolicy)`
- `inspectResources(binding)`
- `deleteOwnedResource(binding)`

聊天创建必须复用 ST 的 canonical serialization 和保存逻辑，不能在 Nora 中另造不兼容 JSONL 格式。

### 12.2 浏览器适配器

- `activate(plan)`
- `verifyActiveContext(plan)`
- `loadCapability(plan, capability)`
- `generate(messageCommand)`
- `editMessage(command)`
- `swipe(command)`

只有适配器允许访问 ST globals、事件总线和 DOM。Nora UI 控制器不得直接调用 `selectCharacterById` 等接口。

### 12.3 上游升级原则

- 尽量不改 ST 核心文件；首选 Nora adapter、extension 或正式 hook。
- 必须修改上游文件时，每个改动单独记录 patch 目的、上游基线和回归测试。
- 建立 `UPSTREAM.md` 或 patch manifest，升级时自动检查漂移。
- 兼容适配层的接口由 Nora 测试锁定，ST 内部实现可以随上游升级替换。

## 13. Nora UI 重构边界

### 13.1 保留

- 当前 Nora 的 World 列表、聊天、人物、世界书和模型配置入口。
- 现有 Nora 视觉语言和用户已经确认的交互方向。
- ST 消息生成、编辑、重生成、swipe 等底层能力。

### 13.2 替换

- `world-creation-controller` 改为只发导入命令、订阅 operation 进度和导航结果。
- `world-controller` 改为只读取权威 World 列表并执行 open plan。
- `ui-store` 的 World 数据源改为后端 read model，不再合并 recent chats。
- capability controller 成为唯一增强能力编排者。
- startup controller 只负责 shell、bootstrap、基础 World 打开；不重复等待扩展。

### 13.3 新增用户状态

- 正在解析卡。
- 正在创建 World。
- World 已创建，正在加载增强能力。
- World 可用，部分能力降级。
- 导入失败，可重试。
- World 需要修复。
- 无开场白，等待用户开始故事。

刷新后这些状态必须从后端 operation/manifest 恢复，不能依赖内存 toast。

## 14. 性能计划

### 14.1 性能预算

| 路径 | 目标 |
| --- | --- |
| Nora shell 可见 | P95 <= 2 秒 |
| 冷启动到基础 World 可操作 | P95 <= 10 秒 |
| 常规打开到基础 World 可操作 | P95 <= 5 秒 |
| World 列表后端查询 | P95 <= 100 毫秒 |
| `prepareOpen`（不含浏览器 ST 激活） | P95 <= 200 毫秒 |
| 导入开始到首次进度反馈 | <= 1 秒 |

这些是重构验收目标，不是对当前代码的既有承诺。

### 14.2 关键优化

- World Store 启动时建索引，增量更新；请求期不扫描所有 JSON。
- 导入多个文件时不在每张卡后刷新全量角色库。
- card/worldbook 解析和 SHA 计算在服务端一次完成并缓存 operation 结果。
- 基础 World 打开不等待 MVU、Regex UI 或非必要面板。
- 只加载当前 World 的 Runtime Card、Session 和资源。
- Liveware World 激活将 Activation Plan、Runtime Card、bounded Session 和 Worldbook 合并为一次带 ETag 的 Snapshot 传输；Snapshot 只替代远程读取，ST 原生聊天渲染与事件生命周期仍是唯一状态 owner。
- worldbook prime、capability detect、capability wait 各自只有一个 owner。
- 对导航连接/HTML、shell、bootstrap、Snapshot 网络/解析、后端 plan/revision/card/chat/worldbook、ST 状态安装、DOM render、生命周期事件、first paint 和 capability ready 分段记录性能。

### 14.3 不采用的伪优化

- 仅缩短 timeout 或吞掉异常。
- 通过缓存掩盖错误 World 身份。
- 为减少启动时间直接删除 ST 兼容代码。
- 在没有 bundle profile 的情况下盲目拆分全部 135 个启动模块。
- 用更快轮询替代 readiness 事件或明确状态。

## 15. 分阶段执行计划

每一阶段都必须达到退出条件后再进入下一阶段；不允许同时维护两套无限期运行的 World 真相。

### Phase 0：基线、术语与回归夹具

目标：把产品语义和当前故障固化成可执行证据。

工作：

- 更新 `CONTEXT.md`，明确 World manifest 是权威，chat metadata 是兼容投影。
- 新增 ADR：World 权威存储、基础状态与能力状态分离、JSON+内存索引选择。
- 将“空首条消息”“同一卡双击导入”“MVU 超时”“丢失角色/聊天绑定”做成夹具。
- 记录远端冷/热启动、导入和打开的分段基线。
- 建立扩展兼容矩阵初版。

退出条件：

- 当前已知四类故障均有失败测试或可重复诊断脚本。
- 术语不存在 World/卡/chat/import operation 混用。
- 性能测量可以区分 Liveware 下载、进程启动、页面启动、World 打开和能力加载。

### Phase 1：实现 `NoraWorldCore` 和权威 Store

目标：建立不依赖浏览器的 World 真相。

建议新增：

```text
app/engine/sillytavern/src/nora-world-core/
  domain.js
  errors.js
  store.js
  index.js
  locks.js
  operation-journal.js
  resource-catalog.js
  read-model.js
  service.js
```

工作：

- 定义 schema v2 和严格校验。
- 启动时加载 manifest 并建立 world/binding/source/operation 索引。
- 实现原子写、revision 乐观并发和 keyed mutex。
- 实现 operation journal 与崩溃恢复。
- 提供核心小接口，不接 UI。

退出条件：

- 并发创建、重复请求、进程中断和损坏 manifest 测试通过。
- `listWorlds()` 不执行目录全扫描。
- Store 不导入任何浏览器文件或 ST DOM 代码。

### Phase 2：ST 服务端资源适配与预检

目标：把导入、世界书和初始 chat 的持久动作收回后端。

工作：

- 封装现有 character parser/import endpoint 的内部服务能力。
- 封装 chat canonical serialization/save。
- 为世界书建立 `resourceId -> engineName` 映射和冲突安全命名。
- 实现复杂卡 capability preflight。
- 实现资源所有权和补偿动作。

退出条件：

- 不打开浏览器即可把测试卡物化成 Runtime Card、Worldbook 和合法初始 Session。
- 空开场白产生明确 `opening_state: empty`。
- 同名世界书不会错误复用不相关内容。
- 补偿不会删除 external/shared 资源。

### Phase 3：打通单一垂直链路

状态（2026-08-29）：本地实现并完成技术验证；feature flag 默认关闭，尚未远端灰度或完成目标环境用户验收。实现与逐项证据见 `PHASE-3-EXECUTION-REVIEW.md`。

目标：在 feature flag 下完成“导入一张卡 -> 一个 World -> 基础打开”。

工作：

- 新增 v2 import、operation、list、open-plan API。
- Web UI 改为发一个幂等命令并轮询/订阅 operation。
- 浏览器只执行 Activation Plan。
- 打开成功后验证 world/session/card 三者一致。
- 旧路径仍可读取，但新路径只写 v2。

退出条件：

- 双击、刷新、断网重试均只产生一个 World。
- 显式“再创建”可以产生第二个 World。
- 刷新后 World 立即由 v2 list 返回，不依赖 recent chats。
- 基础打开不等待 MVU。

### Phase 4：复杂卡能力异步化

状态（2026-08-29）：本地实现并完成技术验证；World Core v2 feature flag 仍默认关闭，尚未远端灰度、真实浏览器扩展验收或用户验收。实现与逐项证据见 `PHASE-4-EXECUTION-REVIEW.md`。

目标：在不牺牲复杂卡能力的前提下消除扩展阻塞。

工作：

- capability controller 成为唯一加载 owner。
- 为 Regex、Tavern Helper/JS Slash Runner、MVU 分别实现 readiness contract。
- 每项能力写回状态、耗时和错误码。
- 建立 DOM 耦合扩展兼容矩阵与适配策略。
- 用户可以重试单项能力，不重新创建或重新打开 World。

退出条件：

- MVU 超时只能使 `capabilities.status=DEGRADED`，不能使 World 打不开。
- 能明确证明 MVU 已加载或未加载，不再通过隐藏错误推断成功。
- 标准测试卡的 Regex、脚本、世界书和 MVU 行为有端到端断言。

### Phase 5：UI 和启动链路切换

状态（2026-08-29）：本地实现、构建并完成技术验证；World Core v2 feature flag 仍默认关闭，未进行远端部署、真实浏览器视觉验收或目标环境性能验收。实现、退出条件和剩余性能瓶颈见 `PHASE-5-EXECUTION-REVIEW.md`。

目标：Nora UI 完全使用自己的产品语义。

工作：

- 删除 World 列表的 registry + recent chats + provisional merge。
- 统一 startup/open/capability owner。
- 加入持久进度、降级、修复和空场景 UI。
- DOM 交互只携带 `worldId`，ST 绑定保存在 adapter 内。
- 延迟加载非当前 World、非关键面板和非必要扩展。

退出条件：

- UI 不因 characters/chats 请求顺序不同而丢 World。
- 刷新时不会闪现 ST 原始 thinking、编辑控件或错误状态。
- 冷/热启动达到性能预算，或有明确、可测的剩余单点瓶颈。

### Phase 6：迁移、对账与旧路径下线

状态（2026-08-29）：本地实现并完成技术验证；迁移工具保持显式 `--apply` + 备份门禁，未对远端运行时数据执行迁移，World Core v2 feature flag 仍默认关闭。实现、对账语义和剩余远端验收见 `PHASE-6-EXECUTION-REVIEW.md`。

目标：完成单一真相切换，清除补丁式旧架构。

工作：

- 一次性扫描旧 World registry 和 chat metadata，生成迁移报告。
- 分类：正常、重复绑定、同来源多 World、孤儿卡、孤儿 chat、缺失世界书、空 chat、损坏记录。
- 正常数据生成 v2 manifest；冲突数据标记 `needs_repair`，禁止静默删除。
- 临时双读对比 v1/v2；所有新写入只进入 v2。
- 验证期后删除 provisional World、claim-on-open、旧 import registry 和浏览器 create 事务。

退出条件：

- v1 与 v2 对账报告无未解释差异。
- 运行路径中只有一个 World 写 owner。
- 搜索代码不再存在 UI 生成 World ID 或按 recent chats 伪造 World。

### Phase 7：远端灰度、性能与上游升级保障

历史状态（2026-08-29 Phase 7 preflight）：Phase 7 代码已部署至测试远端并保留旧 runtime 回滚目录；完整 runtime/state 备份、隔离真实数据副本迁移、复杂卡导入、修复、删除、重启与幂等回归已通过。当时真实 v2 数据尚未迁移，`nora.worldCoreV2.enabled` 仍为 `false`，用户可见验收尚未完成。详见 `PHASE-7-PREFLIGHT-REVIEW.md`。

当前代码状态（2026-08-29 重新审计）：默认配置已将 `nora.worldCoreV2.enabled` 设为 `true`，但这只证明源码切换，不能替代目标远端数据、真实浏览器、复杂卡矩阵和 P50/P95 验收。

性能收口状态（2026-08-30）：聚合 World Snapshot 与精细化 Trace 已实现、完成 252 项 Nora 测试和 25 项架构契约并部署到测试远端。三个真实复杂 World 的远端本机 Snapshot 后端读取为 10.8–27.7ms，Brotli 传输体为 203–427KB，ETag 304 为 1.0–1.6ms；这证明 Node 聚合与重验证工作正常，不证明 Liveware 浏览器 P50/P95。部署后的真实浏览器 cold/warm 样本仍是本 Phase 的退出门槛。

目标：证明用户结果，而不仅是测试通过。

工作：

- 在测试远端备份 runtime 数据后灰度启用 feature flag。
- 使用真实复杂卡执行冷启动、重复导入、刷新、删除、重启和能力失败测试。
- 采集 P50/P95 和每阶段耗时。
- 运行 ST 上游兼容回归和 patch drift 检查。
- 保留 v1 只读回滚窗口，禁止双写回滚。

退出条件：

- 用户可见验收标准全部在目标环境演示。
- 无新增孤儿资源、重复 World 或不可解释的降级状态。
- 回滚演练可以恢复旧读路径且不破坏 v2 数据。

## 16. 现有文件处置表

| 当前文件/模块 | 计划处置 |
| --- | --- |
| `src/nora-world-registry.js` | 由 v2 Store 取代；迁移期只读，最终删除 |
| `src/nora-import-registry.js` | 由通用 Operation Journal 取代 |
| `src/endpoints/nora-worlds.js` | 保留 v1 迁移接口；新增 v2 router 后下线 |
| `src/endpoints/nora-imports.js` | 改为 v2 import command 或下线 |
| `public/scripts/nora-worlds/world-runtime.js` | 拆成 API client、activation adapter；删除业务创建与多源 list merge |
| `world-registry-client.js` | 替换为 versioned World API client |
| `st-card-adapter.js` | 保留浏览器能力识别；服务端持久动作迁出 |
| `st-world-adapter.js` | 保留受控 activation；禁止创建身份 |
| `world-creation-controller.js` | 改为 operation UI，不直接操作 ST 资源 |
| `world-controller.js` | 改为 v2 read model + open plan |
| `startup-controller.js` | 仅负责 shell/bootstrap/base open |
| `card-capability-controller.js` | 成为唯一能力加载 owner |
| `ops/scripts/native_tavern.py` | 改用同一 v2 import API，不再走独立 journal |
| `CONTEXT.md` | 更新为 v2 权威 World 语言 |
| ADR 0001 | 由新 ADR supersede：chat metadata 降为兼容投影 |
| ADR 0002-0006 | 保留，按新模块边界补充，不推翻单 Node 与兼容层方向 |

## 17. 测试策略

### 17.1 领域和存储测试

- World/Session/Resource ID 稳定性。
- manifest schema、revision 和原子写。
- 同幂等键并发与进程恢复。
- 显式同来源多 World。
- owned/shared/external 删除规则。
- 损坏、孤儿和缺失资源诊断。

### 17.2 契约测试

- NoraWorldCore 不依赖浏览器模块。
- ST backend adapter 输入输出固定。
- Activation Plan 与 browser adapter 的版本协商。
- capability report 错误码和状态转换。
- ST 上游升级后 card/chat/worldbook 契约不漂移。

### 17.3 复杂卡矩阵

至少覆盖：

- V2 PNG、V3 PNG、JSON、CHARX。
- 有/无 first message，有 alternate greetings。
- 无世界书、单世界书、多条目内嵌世界书、重名世界书。
- Regex only、Tavern Helper script、MVU managed、MVU embedded、组合能力。
- 大卡、重复卡、损坏卡、扩展缺失卡。

### 17.4 端到端用例

1. 导入 -> 进度 -> World 出现 -> 打开 -> 发消息。
2. 导入中刷新 -> 恢复进度 -> 同一个 World。
3. 同卡双击 -> 一个 operation/World。
4. 同卡显式再创建 -> 两个独立 World。
5. 空开场白 -> 正确空场景。
6. MVU 失败 -> World 可用且明确降级 -> 单项重试成功。
7. 重启服务 -> World 与状态一致。
8. 删除共享资源 World -> 另一 World 正常。

### 17.5 性能测试

- 分离 Liveware 包下载、解压、Node 启动、首屏、bootstrap、base open 和 capability ready。
- 每项同时记录 cold/warm；禁止只用命中缓存的数据证明冷启动。
- 导入性能测试必须覆盖端到端，不再只测重复角色查找函数。
- 远端数据规模至少包含多 World、多卡和大型世界书。

## 18. 可观测性与错误模型

每个命令记录：

- `requestId`、`operationId`、`worldId`。
- 当前阶段与阶段耗时。
- 是否命中幂等结果。
- 创建/复用的资源 ID。
- activation plan 版本。
- 每项 capability 结果。
- 可安全展示的 Nora 错误码和内部 cause。

建议错误码：

- `NORA_CARD_INVALID`
- `NORA_WORLD_CREATE_FAILED`
- `NORA_WORLD_RESOURCE_MISSING`
- `NORA_WORLD_BINDING_MISMATCH`
- `NORA_WORLD_NEEDS_REPAIR`
- `NORA_CAPABILITY_DEGRADED`
- `NORA_OPERATION_CONFLICT`

UI 不直接展示 Node stack、ST 内部函数名或英文轮询错误。

## 19. 迁移与回滚原则

### 19.1 迁移

- 迁移前必须备份当前 runtime World、chat、character、worldbook 数据。
- 先扫描、再生成报告、再转换；不边扫描边删除。
- 冲突条目只标记，不自动合并两个故事。
- v2 manifest 提交后保留来源和旧 binding，便于审计。

### 19.2 回滚

- feature flag 控制 UI 使用 v1 只读列表或 v2 列表。
- 新写入只进入 v2，避免双写产生两份不同真相。
- 回滚只切换读取和激活入口，不删除 v2 数据。
- 数据格式升级必须可从备份恢复；部署包回滚与用户数据回滚分开。

## 20. 风险与控制

| 风险 | 控制 |
| --- | --- |
| ST 浏览器上下文是部分扩展的硬依赖 | 保留 browser activation adapter，不错误地把全部逻辑搬到后端 |
| 重构影响现有可用流程 | feature flag + 垂直切片 + v1 只读回退 |
| 资源补偿误删共享数据 | 资源所有权、引用检查、默认不删 external |
| 同卡多 World 被错误当成重复 | operation 幂等与 source SHA 分离 |
| JSON store 随规模变慢 | 启动内存索引、增量维护、性能门槛；达到门槛后再评估 SQLite |
| DOM 耦合扩展破坏 Nora UI | 兼容矩阵、逐项 adapter、明确不支持边界 |
| ST 上游升级冲掉补丁 | patch manifest、契约测试、最小上游改动 |
| 为追求速度隐藏能力失败 | 基础可用与 capability degraded 分离并持久显示 |

## 21. 完成定义

只有同时满足以下条件，才可以称为“重构完成”：

- World manifest v2 是唯一写入真相。
- 导入、删除和修复是后端持久化可重试命令；打开是幂等 `prepareOpen` 与可取消、可重试的浏览器激活。
- 浏览器不再创建 World 身份或拼接 World 列表。
- Nora UI 只消费具名业务域与 World Interface，不再通过 `story.runtime` 临时桥获得整个 ST Runtime。
- 复杂卡兼容矩阵中的目标卡均通过端到端测试。
- MVU/扩展失败不阻断基础 World，并且状态真实可见。
- 旧 claim/provisional/import patch 路径已经删除，而不是永久共存。
- 性能预算在真实远端冷/热场景达到。
- 用户亲自在目标环境验证导入、刷新、打开、聊天和重启结果。
- 发布源必须对应唯一 Git commit/tag，工作树干净，构建产物与源码一致，部署记录不使用“远端当前文件”作为版本身份。

## 22. 建议的第一批实施任务

本计划获确认后，第一批只执行 Phase 0 和 Phase 1，不立即改 UI 或部署：

1. 更新领域语言并提交三份 ADR。
2. 把四个已知生产故障固化为测试。
3. 建立 `nora-world-core` 的 schema、Store、内存索引、锁和 operation journal。
4. 用适配器假实现完成 World create/list/retry 的纯后端测试。
5. 做一次设计审查，确认 manifest、幂等语义和资源所有权后，再进入 ST 资源适配。

这样第一批工作会建立真正可复用的核心，而不是继续修改现有浏览器补丁链路。

## 23. 当前代码重新审计与收口补充计划

### 23.1 补充计划的目标

本节不重启一轮全面重构，也不以“消灭所有 ST 代码”为目标。它只处理当前代码证据中依然会影响发布可追溯性、业务真相单一性、用户可见稳定性或上游升级安全的差距。

可验收结果：

1. 任何测试或部署版本都能反查到唯一 commit/tag，工作树干净，构建与源码一致。
2. Nora UI 通过具名业务域 Interface 使用故事运行能力，不再获得一个包含全部 ST 能力的临时 Runtime 桥。
3. World Core v2 是在线唯一 World 路径；legacy 只读回退按明确门槛退出，迁移能力作为离线工具保留。
4. 复杂卡和性能结论来自真实端到端证据，不用单元测试、DOM 节点或缓存命中替代用户结果。
5. 必须修改 ST 上游文件时，改动有基线、目的和回归契约，不再依赖记忆识别 Nora patch。

### 23.2 重新审计结论

| 问题 | 当前代码证据 | 判断 | 是否需要收口 |
| --- | --- | --- | --- |
| 发布源不可追溯 | 重构前 `main` 停留在 `7a2eaa9`，126 个路径的重构未提交 | 会导致本地、远端与回滚版本无法精确对齐 | 是；已用 `0e0928e` 固化第一个本地基线 |
| `story.runtime` 临时桥 | `nora-story-core` 已定义 state/messages/cards/worldbook/model/settings/transport 业务域，但 `nora-runtime` 仍把原始 Runtime 作为 `actions` 与 UI mount 参数 | 现有深 Module 的 Interface 没有真正成为调用面，依赖知识继续泄漏给所有 controller | 是 |
| ST 消息 DOM | ST selector 集中在 `st-message-view-adapter.js`，其他消息 controller 通过 Adapter Interface 使用 | 这是为 rich message/复杂卡保留的合理兼容 Seam，不是应被重写的架构失败 | 仅补契约和视觉回归，不替换实现 |
| `activeCharacterId` 等 ST 身份 | World v2 交互已只携带 `worldId`；人物编辑仍使用 ST character index | World 业务身份已隔离；人物编辑是 ST 兼容能力，当前没有证据支持再建一套人物持久化模型 | 不新建人物领域；只限制该身份用于 cards 兼容操作，禁止参与 World 身份或列表组装 |
| legacy 路径 | v2 默认开启，旧端点和浏览器 runtime 严格只读 | 它已不是双写真相，但长期在线共存会扩大运行面和回归面 | 是，但只能在真实 v2 验收和回滚窗口后下线 |
| World 打开未进入 Operation Journal | 打开是只读 `prepareOpen` + 浏览器 ST activation，不创建后端资源 | 为了形式统一而持久化每次打开是不必要的复杂度 | 不新建 Open Operation；先保证幂等、取消、重试和分段可观测 |
| 前端框架和手写 DOM | Nora UI 已按 workflow controller 拆分，但仍是轻量手写 DOM | 存在维护成本，但当前没有证据证明更换框架能解决 World 稳定性或兼容性问题 | 否 |
| 模型配置仍复用 ST 设置/密钥 | Model Adapter 已隔离后端凭据，并有自定义模型、Hermes 回退和删除契约 | 目前是合理复用；不存在需要独立 Model Store 才能解决的已知故障 | 否 |
| JSON Store | 内存索引、原子写和 revision 已完成 | 目前无数据规模证据支持更换 SQLite | 否；仅性能超阈值后立 ADR |

### 23.3 Workstream A：发布与证据收口

状态：本地基线已完成；部署身份尚未与目标远端核对。

工作：

- 以 `0e0928e` 保存重构实现基线，本补充计划单独提交。
- 为可部署候选创建 annotated tag，记录 build/test 结果。
- 发布前要求 `git status --porcelain` 为空；从该 tag 生成产物，不从临时远端目录反向拼版。
- 部署时记录 tag/commit、远端实例、数据迁移状态和回滚目录。

退出条件：

- 本地工作树干净，本地 tag 指向通过验证的 commit。
- 后续远端验收时能通过健康信息或静态版本指纹证明运行代码身份。

### 23.4 Workstream B：关闭临时 Story Runtime 桥

状态：本地实现与技术验证已完成；尚未部署或进行目标环境用户结果验收。执行证据见 `WORKSTREAM-B-EXECUTION-REVIEW.md`。

目标：让已经存在的具名业务域成为真正的 UI Interface，不新建第二套实现。

工作：

1. `nora-runtime` 将 `story` 具名域交给 UI，不再将 `story.runtime` 同时作为 `actions` 和 mount 参数。
2. controller 按用途消费 `state`、`messages`、`cards`、`worldbook`、`model`、`settings`、`transport` 域；不增加一层纯转发 Module。
3. `ui-store` 只从 state 域获得快照，World controller 仍只消费 World Interface。
4. 所有调用点迁移后删除 `Temporary flat bridge`、`NoraRuntime.actions` 与相应兼容测试。

退出条件：

- 产品代码搜索不再存在 `story.runtime`。
- UI mount 的 Interface 不包含 ST Runtime 对象。
- 每个 controller 只获得它实际使用的业务域 Interface，不新增纯转发包装。
- 现有生成、编辑、重生成、人物、世界书、模型和 Story Profile checkpoint 行为测试不变。

### 23.5 Workstream C：legacy 在线路径退场

状态（2026-08-29）：已实现、技术验证并在目标远端启用。服务只挂载 `/api/nora-worlds-v2`，旧 `/api/nora-worlds` 返回 404，浏览器生产图不再包含 legacy reader，离线迁移能力保留。目标环境当前 4 个 World 均为 READY，完整证据见 `WORKSTREAM-C-EXECUTION-REVIEW.md`。这不代表五条浏览器产品流程已经验收。

目标：保留必要的数据迁移能力，但不长期在产品运行时组装 v1/v2 两套 World reader。

前置门槛：

- 目标远端 v2 数据对账无未解释差异。
- 一个明确发布窗口内完成导入、刷新、打开、删除、修复和重启验收。
- 已演练从持久数据备份恢复，不再需要依赖在线 v1 reader 回滚。

工作：

- 从启动组装中删除 `/api/nora-worlds` 旧端点和 `legacy-world-reader-client.js`。
- `createNoraStoryCore` 只组装 World Core v2，不再根据 feature flag 选择两套 reader。
- 保留 `legacy-migration.js` 和显式 CLI 作为离线导入/审计工具；它不在正常请求链路中执行。
- 删除 v1 专用运行时契约，保留迁移夹具。

退出条件：

- 服务启动时只挂载 v2 World 路由。
- 浏览器生产图中不包含 legacy World reader。
- 旧数据仍可在隔离副本中通过明确 CLI 扫描和迁移。

### 23.6 Workstream D：真实兼容与性能验收

状态（2026-08-29）：后端兼容矩阵、后端查询预算、目标环境能力 evidence、5 次进程冷启动和 10 次生产热资源路径已完成技术验证并部署。实测确认每次启动现场 Webpack 是固定约 7.7 秒的主瓶颈，修正为发布阶段预构建后，进程冷启动 P95 从 10,131ms 降为 1,103ms。目标浏览器内的发送/刷新持久化、可见 UI 稳定性和完整页面导航 P50/P95 仍未验收；在这些用户结果门槛完成前，不进入 Workstream C。完整证据见 `WORKSTREAM-D-EXECUTION-REVIEW.md`。

本 Workstream 先取证，后决定是否修改实现。

兼容最小矩阵：

- V2 PNG、V3 PNG、JSON 和 CHARX 各一个可分发或脱敏夹具。
- 空 first message、alternate greetings、内嵌 Worldbook、同名不同内容 Worldbook。
- Regex only、Tavern Helper、Managed MVU、Embedded MVU 和组合能力。
- 重复导入、显式再创建、刷新、Node 重启、删除共享资源 World。

每个声明支持的项目必须观察：

- 只生成预期数量的 World。
- 基础 World 可打开、发送和持久消息。
- 刷新和重启后 World、Session、人物和 Worldbook 投影一致。
- 能力项分别显示 READY/DEGRADED 和可重试结果。
- 不暴露原生 ST 错误、思考/编辑控件竞态或重复布局。

性能取证：

- 五次真正 Liveware cold run，十次 warm navigation；每次记录交付、进程、shell、bootstrap、base open 和 capability ready。
- 报告 P50/P95，不使用一次 3 秒结果代表冷启动。
- 只当指标超过第 14.1 节预算时才进入性能实现修改。
- 若超标，先使用现有 milestone 确认唯一主要所有者；当前 505,807-byte Brotli inline manifest 和兼容模块评估链只是候选瓶颈，不是未经测量的结论。

退出条件：

- 兼容矩阵的每一个 Certified 声明都有对应证据。
- 冷/热 P95 达到预算，或者用户明确接受经测量的剩余瓶颈。

### 23.7 Workstream E：ST 上游改动治理

目标：将 Nora 对 ST 的必要改动变成可审计的小表面，而不是为了形式上的“纯净”搬运整个引擎。

工作：

- 建立 Engine patch manifest，只记录 Nora 直接修改的 ST 上游文件、修改目的、上游基线和覆盖契约。
- 将 Nora 新增 Module、Adapter、测试和构建输出与“直接 ST patch”分开统计。
- 升级 ST 时先跑 patch drift 和 Nora 契约，再跑复杂卡验收；不用手工搜索替代 manifest。

退出条件：

- 开发者能在一份 manifest 中区分 ST 原文件、Nora 新文件和 Nora 直接 patch。
- 任一上游 patch 漂移都会在构建或契约阶段明确失败。

### 23.8 明确不做的工作

以下工作当前没有足够证据表明其能提高用户结果，不纳入本轮收口：

- 重写或移除 SillyTavern 引擎。
- 为了隐藏 ST 血统而改名上游包、拆散 vendor 目录或复制上游实现。
- 更换 Nora UI 前端框架或全面组件化。
- 取消 `st-message-view-adapter` 并自建一套 rich message 渲染器。
- 为人物、模型或 Worldbook 重建一套与 ST 并行的持久化后端。
- 在没有数据量和 profile 证据前将 JSON Store 替换为 SQLite。
- 为了缩短数字而吞掉错误、缩短 MVU timeout 或隐藏 DEGRADED 状态。

### 23.9 执行顺序与停止条件

1. 先完成 Workstream A，固定可追溯基线。
2. 再完成 Workstream B，关闭已有业务域之上的临时 Runtime 桥。
3. 执行 Workstream D 的真实验收；它同时是 Workstream C 的退场门槛和性能修改的证据门槛。
4. 只在真实验收通过后执行 Workstream C，下线在线 legacy reader。
5. Workstream E 在下一次 ST 升级前完成；它不阻断当前功能验收，但阻断无 manifest 的上游升级。

任一 Workstream 出现以下情况时必须停止扩大范围：

- 需要新建与 ST 并行的持久化系统。
- 需要替换前端框架或重写消息渲染。
- 需要改变已确认的用户交互、兼容承诺或数据所有权。
- 只能用“代码更先进”而不是故障、指标或维护成本证据证明收益。

### 23.10 Workstream F：产品可靠性与 Liveware 阻塞收口

状态（2026-08-29）：五条流程的可执行技术门禁已建立，远端日志确认的重复 World 列表、首次生成的无关 UI 等待、扩展并发激活、无界轮询、隐藏 Persona token 计数和角色卡库全量展开已收口。运行提交 `f38d6d3` 已部署到目标测试远端并通过非浏览器健康验证；用户结果与 cold/warm 浏览器 P95 仍待验收。详见 `WORKSTREAM-F-EXECUTION-REVIEW.md`。

目标：不扩展产品功能，将用户实际使用的五条流程变成发布门禁，并找出 ST 兼容内核在 Liveware 远端环境中不合理的阻塞边界。

五条可观测流程：

1. 打开 Nora 后恢复上次 World，主体消息与输入框可用。
2. 导入一张复杂卡，1 秒内有可见进度，最终只创建一个预期 World，失败可重试。
3. 发送、编辑并发送、重生成、智能回复均有反馈，不被 token 计算或重复备份串行卡死。
4. 角色卡库可看到已收藏卡，显式“创建新 World”产生新身份，重复提交不意外复制。
5. 刷新和 Node 重启后，World、Session、人物、Worldbook 和消息持久化一致。

Liveware 审计范围：

- 启动、World 打开和消息发送关键路径上的远程请求、全量扫描、串行 `await`、轮询和 timeout。
- 必须阻塞基础世界的必要条件，与 MVU/Regex/Tavern Helper 等可延后能力的边界。
- 连续编辑/重生成中的聊天主文件持久化、恢复快照和 token 计算归属。
- 冷启动、热打开和五条流程的 P50/P95，不以一次快速结果代替分布。

当前已收口的证据点：

- 长上下文 OpenAI token 缓存通过一次 batch API 预热，不再对每条消息串行远程计数。
- 编辑并重生成使用一个聊天备份事务；中间 ST save 仍写主文件，但不重复生成恢复快照。
- 启动 bootstrap 不再扫描 recent chats 或重建旧 World，初始 World 只由 v2 controller 选择。
- 首次生成只等待 token cache 和 Regex 基线；locales、系统模板、头像库和 ST Persona 管理不再进入 Nora 启动或后台 hydration，所需运行语义由无 UI Interface 提供。
- 扩展激活以 extension name 共享同一个 in-flight task，Regex / Tavern Helper / MVU 按实际能力各自请求。
- World 激活事件只更新本地投影，不再重复请求权威列表。
- 导入/修复等持久操作使用 150ms→1s 退避轮询和 120s 单次等待上限；超时保留 pending operation 可恢复性。
- 角色卡库直接使用浅元数据分页，只在用户打开某张卡的详情时展开该卡。

退出条件：

- 五条流程在目标环境中都有可重复证据，无严重堵塞、重复 World 或无反馈操作。
- 冷启动 P95 达到 10 秒内，热打开 P95 达到 5 秒内，或用户明确接受有证据的剩余瓶颈。
- 任何保留的 ST 阻塞点都有业务必要性和时间预算；可延后能力不阻断基础 World。
