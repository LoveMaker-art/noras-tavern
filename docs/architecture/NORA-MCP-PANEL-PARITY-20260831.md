# Nora MCP：右侧基础能力补齐与前端边界

## 本轮结果与证据级别

本地源码已实现并完成针对性技术验证；未部署远端，未进行浏览器视觉验收。
保留现有右侧布局和所有可见操作，不安装新插件、不改真实用户数据、不调用生成模型。
MCP 顶层工具仍为 45 个，复用现有控制协议；运行控制动作从 37 增至 48（16 读、32 写）。

“把 MVU 的时间放到标题”需要区分卡内前端标题和 Nora 顶部世界标题。
当前顶部 `panel-controller.refreshHeader` 固定取 World.name，没有响应式 MVU 绑定。
已询问具体位置，未得到确认，因此本轮没有改标题、添加主题控件或注入父页面 DOM。

## 真实发现

1. 我的角色表单调用 World Core `updateActive`，但该方法仍是抛错占位，并非一个正常工作的保存接口。
2. 常驻角色资料使用运行卡；卡库原卡是另一对象，不能把两者当作同一个编辑目标。
3. 世界背景优先取 Session metadata.scenario，再取运行卡 scenario。只改运行卡可能不影响当前背景。
4. 世界书有导入内嵌原件与实际注入提示词的运行资源之分。MCP 必须按 World 知识资源绑定查找。
5. ST 世界书保存曾未检查 HTTP 状态就更新缓存、发成功事件，可能让失败看起来像保存成功。
6. 模型配置存于 nora_ui + ST 模型设置；切换为全局效果，不是 World 私有模型。Hermes 默认项必须保留。
7. 卡内脚本、Regex 修改通道已经存在；这不是任意 Nora 外壳 UI 都已开放可配置接口的证据。

## 控件与接口映射

| 页面已有能力 | 当前入口 | 本轮处理与限制 |
| --- | --- | --- |
| 我的角色：名字、身份描述 | world.inspect / world.update | 补齐同一个 World Core 保存方法；manifest 版本检查、持久化、活动 Persona 应用；其他世界不变 |
| 常驻角色：名字、描述、性格 | cards.inspect / cards.fields | 新增 name；UI 与 MCP 共用 patchCharacter；保留复杂卡其他字段与现有 Helper 名称授权 |
| 世界背景 | scenario.inspect / scenario.update | 复用当前 Session 背景覆盖；空字符串恢复卡内背景 |
| 世界书查看、条目编辑 | worldbook.list / inspect / update-entry | 限定 World-owned 运行世界书；保留其他字段/条目；按读取版本保存 |
| 世界书条目删除 | worldbook.delete-entry | 明确单条删除，不删除整个书文件；shared/external 不隐式修改 |
| 文本模型列表、切换、删除 | models.list / select / delete | 共用模型配置服务；全局效果；禁止删除 Hermes；不删除仍被其他配置使用的密钥 |
| 文本模型新增、输入密钥 | 原页面表单 | 表单复用共用创建服务；本轮没有新增 MCP 密钥输入接口 |
| MVU 开关、模型、状态、重试 | 既有 mvu.* 与 nora.mvu_model.* | 保持现有入口；和文本模型选择是不同设置 |
| 卡库查看、导入为新世界 | 既有 st.character.* 与 nora.world.import_library | 不改导入流程；本轮未开放卡库原卡编辑／删除 |
| 找主理人复盘、故事档案 | 既有 Story Profile MCP / 页面链接 | 不改现有处理与导航 |
| 增强能力状态／重试 | 既有 mvu.retry、插件/脚本权限及 World 激活链路 | 未将页面所有能力重试按钮虚称为一条通用 MCP 动作 |
| 卡内 HTML/CSS/脚本呈现 | 既有 scripts.*、regex.* | 创建脚本默认关闭；启用和执行仍须授权；视觉效果没有自动验收 |
| Nora 外壳主题、MVU 顶部标题 | 未开放 | 待明确显示目标；不能通过改一次 World.name 假装实现动态绑定 |

## 代码路径

- World 保存：`src/nora-world-core/service.js` → `PATCH /api/nora-worlds-v2/worlds/:worldId`
  → `public/scripts/nora-worlds/world-core-client.js` → `world-core-runtime.updateActive`。
  只允许 name/persona，复用原有 WorldStore 锁、版本与原子落盘。已落盘但活动投影失败要明确报错；切世界后不能将 Persona 应用到新世界。
- 基础控制执行：`public/scripts/nora-controls/panel-actions.js`，由原运行控制器调度。
  继续使用精确 clientId/worldId/sessionId、确认、忙碌保护、幂等操作回执，没有增加第二套控制传输。
- 角色编辑：`nora-adapters/st-card-adapter.js` 的 patchCharacter；原 UI updateCharacter 调用它。
- 模型：`nora-adapters/model-profiles.js`，UI/MCP 共用选择和删除，包括默认模型与回退逻辑。
  同页面两个调用方共享互斥；列表不返回密钥、secretId、连接地址。
- 世界书：原 ST saveWorldInfo 支持可选 expectedRevision；Nora 适配器保存读取时的摘要。
  后端 `/api/worldinfo/edit` 比较摘要后同步原子写入，冲突返回 409；立即保存只在 HTTP 成功后更新缓存和发布事件。
  原 ST 客户端仍可不带版本调用，保留兼容性；未宣称所有历史插件写入都具有版本检查。
- 页面刷新：订阅原生设置更新、世界书更新；世界书更新同步 Nora 面板缓存。
- MCP/技能：已有泛型 control 工具描述更新，技能增加 Persona/背景/世界书/模型操作及未覆盖边界；不恢复旧 CLI 绕过路径。

## 验证

1. Tavern 针对性 93 项通过：panel-controls、controls、world-core、world-v2-endpoint、model-removal、story-core、runtime-adapter、world-core-client。
2. 本轮 9 个新增测试覆盖：Persona 保存重启读回、World PATCH 409、切世界投影保护、Hermes 选择与共享密钥、双调用方互斥、基础控制执行、复杂世界书字段保留、后端世界书冲突、适配器原始版本保存及失败传播。
3. MCP 集成测试通过：实际 stdio → HTTP → 控制 broker → 无 DOM 的运行客户端 → World Core 保存 → Persona 应用 → 回执与持久数据核对。
   卡物化与 ST Persona 执行为测试适配器，不代表真实浏览器可见结果。
4. Hermes 技能安装／内容测试 17 项通过。未将技能部署到若棠当前进程。
5. MCP TypeScript 构建通过；Nora Webpack 与运行资源清单／压缩生成通过。
   Webpack 仍报告 entry/lib 体积警告，本轮不将其解释为启动性能已验收。
6. 未向真实供应商发起生成或状态探测，未修改生产世界、模型或 Liveware 注册。

## 未完成事项与下一步

- 顶部 MVU 标题（如确认这个目标）：World 级显示配置绑定真实变量路径；变量变化／消息切换／世界切换时重算；缺值回退原世界名；只写 textContent，不执行模板代码、不用定时循环伪造时间。配置不覆盖原 World.name；需先确认显示位置与样式。
- 任意外壳主题、卡库原件写操作、新供应商密钥的 MCP 配置、整个世界书删除均未在本轮开放。
- World/世界书提供了本轮所述版本检查；卡字段仍沿用既有“读取修订 → 校验 → 原生合并”模式，多页面同时修改全局 ST 设置也未改造成服务端事务。不能扩大为所有并发行为已完全解决。
- 部署后仍须按目标环境验证页面刷新、我的角色保存重开、模型显示和世界书实际提示词效果。不得仅凭测试通过声称远端已完成。
