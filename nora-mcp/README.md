# nora-mcp 0.3

Nora Tavern 的本机 MCP 接口。复用 World Core、剧情账本和 Story Profile 后端，不另建一套世界或会话业务逻辑。不需要同时配置 st-mcp。

## 权限与能力边界

默认 `read-only` 模式注册 **30 个只读工具**；显式设置 `NORA_MCP_MODE=operator` 后注册 **46 个工具**，其中 16 个有副作用。前端运行控制动作通过统一执行工具调用，不另注册一批 MCP 工具；实际参数与授权要求以 `tools/list`、`nora.control.catalog` 为准。

| 对象 | 当前可用能力 |
| --- | --- |
| 世界 | 列表、检查、读取打开计划/快照；操作模式可创建空白世界、导入文件、从卡库创建世界、修复、删除、查询/重试操作 |
| 会话/账本 | 分页读取正文及编辑签名、纯查询账本；操作模式可启停压缩、请求压缩、按 Nora 规则编辑并删除后文 |
| Story Profile | 读取档案/复盘状态；操作模式可请求复盘、付费预览、学习、刷新 |
| MVU | 独立模型后台配置；运行态状态、变量读取、额外模型解析启停、模型来源、解析参数、重试；托管运行时持久开关（需刷新） |
| 插件/脚本 | 已安装前端扩展启停、映射配置；Helper 全局/角色/预设脚本查询、新建、编辑、删除、开关、权限与已有按钮；Helper 渲染/音频等配置；正则 CRUD 和范围授权 |
| 当前世界 | 运行卡字段/开场白、Persona、背景、拥有的世界书条目、保存的模型切换/删除、背景图/字体/颜色；发送、重生成、智能回复、停止走已有任务调度器 |
| ST 兼容层 | 只读角色卡、世界书、MVU 条目、扩展及服务端插件清单。Quick Reply 仅保留旧数据读取，当前没有可执行前端模块 |

不注册任意命令执行、源码改写、裸 JSONL/变量写入、插件安装、全量回滚、能力状态伪造或通用写资源入口。只读清单不再返回扩展原始配置里的 API 密钥。角色卡和正文属于用户私有内容，调用这些工具仍会将所请求内容交给 MCP 客户端。

confirm:true、allowModelCall:true 是调用契约，不是独立的用户授权系统。客户端必须负责征得用户同意；MCP 服务与 Tavern 应以同一受信任用户运行。此版本不是多租户隔离或不可信插件沙箱。

**运行控制需要升级后的 Tavern 页面在线**。它使用认证后端的长轮询接口，不模拟点击、不需要新的管理 UI。目标必须指定 clientId、worldId、sessionId，不自动挑选第一个窗口。未打开页面时明确返回 offline，不伪装执行成功。

原来的纯后端会话编辑仍返回 frontendApplied:false；不要在页面生成/编辑同一会话时使用这个离线编辑入口。新的运行控制通过已有任务调度器保护当前世界，不能把这一保护扩展理解为后端离线工具也有跨页面锁。

### 运行控制调用顺序

1. `nora.control.catalog` 查询真实动作、参数和授权要求。
2. `nora.control.clients` 获取在线页面及世界/会话标识，明确选择目标。
3. `nora.control.read` 查询运行状态，或 `nora.control.execute` 提交操作；传稳定 idempotencyKey。脚本相关动作另需 allowScriptExecution:true；可能调用模型的动作另需 allowModelCall:true。
4. `nora.control.operation` 查询回执。queued/running 不是成功；unknown 必须检查状态，不能换键盲目重试。completed 仍须看结果中的 runtimeApplied、reloadRequired、completionKnown。

脚本/正则编辑先查询取得 expectedRevision，再编辑；范围来源也纳入版本计算。新建脚本和正则默认关闭。脚本按钮只允许触发 Helper 当前列出的事件 ID；没有任意事件/JavaScript 执行工具。任意脚本触发后的自定义异步工作不保证已经完成，关闭脚本也不保证撤销脚本此前产生的外部副作用。

角色内容写入只允许 World 独占的运行卡；共享空白卡或旧共享卡明确拒绝，不暗中迁移。Helper 范围权限沿用原生角色名/预设名规则，正则授权沿用原生头像/预设规则；这些权限不是新建的 World 独立设置，同名或共享资源可能共用原生权限。

MVU 的 `mvu.enabled` 是额外模型解析开关，不是全部 MVU 的总开关。`mvu.runtime` 管理 Nora 托管脚本，返回需刷新；卡内自带 MVU 脚本使用 `scripts.enabled`。MVU 配置是全局设置，角色卡的覆盖配置可能改变最终效果，不报告为已证明每张卡的有效行为。

通用扩展开关返回需刷新；`page.reload` 必须单独明确调用，回执保存后才请求刷新。产品政策禁用的 assets/attachments/connection-manager/gallery/memory/token-counter 和 Nora UI 外壳不允许随意重启或关闭。当前没有已安装服务端插件，未开放其安装/热卸载。

运行命令的摘要回执保存在目标用户目录 `nora-controls/<分片>/<操作哈希>.json`，不存脚本正文、密钥、聊天内容。一次投递前先写受理状态；进程重启不会重放未确认工作。结果仅在内存保留最近64份，每份最大512k字符，超出明确标记不可用/截断；持久摘要不会自动淘汰而使旧键重新执行。管理调用会逐渐积累少量摘要文件，维护时不得盲目删除仍可能重试的操作回执。

## 独立安装

要求 Node.js 20+，且 Tavern 已运行并具备下述后端接口。

```sh
npm ci --ignore-scripts
npm run build
npm test
```

依赖版本及传递依赖已固定在 npm-shrinkwrap.json，node_modules 不再链接到 st-mcp。npm pack 只交付 dist、README、包清单和依赖锁文件，不交付用户数据、旧索引、源码测试目录或依赖目录。接收机器解包后执行 npm ci --omit=dev --ignore-scripts 安装运行依赖，再用 npm start 启动；包内不含编译器或测试源码。

## 实例配置

NORA_MCP_STATE_ROOT 必填，不再猜测开发测试目录。HTTP 与文件读取必须对应**同一台机器、同一用户实例**；所有领域工具执行前比较后端 /api/nora-worlds-v2/status 的 userDataRoot 与本地真实路径。没有身份字段或路径不匹配则拒绝操作，包括领域读取。状态、接口清单和路径说明仍可在离线时查看。

| 环境变量 | 含义/默认值 |
| --- | --- |
| NORA_MCP_MODE | read-only；需要写入时显式设为 operator |
| NORA_MCP_STATE_ROOT | 必填，目标实例状态根目录 |
| NORA_MCP_PROJECT_ROOT | 默认当前同仓根目录；安装运行包时显式指定 apps/tavern-runtime |
| NORA_MCP_ST_ROOT | 默认项目根下 app/engine/sillytavern |
| NORA_MCP_NATIVE_DATA_ROOT | 默认状态根下 native |
| NORA_MCP_USER_DATA_ROOT | 默认 native 数据根下 default-user |
| NORA_MCP_CONFIG_PATH | 默认状态根下 native-runtime/config.yaml |
| NORA_MCP_BASE_URL | 默认 http://127.0.0.1:8799；仅允许 loopback HTTP origin |
| NORA_MCP_UPLOAD_ROOT | 默认状态根下 imports；上传卡必须在此目录内 |
| NORA_MCP_SNAPSHOT_ROOT | 默认状态根下 mcp-snapshots；日常工具不开放恢复入口 |
| NORA_MCP_TIMEOUT_MS | 普通请求 30000ms |
| NORA_MCP_MODEL_TIMEOUT_MS | 同步模型操作 390000ms；调用方也需允许足够长的工具超时 |

示例路径均为占位值，部署时替换为实际实例目录：

```json
{
  "mcpServers": {
    "nora-mcp": {
      "command": "node",
      "args": ["/srv/nora-mcp/dist/server.js"],
      "env": {
        "NORA_MCP_MODE": "read-only",
        "NORA_MCP_BASE_URL": "http://127.0.0.1:8799",
        "NORA_MCP_PROJECT_ROOT": "/srv/tavern",
        "NORA_MCP_ST_ROOT": "/srv/tavern/app/engine/sillytavern",
        "NORA_MCP_STATE_ROOT": "/srv/tavern-state",
        "NORA_MCP_USER_DATA_ROOT": "/srv/tavern-state/native/default-user"
      }
    }
  }
}
```

远端接入应在远端机器上启动 MCP，以 SSH/宿主 MCP 管理器传递 stdio；不能让本机 MCP 读本机文件、同时请求远端 Liveware。该版本没有登录其他 Tavern 用户的认证配置：需要认证而未建立会话时会失败，不会绕过认证。

本次配套 Tavern 变更：

- /api/nora-worlds-v2/status 增加真实用户数据根，只在原有认证 API 层内提供。
- /api/nora-story-ledger/inspect 增加无模型调度、无状态修复、无档案投影的查询。
- 原 /status 保留 UI 使用时恢复后台压缩的语义；MCP 不调用它做只读查询。
- Story Profile reflect-preview 总进程超时与其他模型操作一致，为 360 秒。

必须先升级这些后端接口和 `/api/nora-controls`、页面执行器、托管 Helper 适配文件，才能使用 0.3 的全部操作。仅更新 MCP 不够；当前源码实现不表示已部署到远端。

## 操作契约

### 世界创建和导入

同一次用户意图使用稳定的 idempotencyKey；请求超时后不能换一个键重新导入。主动创建第二个独立世界时才使用新键。文件导入仅接收上传根内的 PNG/WebP/JSON/CHARX 常规文件，单文件上限 64 MiB，拒绝越界符号链接。

HTTP 202/操作 ACCEPTED 或 RUNNING 只代表受理。用 nora.operation.get 确认终态；World Core 完成也不等于浏览器脚本已激活。客户端不自动重试超时、传输失败或 5xx 写请求；返回 outcome:unknown，世界操作同时返回确定的 operationId。仅明确的 CSRF 拒绝会刷新令牌后重试一次。

### 账本和编辑

nora.ledger.status 不调用模型；pending 是候选压缩，active 才是已经实际进入模型请求上下文的压缩。压缩仍使用原来的 15 轮批次：第 16 轮保存有效回复后覆盖 1–15 轮，第 31 轮后覆盖 16–30 轮。失败时保留原文。

nora.session.read 返回 1–100 条消息及整个历史的 expectedSignature。messageId 是消息下标，不是轮数。编辑必须提交该签名；旧签名、已激活压缩覆盖的消息、发送中保留的压缩批次都会被后端拒绝。编辑成功删除所选消息之后的全部内容并重新计轮数。未激活候选失效时由既有账本逻辑处理，不靠 MCP 裸写文件。

压缩/复盘/预览/学习/刷新、启用账本以及可能恢复压缩的会话编辑都需要 allowModelCall:true。reflect_preview 虽不写档案，也会调用付费模型。后台请求返回不代表生成完成，需查询相应状态。同步模型请求失败或断开也不能据此认定“模型没有运行”；不要盲目重复收费操作。

### 文件恢复与旧代码

内部快照管理器改为指定文件、单份 32 MiB、最多 20 份且总计 128 MiB（payload）的备份；不再递归复制整个实例。恢复要求核对当前文件哈希，且只能在停止相关写入后维护；并不提供跨进程锁或多文件崩溃事务。它不是目前 World Core 业务写入的替代机制，日常 MCP 不开放它。

原 ST 维护实现仍保留在源码，但不注册到任何公开模式；未声明文件范围的旧全量快照调用会在写入前失败。插件安装、文件维护仍需单独设计并验收，不能仅修改工具白名单。前端控制使用上述固定动作，不开放旧的任意前端代码执行入口。

docs/upstream-st-index.* 和旧索引脚本是 ST 1.18 的历史参考，不是当前 Nora 完整代码索引；不会随运行包交付。nora.local_index 只是当前实例文件统计，也不是代码理解/架构索引。

## 验证

npm test 使用模拟 HTTP 与临时文件验证请求、权限发现、导入边界、备份和脱敏；不触碰真实用户状态或真实模型。

另有跨项目集成测试，显式指定本机 Tavern engine 路径后运行：

```sh
NORA_TAVERN_SOURCE=/absolute/path/tavern/app/engine/sillytavern npm run test:integration
```

此测试启动本机临时 HTTP 服务，真实走 stdio MCP、World Core 路由、账本编辑、控制路由、长轮询客户端、运行执行器和原任务调度器；卡资源物化及页面上下文/MVU运行对象是隔离夹具，使用两轮临时会话，不调用付费模型。它不证明任意复杂卡在真实浏览器中都能执行，也不代替远端和真实模型验收。
