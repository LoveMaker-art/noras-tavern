# Nora MVU 结构化更新协议实施说明

> 状态：核心协议已实现并通过本地技术验证，尚未部署或实机验收  
> 日期：2026-09-05  
> 实施分支：`codex/nora-mvu-structured-protocol`  
> 目标：让新 Nora 卡不再要求模型生成 `_.set(...)`，并把主模型与额外模型产生的变量更新统一为一套可校验、可回滚的结构化协议。

## 0. 本次实际实施范围

已经实现：

1. 新增版本化协议 `nora-mvu/1`、六种操作、路径数组和严格解析器。
2. 标记了 `[nora_mvu/1]` 的卡，在“随 AI 输出”时会收到统一文本输出契约。
3. 开启额外模型后，更新规则只交给变量模型；工具调用和格式化输出会使用 Nora v1 Schema，普通聊天应答走同协议的文本兼容路径。
4. 新协议、旧 `_.set` 和现有 MVU JSONPatch 都保留解析能力，并共用最终状态校验和整批回滚保护。
5. 任一命令解析、路径、类型或 Zod 校验失败时，不提交本批中的任何变量变化。
6. 空 `operations` 是成功的无变化结果，不再被误判为解析失败。
7. 已重新生成 `vendor/bundle.js`，并通过协议、兼容、原子回滚、提示词路由和构建契约测试。

尚未实现，因此不能写成已经完成：

1. 主模型的 `story + mvu` API 级联合 JSON Schema。当前“随 AI 输出”采用提示词约束、严格解析和失败回滚，以保持原正文、Regex 与状态栏链路不变。
2. 从一份变量总表自动生成 InitVar、Zod、世界书规则和显示定义的制卡生成器。
3. 自动把任意旧卡重写成 `nora-mvu/1`。旧卡继续走兼容路径，不会被静默改卡。
4. 真实供应商模型、多轮对话和目标设备上的用户结果验证。

## 1. 最终目标

用户无论开启还是关闭“MVU 变量模型”，都应得到以下结果：

1. 正文正常生成和显示。
2. MVU 更新使用同一种 Nora 标准结构。
3. 格式无效、字段越界或类型错误时，不写入任何一半数据。
4. MVU 更新失败不能破坏正文、上一轮变量或整个世界。
5. 旧卡可以继续使用，不要求用户重新制卡。
6. 新卡不再教模型输出 `_.set(...)` 或自由文本 JSONPatch。

这里的“可靠”有明确边界：

- 支持 JSON Schema 或 Tool Calling 的模型，可以在 API 层约束结构，达到最高可靠性。
- 只支持普通文本输出的模型，任何提示词都不能从技术上保证 100% 合法 JSON。Nora 可以提取、校验和重试，但不能把概率问题说成绝对保证。
- 对不具备结构化能力的模型，系统必须明确显示“兼容模式”，不能伪装成严格结构化模式。

## 2. 当前实现是什么

当前 MagVarUpdate 与 Nora 适配层同时处理两种模型文本：

### 2.1 旧式命令

```js
_.set('角色.好感度', 42, 44);
_.add('角色.好感度', 2);
```

特点：

- 模型必须正确处理函数名、括号、引号、参数数量和分号。
- 三参数 `set` 的中间旧值并不是真正的并发校验条件。
- 路径使用 Lodash 字符串，转义和数组下标容易出错。
- 适合兼容旧卡，不适合作为 Nora 的未来标准。

### 2.2 MVU JSONPatch 方言

```xml
<JSONPatch>
[
  { "op": "replace", "path": "/角色/好感度", "value": 44 }
]
</JSONPatch>
```

特点：

- 比 `_.set(...)` 更接近标准 JSON。
- 仍然依赖 XML 标签和 JSON Pointer 字符串。
- 当前 `add` 的含义容易与“数值增加”混淆。
- 自由文本模式下，模型仍可能漏标签、加代码围栏或输出非法 JSON。
- 当前默认额外模型应答格式仍可能是“聊天消息”，并不等于 API 已强制 JSON Schema。

### 2.3 当前两个触发路径

关闭额外模型，即“随 AI 输出”：

```text
主模型同时输出正文和变量命令
-> MVU 从消息文本提取命令
-> 执行并保存 stat_data
```

开启额外模型：

```text
主模型输出正文
-> 额外模型读取当前变量、规则和对话
-> 额外模型输出变量命令
-> MVU 校验后追加到消息并保存 stat_data
```

Nora 当前已经补充了超时、一次修复重试、旧快照回滚、过期聊天保护和原子提交，但模型输入协议仍由卡片和上游任务决定，没有形成唯一的 Nora 标准。

## 3. 新标准：Nora MVU Operation Envelope v1

新协议不直接沿用 `_.set`，也不直接把 RFC JSONPatch 暴露给模型。模型只需要输出一个顶层对象：

```json
{
  "protocol": "nora-mvu/1",
  "operations": [
    {
      "op": "set",
      "path": ["角色", "好感度"],
      "value": 44
    },
    {
      "op": "increment",
      "path": ["世界", "经过分钟"],
      "amount": 5
    }
  ]
}
```

### 3.1 为什么路径使用数组

使用：

```json
"path": ["角色", "背包", 0, "名称"]
```

不使用：

```json
"path": "角色.背包[0].名称"
```

也不使用：

```json
"path": "/角色/背包/0/名称"
```

路径数组的优点：

- 不需要模型处理点号、方括号或 JSON Pointer 转义。
- 字符串键和数组下标有明确类型。
- 可以逐段检查只读字段、危险键和不存在的路径。
- 中文字段、包含点号的字段和数组字段不会产生歧义。

### 3.2 标准操作集合

第一版只提供有限且语义唯一的操作：

| 操作 | 必需字段 | 含义 |
| --- | --- | --- |
| `set` | `path`, `value` | 替换一个已有字段的值 |
| `increment` | `path`, `amount` | 数值增减，`amount` 可以为负数 |
| `append` | `path`, `value` | 向数组末尾追加一项 |
| `insert` | `path`, `index`, `value` | 向数组指定位置插入一项 |
| `delete` | `path` | 删除对象字段或数组元素 |
| `move` | `from`, `path` | 把已有值移动到另一路径 |

无变化时必须返回：

```json
{
  "protocol": "nora-mvu/1",
  "operations": []
}
```

不再让 `add` 同时表达“插入”和“数值增加”。

### 3.3 JSON Schema 约束

协议使用带判别字段 `op` 的联合 Schema。示意如下：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["protocol", "operations"],
  "properties": {
    "protocol": { "const": "nora-mvu/1" },
    "operations": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["op", "path", "value"],
            "properties": {
              "op": { "const": "set" },
              "path": { "$ref": "#/$defs/path" },
              "value": {}
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["op", "path", "amount"],
            "properties": {
              "op": { "const": "increment" },
              "path": { "$ref": "#/$defs/path" },
              "amount": { "type": "number" }
            }
          }
        ]
      }
    }
  },
  "$defs": {
    "path": {
      "type": "array",
      "minItems": 1,
      "items": {
        "anyOf": [
          { "type": "string", "minLength": 1 },
          { "type": "integer", "minimum": 0 }
        ]
      }
    }
  }
}
```

正式实现需要补齐六种操作，但接口保持一个对象，不让调用方学习多个协议。

## 4. 关闭额外模型时如何工作

### 4.1 严格结构化路径

模型供应商支持 JSON Schema 时，主模型一次返回：

```json
{
  "story": "她接过发卡，跟着你走向厨房。",
  "mvu": {
    "protocol": "nora-mvu/1",
    "operations": [
      {
        "op": "set",
        "path": ["角色", "当前位置"],
        "value": "学校厨房"
      }
    ]
  }
}
```

运行时执行顺序：

```text
API 根据 Schema 返回对象
-> Nora 取出 story 作为正常助手正文
-> Nora 取出 mvu.operations
-> 在上一轮 stat_data 的副本上执行
-> Zod 与业务规则整体校验
-> 成功后同时提交正文和新快照
```

用户看到的仍然只有原卡正文和状态栏，不会看到 JSON 外壳。角色卡现有的 HTML、Regex 和状态栏视觉规则继续处理 `story` 内容。

### 4.2 Tool Calling 路径

供应商支持工具调用但不支持 response JSON Schema 时：

- 正文仍由助手消息返回。
- 模型调用唯一工具 `nora_mvu_update`。
- 工具参数就是 `Nora MVU Operation Envelope v1`。
- 工具参数校验通过后进入同一事务执行器。

### 4.3 纯文本兼容路径

供应商两者都不支持时，主模型输出：

```xml
<NoraMvu>{"protocol":"nora-mvu/1","operations":[]}</NoraMvu>
```

Nora 可以做以下容错：

- 从标签中提取第一个完整 JSON 对象。
- 去除 Markdown 代码围栏。
- 拒绝额外字段、未知操作和危险路径。
- 格式错误时保留正文和上一轮快照。

这一层只能称为“文本兼容模式”，不能宣称与 API 结构化输出同等可靠。

## 5. 开启额外模型时如何工作

开启后，主模型只负责正文；额外模型只负责协议对象：

```text
主模型生成正文
-> Nora 读取上一轮 stat_data、变量定义、更新规则和本轮剧情
-> 额外模型通过 JSON Schema 返回 Nora MVU 对象
-> 统一事务执行器校验并提交
```

能力选择顺序固定为：

1. JSON Schema structured output。
2. Tool Calling。
3. 普通 JSON 文本兼容。

额外模型不再收到“继续写剧情”的开放式任务，只收到：

- 当前状态。
- 本轮剧情事实。
- 可写路径和类型。
- 每个字段的更新条件。
- `Nora MVU Operation Envelope v1` Schema。

现有一次修复重试只用于解析或校验错误；网络错误、超时和聊天已切换不立即重复消费请求。

## 6. InitVar、Zod、世界书和新协议的关系

四者职责必须分开：

| 部分 | 唯一职责 |
| --- | --- |
| InitVar | 创建第一份 `stat_data` 初始值 |
| Zod | 校验更新后的完整状态是否合法 |
| 世界书更新规则 | 告诉模型什么时候应改变哪个字段 |
| Nora MVU 协议 | 承载模型本轮提出的具体操作 |

它们不应该分别手写四套互相可能冲突的字段定义。新 Nora 卡应由一份变量总表生成这些内容：

```js
defineNoraMvu({
  version: 1,
  fields: {
    "角色.好感度": {
      type: "integer",
      initial: 42,
      minimum: 0,
      maximum: 100,
      writable: true,
      updateRule: "只有关系事实发生变化时才调整，每轮通常不超过 5",
      display: true
    }
  }
});
```

制卡工具从这份总表生成：

- InitVar 初始对象。
- Zod Schema。
- 模型可写路径清单与更新规则。
- 状态栏读取定义。
- Nora MVU JSON Schema 中的字段限制。

这样可以消除“InitVar 有字段、Zod 没字段、世界书却要求另一个字段”的三方漂移。

## 7. 内部统一执行模块

新增一个深模块，建议接口保持为：

```ts
type ExecuteMvuUpdateInput = {
  previousState: unknown;
  envelope: NoraMvuEnvelope;
  schema?: ZodSchema;
  expectedRevision: string;
};

type ExecuteMvuUpdateResult =
  | { ok: true; nextState: unknown; changedPaths: MvuPath[] }
  | { ok: false; code: string; stage: string; details: unknown };

executeMvuUpdate(input): ExecuteMvuUpdateResult
```

模块内部完成：

1. 校验协议版本和 JSON 结构。
2. 校验操作数量和请求体大小。
3. 校验路径是否存在、是否可写、是否包含危险键。
4. 在克隆状态上按顺序执行全部操作。
5. 对最终完整状态执行 Zod 和业务不变量校验。
6. 生成变更摘要。
7. 全部成功才返回新状态。

任何一步失败都不修改真实 `stat_data`。

## 8. 与原项目逻辑的具体差异

| 项目 | 当前逻辑 | 改造后逻辑 |
| --- | --- | --- |
| Nora 新卡输出 | 卡片自行选择 `_.set` 或 JSONPatch | 只生成 `nora-mvu/1` 对象 |
| 路径 | Lodash 字符串或 JSON Pointer | 字符串/整数路径数组 |
| 操作语义 | `add` 等名称存在方言差异 | `increment`、`append` 等名称唯一 |
| 主模型关闭额外模型 | 正文中提取自由文本命令 | 优先 API Schema 的 `story + mvu` 对象 |
| 额外模型 | 上游任务和卡片方言决定输出 | 固定为 Nora MVU Schema |
| 校验 | 上游解析与 Nora Zod 事件分段处理 | 同一事务模块整体校验 |
| 写入 | 已有 Nora 补丁实现事务保护 | 保留保护，改为只接受已验证 envelope |
| 空更新 | 特判空 JSONPatch | `operations: []` 是标准成功结果 |
| 诊断 | 命令数、阶段和部分错误 | 增加协议、能力路径、操作索引和字段路径 |

## 9. 哪些属于对原 MagVarUpdate 插件的改动

这些改动必须进入：

```text
app/native-extensions/nora-mvu/upstream/nora.patch
```

具体包括：

1. 新增 Nora envelope 类型、Schema 和解析入口。
2. 新增统一事务执行器。
3. 让“随 AI 输出”和“额外模型解析”调用同一个执行器。
4. 额外模型请求按供应商能力选择 JSON Schema、Tool Calling 或文本兼容。
5. 主模型结构化响应拆分为正文和 MVU 操作。
6. 旧 `_.set` 与旧 JSONPatch 解析结果转换成 envelope 后再执行。
7. 统一错误码、空更新语义、过期请求检查和提交逻辑。

`vendor/bundle.js` 是构建产物，只能由 `build-vendor.sh` 重新生成，不能手工编辑。

## 10. 哪些属于 Nora 自己的改动

### `mvu-compatibility.js`

- 识别卡片声明的 `nora-mvu/1`。
- 旧卡继续分类为 `legacy-adaptable`、`legacy-inline` 等。
- 不把旧卡静默标成严格结构化卡。

### `mvu-world-info-policy.js`

- 额外模型开启时，把新卡更新规则只送给变量模型。
- 额外模型关闭时，把同一规则送给主模型。
- 保留旧卡现有路由，避免更新规则从两个模型都消失。

### `mvu-zod.js`

- 从逐条命令事件校验改为最终候选状态整体校验。
- 保留初始化校验。
- 提供字段路径限制和稳定错误信息。

### `runtime.js`

- 增加协议版本与供应商能力状态。
- 保存用户选择的严格模式或兼容模式。
- 不再用“开启额外模型”代替“是否支持结构化输出”这一判断。

### `update-observer.js` 与诊断 UI

- 显示本轮使用 `schema`、`tool`、`text-compat` 或 `legacy`。
- 显示失败操作索引和路径。
- 区分“模型没有要求变化”和“格式解析失败”。

### 制卡工具

- 新增变量总表定义与生成器。
- 新卡只生成 Nora MVU v1 规则。
- 不再生成 `_.set(...)` 教学提示。

## 11. 旧卡兼容策略

用户说“不再使用 `.set`”，落实为：

- Nora 新标准不再要求任何模型输出 `_.set(...)`。
- 新制卡工具不再生成 `_.set(...)` 提示。
- 已明确升级为 `nora-mvu/1` 的卡不再走旧命令输出。
- 旧卡仍可由兼容适配器读取 `_.set(...)`，否则现有角色卡会立即失效。

兼容适配器只负责输入转换：

```text
旧 _.set / _.add / _.insert
                 -> NoraMvuEnvelope
旧 MVU JSONPatch -> NoraMvuEnvelope
```

转换后全部进入同一个事务执行器。旧解析器不再直接拥有第二套写入逻辑。

这不是继续把 `_.set` 当标准，而是保留导入旧数据的读取能力。

## 12. 安全与失败处理

以下规则是硬约束：

1. 禁止写入以 `_` 开头的内部路径。
2. 禁止 `__proto__`、`prototype`、`constructor` 等污染路径。
3. 限制单轮最大操作数、路径深度和 JSON 大小。
4. `increment` 只允许数字字段。
5. `append` 和 `insert` 只允许数组字段。
6. `set` 默认只允许已有且声明为可写的路径。
7. 所有操作在副本上执行，最后一次提交。
8. Zod 校验失败时整批拒绝，不能部分成功。
9. 回复到达时若聊天、消息或基础修订已变化，拒绝过期结果。
10. MVU 失败保留正文和上一轮状态，不阻塞世界打开。

## 13. 实施顺序

### 阶段一：协议与纯函数

- 定义 TypeScript 类型和 JSON Schema。
- 实现 envelope 校验、路径校验和纯事务执行器。
- 用固定夹具覆盖所有操作和失败情况。

### 阶段二：旧格式适配

- 将现有 `_.set` 解析结果转换为 envelope。
- 将现有 JSONPatch 转换为 envelope。
- 对同一输入比较改造前后的状态结果。

### 阶段三：额外模型结构化输出

- JSON Schema 优先。
- Tool Calling 次选。
- 文本兼容兜底。
- 接入现有超时、一次修复、回滚和过期保护。

### 阶段四：主模型结构化输出

- 新 Nora 卡使用 `story + mvu` Schema。
- 运行时提取正文，不改变最终可见文本。
- 验证 Regex、状态栏和角色脚本仍处理原正文。

### 阶段五：变量总表与新卡生成

- 从一个定义生成 InitVar、Zod、更新规则和显示字段。
- 给新卡写入明确的 `nora-mvu/1` 协议声明。

### 阶段六：灰度与发布

- 默认只对声明 `nora-mvu/1` 的卡开启严格模式。
- 旧卡继续兼容路径。
- 观察失败率后再决定是否提供批量升级工具。

## 14. 必须通过的验收测试

### 协议测试

- 六种操作都能生成正确状态。
- 空 operations 是成功 no-op。
- 未知操作、额外字段、非法路径和错误类型全部拒绝。
- 任意一条失败时，整批状态不变化。

### 模式测试

- 关闭额外模型，支持 Schema 的主模型能同时返回正文和更新。
- 开启额外模型，正文模型不输出变量，变量模型只输出 envelope。
- Tool Calling 与 JSON Schema 得到相同内部结果。
- 文本兼容失败时正文仍保留，上一轮状态仍可用。

### 卡片测试

- 一张纯旧 `_.set` 卡无需修改即可继续玩。
- 一张旧 JSONPatch 卡无需修改即可继续玩。
- 一张 Nora v1 新卡在两种模式下产生相同变量结果。
- VWD 旧字段通过适配器更新 `[0]`，描述不丢失。
- InitVar、Zod、世界书和显示规则不一致时，导入阶段明确报错。

### 长对话测试

- 连续 100 轮更新不丢快照、不重复提交、不串世界。
- 切换角色、切换世界、重试、停止生成和切换 swipe 后，旧响应不能覆盖新状态。
- 模型超时、401、限流和断网不破坏已生成正文。

### 用户体感测试

- 新协议 JSON 不出现在聊天正文。
- 原卡 HTML、Regex、状态栏和视觉样式保持不变。
- “无变量变化”显示为正常，而不是失败。
- 真正失败时能看到具体阶段和字段，不再只有“MVU 未就绪”。

## 15. 明确不做的事情

- 不全局删除旧格式解析器。
- 不在导入时静默重写所有旧卡世界书。
- 不把所有模型都假定为支持 JSON Schema。
- 不把变量失败升级成整个世界或正文失败。
- 不直接编辑生成后的 `vendor/bundle.js`。
- 不在方案评审前推送、发布或部署。

## 16. 最终结论

最适合模型稳定输出的基座不是 `_.set(...)`，也不是带 XML 标签的自由文本 JSONPatch，而是：

```text
顶层对象
+ 固定协议版本
+ 有限操作枚举
+ 路径数组
+ API JSON Schema / Tool Calling 约束
+ Zod 最终状态校验
+ 原子事务提交
```

对新 Nora 卡，这套协议应成为唯一输出标准。对旧卡，`_.set` 和旧 JSONPatch 只作为兼容输入，由适配器转换后进入同一个执行模块。这样既停止继续扩散旧格式，又不让现有用户的卡突然失效。
