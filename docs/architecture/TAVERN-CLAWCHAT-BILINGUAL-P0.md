# 双语化 P0 执行记录

> 此文件记录缩小范围前的排查。用户随后明确只实施 Nora 固定文案和 ST 翻译接口；该实施已继续，不再等待宿主协议。当前状态见 [本地交付记录](./TAVERN-BILINGUAL-LOCAL-IMPLEMENTATION.md)。

日期：2026-08-30。对应计划：[TAVERN-CLAWCHAT-BILINGUAL-PLAN.md](./TAVERN-CLAWCHAT-BILINGUAL-PLAN.md)。

## 结论与证据等级

当前是**源码分析和候选文案盘点**，不是双语化实现、用户流程验证或部署。

- 本地 Tavern HEAD：`053646a2bf65dbc6ce234ff3788d2e4648a14c12`。
- 开始检查时业务源码工作区无未提交改动，仅计划文档未跟踪。
- 本轮没有修改应用源码、世界数据、模型配置或 Liveware 注册，没有提交或部署。
- P0 **未通过**：ClawChat 给已经打开的页面传递语言变化的实际协议仍未取得；目标客户端范围、当前远端基线也未冻结。

## 1. 已核实的接入事实

以下 `public/` 均位于 `app/engine/sillytavern/` 下；`nora-ui/` 位于 `app/native-extensions/` 下。

| 源码 | 已确认事实 | 实施要求 |
| --- | --- | --- |
| `public/scripts/i18n.js:6` | ST 优先读旧 `localStorage.language`，然后浏览器语言；模块加载时固定 | Nora 模式接到一个语言来源，不能让旧 ST 设置覆盖 ClawChat |
| `public/script.js:1046` | Nora 不执行 `initLocales()` | 拆出纯翻译初始化，不恢复旧设置 UI |
| `public/scripts/i18n.js:23` | `addLocaleData()` 只接收与当前 locale 完全相等的词典 | 保留接口；处理合法别名及按语言隔离 |
| `public/scripts/extensions.js:712` | 插件按 `manifest.i18n[currentLocale]` 精确取文件 | `en-US` 等要能回退到 `en` |
| `JS-Slash-Runner/manifest.json` | 受管酒馆助手 4.9.3 只声明 `en` 翻译文件 | 复用已有词典；不改生成/停止语义，不手改压缩构建产物 |
| `public/scripts/reasoning.js:642` | Nora 分支直接写中文思考状态与耗时 | 只改显示来源，不改实际思考正文、流式状态或折叠状态 |
| `nora-ui/model-display.js:68` | “尚未配置模型”直接写在显示模型中 | 翻译显示标签，不改变模型配置来源/选择 |
| `nora-ui/story-profile-controller.js:24` | `/actor` 链接没有独立 `lang` 参数 | 去程传当前语言；嵌在 `return` 中的参数不能替代它 |
| `../story-profile/public/i18n.js:1305` | `?lang` → `cc_lang` → 浏览器；初始化后固定 | 只能证明页面消费方式，不能证明宿主发送行为或实时更新 |

这些问题尚未修复，不能把识别到接入点写成已完成接入。

## 2. 宿主协议核实结果

已查阅可访问的本地项目、运行文档、本机 ClawChat 安装包线索及 Clawling 官方公开仓库。

- 本机安装版本为 ClawChat `1.0.14 (170)`。
- 二进制中的 `livewareUrlWithLang` 是初始 URL 语言参数的线索，不是可调用接口文档。
- Flutter 通用 locale-change 符号不能证明 Liveware 页面会收到对应事件。
- 官方 [Liveware 托管说明](https://github.com/clawling/clawchat-plugin-install-cli/blob/main/skills/shared/clawchat-liveware/SKILL.md)（本轮读取内容 version 1.2.1）介绍登录、绑定、注册和访问者身份，未提供页面语言变更事件协议。
- 官方公开源码搜索未取得 ClawChat 客户端 `docs/liveware/container.md` 或语言桥实现。检索无结果不等于证明功能不存在。
- 未操作 ClawChat 或浏览器，没有做实际切换测试。

仍需确认：初始语言字段、已经打开页面的变更通知、可信发送来源、前后台恢复行为、适用客户端版本。

在这些内容确认前，不实现猜测的 `postMessage` 事件，不用自动刷新或配置轮询冒充实时跟随。

下一步需要以下任一证据入口：

1. 可读取的 ClawChat 客户端语言桥源码或准确协议文档；或
2. 用户授权操作 ClawChat，切换一次中英文后恢复，核实 Liveware 的实际行为。测试只涉及界面与语言，不发送消息、不改世界；如果界面观察不足以确认协议，仍需要源码或文档，不能把观察结果推测成事件接口。

## 3. 第一轮 AST 盘点

方法：使用现有引擎依赖 `acorn`，以 module/latest 解析 `app/native-extensions/nora-ui/` 全部 26 个 `.js` 文件，枚举字符串字面量与模板。只读执行，无安装依赖。

总计：1,326 个字符串字面量、151 个模板；其中含中文的字符串/模板候选共 318 个。**这不是 318 条最终待翻译文案**：一个 HTML 模板可能含很多标签；候选也可能属于业务数据或诊断。英文源字符串、CSS、静态 HTML、引擎和插件尚需独立逐项登记。

| 文件 | 含中文候选数 |
| --- | ---: |
| card-action-gateway.js | 2 |
| card-capability-controller.js | 14 |
| character-controller.js | 51 |
| composer-format-controller.js | 6 |
| dialog-controller.js | 10 |
| index.js | 4 |
| message-controller.js | 20 |
| model-controller.js | 44 |
| model-display.js | 1 |
| mvu-model-adapter.js | 1 |
| panel-controller.js | 44 |
| shell-controller.js | 1 |
| smart-reply-controller.js | 2 |
| st-message-view-adapter.js | 6 |
| story-action-dispatcher.js | 5 |
| story-profile-controller.js | 2 |
| world-controller.js | 29 |
| world-creation-controller.js | 19 |
| worldbook-controller.js | 57 |

其余 7 个文件没有含中文候选，不代表没有需要翻译的英文显示：`activation-lifecycle`、`pending-message-view`、`performance-reporter`、`startup-controller`、`story-scroller`、`ui-operation-registry`、`ui-store`。

### 必须保留的分类边界

- “发送”“停止生成”“尚未配置模型”是显示词条。
- 对话格式的 `*`、`**`、引号标记是语法；只翻译菜单说明，不改语法。
- MVU 中文属性键、错误码、DOM action 标识、命令名不是显示词条。
- `buildCuratorReviewLink()` 的“整理「…」这场故事”是交给主理人的可编辑草稿，不应在普通 UI 翻译中偷偷改变模型输入；独立登记用途。
- 世界/角色名及用户存储内容，即使恰好等于系统默认中文，也不做字符串替换。

## 4. 计划对照

- 已分析：现有语言来源、ST/插件接入缺口、显示层主要位置、首轮 AST 候选数。
- 未完成：P0 宿主契约、完整逐条文案分类及触发路径、目标客户端和远端基线冻结。
- 未实施：P1–P4 业务源码改动。
- 未验证：P5 中英切换、输入保持、复杂卡/流式行为、真实 ClawChat、性能和视觉结果。
- 未部署：P6。

按计划保持前置门槛，不把候选扫描当覆盖验收，也不把浏览器语言回退当 ClawChat 跟随成功。
