# Hermes Skill 官方规范证据（2026-08-30）

## 证据范围

仅记录官方设计、作者规范与实现边界，不决定 Nora 的技能数量、模块划分或部署方式。证据等级为 **Analyzed**：已阅读官方文档和源码；本文不宣称目标环境已通过行为测试。

官网为检索当日内容；源码固定到 NousResearch/hermes-agent 提交 [`5cc1369fa298021f8c740de154ff8c37c30bdcc8`](https://github.com/NousResearch/hermes-agent/commit/5cc1369fa298021f8c740de154ff8c37c30bdcc8)。该提交不代表目标服务器安装版本，运行时结论仍须与安装版交叉核对。

## 1. Skill 的职责和加载模型

- Skill 是按需读取的知识/流程文档；`SKILL.md` 为核心，辅助脚本不是必需品。官方区分：可用说明、现有工具和 shell 调用表达的能力适合 Skill；需要精确执行的处理逻辑、完整鉴权集成、二进制/流式处理等可能属于 Tool。不能把“Skill 必须有脚本”当作官方要求。[Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#should-it-be-a-skill-or-a-tool)
- 渐进式加载为：目录/简述 → `skill_view(name)` 读取主文档 → `skill_view(name, file_path="references/…")` 按需读取具体参考文件。支持文件不会因为目录存在就全部进入上下文。主文档应明确指出何时读取哪份参考。[Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/#progressive-disclosure)
- “未使用时零 token”是指南的简化措辞：同一指南承认初始索引有 token 成本；准确说法是正文和参考内容按需支付，元数据索引仍有开销。[Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/#progressive-disclosure)

## 2. Frontmatter：格式、写入校验、作者规范不可混为一谈

| 层次 | 官方事实 |
| --- | --- |
| `skill_manage` 主文档写入校验 | YAML fence、mapping、存在 `name`/`description`、非空正文；description 通用上限 1024 字符。create 额外要求规范化后 ≤60 字符；edit/patch 不施加这项新建限制。正文写入上限 100,000 字符。 |
| 新建技能名称参数 | ≤64 字符，首字符为小写字母或数字，后续允许小写字母、数字、点、下划线、连字符。不要据此推导 frontmatter 与目录名的严格一致性已被硬校验。 |
| 正常读取 | 容错解析器可返回空 metadata，也有简单 key/value fallback；扫描器可从正文提取缺失描述，并截断过长描述。读取成功不等于通过作者规范。 |
| 作者规范/辅助 lint | `version`、`author`、`license`、`platforms`、`metadata.hermes.tags/related_skills` 属于官方仓库标准形状；不是 `_validate_frontmatter` 全部强制必填。lint 的目录名匹配、metadata、工具措辞等结果为 advisory，不能把 severity 名称误当成拒绝加载。 |

来源：[`skill_manager_tool.py` 的 `_validate_name`、`_validate_frontmatter`、`_validate_content_size`、`_attach_lint_findings`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_manager_tool.py)、[`skill_utils.py::parse_frontmatter`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/agent/skill_utils.py)、[`skills_tool.py::_find_all_skills`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skills_tool.py)、[`skill_linter.py`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_linter.py)。

## 3. 描述长度和章节规范

- 官方贡献标准要求 description ≤60 字符、一句话、句号结尾、陈述能力而非宣传词。系统提示索引的实现对超过60字符的描述保留前57字符再追加 `...`。因此 **1024 是通用写入上限，60 是索引预算及新建硬限制，句式/措辞是作者规范**；三者不应互相替代。[CONTRIBUTING：Skill authoring standards](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/CONTRIBUTING.md#skill-authoring-standards-hardline)、[`skill_utils.py::extract_skill_description`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/agent/skill_utils.py)、[`skill_manager_tool.py`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_manager_tool.py)
- 现代章节顺序为标题与范围简介，再依次 `When to Use`、`Prerequisites`、`How to Run`、`Quick Reference`、`Procedure`、`Pitfalls`、`Verification`。官方 authoring skill 又明确说明并非每节都适用：纯流程技能可以没有 Quick Reference；最低内容为 When to Use、可执行正文、Pitfalls、Verification。故七节是 house 模板，不是必须填充无意义内容的运行时 schema。[官方 in-repo authoring skill：Body Structure](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/skills/software-development/hermes-agent-skill-authoring/SKILL.md#body-structure-modern-section-order)
- 简单技能约100行、复杂技能约200行是官方作者目标，不是加载器长度上限。大型知识来源可采用精简主文档和分主题 references；复杂解析逻辑应放辅助脚本，而非要求模型每次重写。[官方 authoring skill：Size Limits](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/skills/software-development/hermes-agent-skill-authoring/SKILL.md#size-limits)、[Skills System：Large sources](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/#large-sources-become-knowledge-base-skills)

## 4. 依赖 metadata 的具体语义

- `metadata.hermes.requires_toolsets` / `requires_tools`：有任一声明项不在已知可用集合中，prompt index 隐藏技能；`fallback_for_toolsets` / `fallback_for_tools`：有任一声明项已经可用时隐藏。比较是名称集合匹配；没有工具可用性信息时实现会放行。这是索引相关性过滤，不是安装器、鉴权配置、能力赋权或服务健康检查。[Creating Skills：Conditional Skill Activation](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#conditional-skill-activation)、[`prompt_builder.py::_skill_should_show`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/agent/prompt_builder.py)
- 顶层 `platforms` 表示宿主操作系统；与 Telegram/Discord 等消息平台不是同一个维度。不填写/空列表时不限操作系统。[Creating Skills：Platform-Specific Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#platform-specific-skills)
- `required_environment_variables` 支持变量名和安全配置提示；缺值不应让技能从发现中消失。加载时进行 setup/passthrough；消息渠道不得在聊天中收集明文 secret。`prerequisites.env_vars` 是兼容旧格式；`prerequisites.commands` 的命令检查属于 advisory。[Creating Skills：Secure Setup](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#secure-setup-on-load)、[`skills_tool.py` 的 prerequisite/setup 处理](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skills_tool.py)
- `metadata.hermes.config` 供非敏感路径/偏好，解析值会注入 skill 上下文；不应将 API secret 放入这一配置。`related_skills` 是关联描述，不是依赖安装或自动递归加载指令。[Creating Skills：Config Settings](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#config-settings-configyaml)、[官方 authoring skill：related_skills rules](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/skills/software-development/hermes-agent-skill-authoring/SKILL.md#related_skills-rules)

## 5. MCP 的消费边界

- Hermes 从配置中的 `mcp_servers` 连接服务并把发现到的工具注册进现有工具体系；server/tool 过滤和是否暴露 resources/prompts 在 MCP 配置层管理。Skill 中的工具依赖 metadata 不代替此配置。[Use MCP with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes)、[`tools/mcp_tool.py`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/mcp_tool.py)
- 官方作者标准允许技能明确依赖 MCP：说明 server 名，并在 Prerequisites 交代 setup；正文引用 Hermes 原生工具或其明确预期的 MCP。脚本调用通过 `terminal` 描述，不应把 Codex 专用工具或未核实调用参数写成 Hermes 能力。[CONTRIBUTING：规则2](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/CONTRIBUTING.md#skill-authoring-standards-hardline)
- 本次固定源码记录的 MCP 工具命名形状为 `mcp__{server}__{tool}`，应以实际会话暴露的 schema/名称为准，而不是从第三方文档猜测调用名称。技能文件本身不会创建该工具。[`mcp_tool.py::is_mcp_tool_parallel_safe` 与注册逻辑](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/mcp_tool.py)

## 6. 验证与测试到底证明什么

- 新建会话中实际请求技能处理目标任务，并检查 agent 是否遵循步骤，是官方使用指南给出的行为测试；仅“文件在目录里”“`skill_view` 返回成功”不能证明工作流正确。[Working with Skills：Test It](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/#4-test-it)
- 官方仓库贡献规范要求技能自己的 `tests/skills/test_<skill>_skill.py`，使用 stdlib/pytest/mock，不调用真实网络，并隔离环境变量与临时文件。通用 skill manager 测试不是目标技能业务正确性的替代品。这是上游仓库贡献规范，不是所有用户私有技能必须复制的固定目录架构。[CONTRIBUTING：规则7](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/CONTRIBUTING.md#skill-authoring-standards-hardline)、[官方 authoring skill：Tests and Docs](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/skills/software-development/hermes-agent-skill-authoring/SKILL.md#tests-and-docs-required-for-repo-skills)
- `skill_linter` 不等同安全扫描，也不等同行为测试；作者规范 lint 为 advisory，`skill_manage` 的结构校验和安全扫描另行执行。本文仅阅读相关实现，没有运行上游测试或目标技能端到端测试。[`skill_linter.py`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_linter.py)、[`skill_manager_tool.py`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_manager_tool.py)

## 7. 已发现的文档漂移/易误读点

1. 官方 in-repo authoring skill 仍写“validator 允许1024”和“BOM 会失败”，但固定版本实现已对 create 加60字符校验并容忍前导 BOM。作者指引不应覆盖当前可执行源码事实。[authoring skill：Common Pitfalls](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/skills/software-development/hermes-agent-skill-authoring/SKILL.md#common-pitfalls)、[`_validate_frontmatter`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skill_manager_tool.py)
2. 日常使用指南用 API key 演示非敏感 `metadata.hermes.config`，但开发指南明确把 secret 放 `required_environment_variables`，且 config 值会进入上下文；不能照抄这段冲突示例。[Working with Skills：Configuring Skill Settings](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/#configuring-skill-settings)、[Creating Skills：Config Settings](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/#config-settings-configyaml)
3. 日常使用指南称 plugin skills 不进入 `skills_list`，本次固定 main 的 `skills_list` 已调用 plugin discovery 并加入 metadata；不可把最新网页的一句话外推至任意安装版本。[Working with Skills：Plugin-Provided Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/#plugin-provided-skills)、[`skills_tool.py::skills_list`](https://github.com/NousResearch/hermes-agent/blob/5cc1369fa298021f8c740de154ff8c37c30bdcc8/tools/skills_tool.py)

本文没有为任何 Codex-specific invocation 字段建立 Hermes 支持结论，也没有把上游作者规范视为 Nora 架构或部署授权。

## 8. 与目标安装版交叉核对

以下是后续在目标机器进行的核验，与上面的官方资料研究分开记录。

- `/opt/hermes/.hermes_build_sha` 为 `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`，不是本文引用的官网 main 提交。
- 安装版 `_validate_frontmatter` 同样对新建 description 施加60字符限制。三个新版主文档使用该函数、`new_skill=True` 校验通过。
- 安装版 `build_context_files_prompt` 优先查找 `.hermes.md` / `HERMES.md`；其次仅在 cwd 读取 `AGENTS.md` / `agents.md`。不能把官网较新的祖先目录/override 规则直接套到这台机器。
- Gateway 进程 cwd 为 `/opt/hermes`，但配置 `terminal.cwd: .` 经实际 `gateway/cwd_placeholder.py` 解析到 `/opt/data`。在 `/opt/data` 调用实际 context loader 能读取旧 AGENTS。进程 cwd 不能单独证明 Agent 的上下文目录。
- 远端现有 `skill_view("tavern")` 因两个 `.tavern-pre-*` 备份和正式入口同名而失败；`tavern-story-profile` 因独立入口与嵌套入口同名而失败。外部技能目录未发现额外 Tavern 同名项。

## 9. 本轮实现及验证边界

本地权威源码为 `ops/skills/`：三个主技能、七份按需参考，以及独立的 AGENTS 受管块模板。旧 `ops/SKILL.md`、三个旧参考及嵌套 Story Profile 的主文档/参考已移除；执行脚本保留。`provision.sh` 不再复制旧 Story Profile 技能。

`ops/scripts/install-hermes-skills.py` 默认只生成计划；显式 apply 必须匹配计划指纹。只替换指定指令文件、识别过的旧 Tavern AGENTS 段落和 provision 的旧复制块，保留无关内容，备份不使用可发现的 SKILL.md 文件名。旧更新器代码未改，其不兼容当前发布包的问题通过技能前置条件明确阻止误用，不宣称已完成更新器重构。

验证结果：

- `python3 -B -m unittest discover -s ops/tests -p 'test_hermes_skills.py'`：17项通过，包括无副作用预览、幂等、精确保留、指纹冲突、失败恢复、符号链接拒绝、旧入口退休与 macOS 元数据过滤。
- `sh -n ops/scripts/provision.sh` 与 `git diff --check -- ops` 通过。
- 将真实旧入口/AGENTS 的副本放入临时 HERMES_HOME，在安装版 Hermes 下执行 `verify_installed_hermes_skills.py`：三个名称唯一、七份参考全部可加载、退休入口不在索引、AGENTS 新块可读取；重复安装无变更。
- 远端实际文件仅进行只读预检；预检为30项指定文件变更。隔离验证确认活动文件未变，没有调用模型或重启服务。

授权部署前的证据等级：本地 **Implemented + Technically verified**；当时远端活动技能/AGENTS 尚未部署。随后经用户明确批准，部署结果见下一节。

## 10. 用户授权后的远端部署结果（2026-08-30）

用户确认“好 执行”后，复核原计划指纹未变，使用已验证安装器应用到 `/opt/data`：

- 计划指纹：`554146a538350048f85f35ae1bd2efa10ec3b968cbb40fd366a0aa43154ab910`。
- 30项文件变更：写入12项（三个主技能、七份参考、AGENTS、provision复制段落修正），移除18项旧入口/旧说明。保留执行脚本与其他技能，不删除角色、世界、会话和档案数据。
- 恢复备份：`/opt/data/tavern-skill-backups/migration-_1fzq9l9`；23个原有文件的备份指纹全部通过，另外七项原先不存在。备份采用 `.bak`，不再产生可发现的同名 SKILL.md。
- 部署后30项目标状态与计划完全一致；1040个非目标文件指纹未变（含维护脚本、平台/自定义技能、受检配置与身份文件）。再次生成安装计划为零变更。
- 实际安装目录调用 Hermes `skills_list` / `skill_view`：`tavern`、`tavern-ops`、`tavern-updater` 均唯一，七份参考全部可读取且与本地来源一致；六个退休名称不再被发现。`clawchat-core`、`clawchat-liveware` 仍可加载。
- 在 Gateway 已核实的逻辑 cwd `/opt/data` 调用实际 context loader：新 AGENTS 受管块可读取，旧路由和旧更新段落不再出现。
- Tavern 进程 PID 保持10760，未重启；生命周期健康检查通过，8799状态接口返回200，数据根仍为 `/opt/data/tavern-state/native/default-user`。
- `hermes mcp test nora` 退出0，连接471ms，发现45个工具。未调用模型，未修改MCP配置，未重启Hermes Gateway。

当前证据等级：技能与AGENTS **Deployed + Technically verified**。现有会话可能缓存旧系统上下文，本次未清理会话或强制重启；若棠真实新会话的自主选技能与产品操作仍未做端到端验收。旧更新器的发布格式兼容问题仍未改造，技能中的兼容性前置限制继续保留。
