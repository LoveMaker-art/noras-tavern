# 原 Python 酒馆 → Node Tavern：实现与验收

本文保留数据迁移的历史实现证据；其中更新入口及 `/reload-mcp` 激活流程已由
[更新器实现](UPDATER-IMPLEMENTATION-20260831.md)替代，不作为当前升级操作指令。

## 授权与范围

用户确认：只处理 Python 用户进入 Node，不做 Node 不同版本的数据升级；允许补齐
Node 对独立角色、当前状态、关系、账本实体的承载和消费，然后在本地隔离验证。
最初迁移验收阶段未执行部署、GitHub 推送、真实模型调用或浏览器操作。
该阶段代码后续已按授权提交为 `f64f9c3` 并推送发布分支，未合并 main。

源代码：`aaa1afceb2e40512cdd52b91e6db4924387c2db9` 的原 Python `app/backend`。
实现位于隔离发布工作树，基于 `663af1e`，不改用户本地 main 的已有未提交工作。
`ops/tests/fixtures/create-python-fixture.py` 调用该历史版本的 normalize_card、
ensure_runtime_cast、normalize_story_state 和 story_prefix_signature 产生脱敏样例。
不是给 Node 数据换旧版本号，也不启动 Python 主服务。

## 数据和使用链路

| 原 Python 数据 | Node 目标与消费者 |
| --- | --- |
| production | 同 ID 的 World v2，一份对应一个世界；默认 Session 不增加开场消息 |
| story、alts、active_alt | 原生 JSONL 的 mes、swipes、swipe_id，原消息 ID 保留在 extra |
| cards | 可复用卡库模板，不用它覆盖当前世界已变化的角色资料 |
| runtime_cast 的角色、玩家、关系 | World.story_context；激活时注入现有 extension prompt，角色侧栏与编辑读取独立角色；切换世界清理旧上下文 |
| author_note、response_language | 同一 World 上下文消费者，不放进无人读取的附加文件 |
| 多个 worldbook_ids | Knowledge Resources、原生 world_info 与 charLore.extraBooks，所有引用验证存在 |
| story_state | 校验旧覆盖轮数/签名，再计算原生消息签名；实体 ID 保留到下一次压缩输入 |
| Profile/events/eras/actor_self | 保留原 schema-1 文件，不重新生成；角色统计读取真实 cast，World ID 不变 |
| model_configs 与旧内置模型 | 自定义 profiles + 原生 secrets；旧内置选择与新的 Hermes 主模型分别处理 |
| world-assets 与主题 | 本地背景复制为内容哈希资源；原生主题消费；原始数据另存可核对 |

迁入账本先 pending，真实 Node dispatch 接受其上下文后才 active/锁编辑。
迁入时已验证的旧账本可维持原 shared_story_memory 投影，但不伪造发送时间。
无效/过期账本不替换上下文，原始聊天完整保留并报告。

World 使用一个 ST Runtime Card 执行原生聊天，但角色身份不是这个 card：独立 cast
保存在 World 中，库模板与当前快照不同。未含 story_context 的现有 Node 世界不改
模型、不需要迁移。设计见 ADR 0011。

## 更新器收敛

已成套移除上一轮新增的 `migrate-state.mjs`、`test_state_migration.mjs`、Node v1
fixture 和 `verify_clean_release.py`；构建入口改为 Python 迁移测试。
替代入口：`prepare-state.mjs`、`python-state.mjs`、只读 `validate-state.mjs`、
`verify_python_release.py`。当前 Node 数据只校验，不转换。

保留完整目录事务：先备份/复制状态，所有源记录和目标冲突检查通过后才写副本；
切换整套 app/MCP/ops/受管技能与状态。原 Python 数据在副本内归档到 python-source，
旧可执行代码只在事务恢复树中，不在活动 app。首次转换失败不改源状态；重复执行
核对原输入及已生成文件，禁止覆盖后来新增/修改的数据。

失败回滚恢复原代码与整个项目状态、USER.md/MEMORY.md 及受管配置。原 Python
必须已停服，恢复后维持停服：它的 main 会启动后台复盘，不能擅自触发模型费用。
默认生产更新器未切到此实验路径，临时目录/标记/独立端口限制继续生效。

## 本轮验证记录

- 定向转换测试：稳定 ID、32 条消息、独立状态、空世界、备选回复、多本世界书、
  模型凭据、坏引用拒绝、幂等与新数据冲突拒绝。
- World Core 实际编辑服务验证 revision 冲突、独立角色修改、关系不误写。
- 原生激活适配器验证上下文注入及切换/关闭时清理；不是浏览器视觉验收。
- 更新器事务/技能测试 62 项通过，完整源码 lint 通过。
- 完整候选构建通过：395 项 Tavern 测试中 394 通过、1 项真实模型测试按配置跳过；
  25 项架构契约、MCP 测试、6 项 Profile 测试、11 项 Python 迁移测试通过。
- 候选包：candidate-663af1e651ee-1788150764492；源码摘要
  e6d9f7557060de8fb2791fcfda0ae32ed5c8ac4f2a133c97252d832a55b4ac71。
- 原 Python 历史源码生成样例，真实 Node 进程在临时端口 63701 读到 2 个世界、
  32 条消息、2 名独立角色和当前状态；Profile 三类内容保持一致；新 MCP 0.3.1
  只读进程正常。随后整目录回滚，原代码、完整状态、记忆、配置、AGENTS 指纹一致，
  原 Python 维持停服。零真实模型调用、未部署 Liveware。
- 故障注入发现并修正了首次启动自动回滚缺口：ST 会新建空 backups 目录，造成
  代码树指纹变化。现在从受审阅的 PUBLIC_DIRECTORIES 契约提前准备目录，然后
  记录快照；不忽略文件差异、不降低并发保护。相同演练 --fail-after-start 已通过
  原 Python 代码、状态、记忆和配置完整自动恢复。临时差异日志代码已移除。
- 最终候选包：candidate-663af1e651ee-1788151090088，源码摘要
  5a0d1a0cc8504f32eb9dccd609d3a25688958bac1b0429069027c638f888d35f。
  同一个包重新通过完整构建、正常迁移→读取→手动回滚（临时端口 65057），以及
  --fail-after-start 的启动失败→自动回滚。全部结果退出码为 0；测试临时实例已清理。
  日志位于 /tmp/nora-python-migration-check.W1EM6F；该记录对应提交之前的验收，未部署。

## 后续迁移兼容补齐（本地，尚未发布）

- Python 的主关键词、副关键词及排除词组合转换为 ST 原生正则关键词；普通
  关键词保持普通字段。无需新运行时选择器或额外模型调用。原始条目仍保留。
- `/assets/` 从受审阅旧程序的 frontend/assets（旧布局为 backend/web/assets）
  读取，与 `/world-assets/` 一起复制为 Node 背景资源，并在状态内归档原图。
  拒绝路径穿越、资源内符号链接和缺失文件；更新副本以外的源文件不变。
- 16 项迁移测试、62 项更新器测试通过；直接运行原 Python 筛选函数与 ST 原生
  正则解析器，对照 100 个常驻/副关键词/排除/大小写/字面量组合，结果一致。
- 完整候选构建通过：`candidate-f64f9c3a15dd-1788152463837`，源码摘要
  `24bbc10720f8961ddc48bd59a0e06d675a7d497618a3f5973ef271dc1c4d38a2`。
  同包通过真实 Node 临时进程迁移读取、原图片 HTTP 字节比对、手动回滚，以及
  启动后故障注入自动回滚。保留 2 个世界、32 条消息、独立角色和 Profile 内容。
  日志：`/tmp/nora-upgrade-assets-check.BTHyC7`。没有真实模型调用或远端部署。
- 上述验收时，正式整目录切换尚未获准实施。随后用户明确授权正式更新器
  改造；最新实现状态见下一节。历史候选包不包含下一节的新入口。

## 正式入口改造（本地实现；尚未发布）

用户确认维护停服、整目录替换、Python 数据转换与完整恢复后，默认命令已接入
`CleanUpdater`。测试端口仍要求临时目录标记；正式路径与演练复用同一事务。
旧 file-level 更新器仅为历史收据保留恢复兼容入口，新 apply 不走该路径。

1. 旧安装器 URL 不变。发布包同时生成安装 shell、Bootstrap Python 和摘要清单。
   Bootstrap 校验完整包后更新自身技能，固定 review 的事务与摘要；旧 `apply --plan`
   只接受该份计划。分支源码并不等于这些 GitHub Release 附件已发布。
2. 准备依赖后核验源进程的 PID、启动身份和程序路径，记录私有恢复意图再停服。
   Python 后台任务非空时拒绝更新。未知进程、端口占用、监督程序拉起均拒绝继续；
   正常进程恰好在两次检查间退出可被识别，不能把信息读取失败一概当作已退出。
3. 复制完整状态，在副本迁移 Python；当前 Node 只做验证，不做版本数据升级。
   替换 app/MCP/ops/受管技能目录，保留明确的插件目录；旧代码进入私有恢复目录，
   不留在活动程序或技能发现路径内。USER.md/MEMORY.md 与受管配置纳入恢复。
4. 原 Python 官方 AGENTS 路由按原文摘要替换，保留用户其他指令；用户修改过的
   旧路由要求人工核对。新受管块仍可使用 Tavern 标题，验收检查实际入口而非标题。
5. 新进程检查 World 快照、Profile 与新 MCP 子进程。收据
   `installed-awaiting-hermes-reload` 明确区分文件安装和真实 Hermes 激活；
   仍需 `/reload-mcp` 与新会话检查技能及 AGENTS。
6. 每个切换先记日志再重命名；失败恢复代码、数据和原运行/停服状态。
   原本停服的 Python 不会因回滚擅自启动后台模型任务；已验收版本有新对话后，
   后续回滚拒绝覆盖这些修改。

维护窗口仍是前提：本实现没有网关全局写入闸门，Python health 也不报告全部
前台请求。操作者须停止聊天及外部写入；不能声称已自动排空所有并发请求。
真实用户副本、Liveware 页面、Hermes 网关重载与依赖安全门禁分别验收。
此处只记录源码行为，最终测试结果以对应候选包的摘要和命令日志为准。

## 尚未覆盖，不得宣称无损支持所有 Python 用户

1. 原 Python 后台角色状态模型算法没有搬回；保存的最新状态进入上下文，后续剧情
   以新的对话/账本为准，MVU 仍归现有运行时。不是复刻旧后台三次模型调用。
2. Python exclusion-key 组合已按上述方式转换；概率、递归及预算采用 ST 选取
   逻辑，不保证整个随机触发过程与旧 Python 相同。
3. `/assets/` 与 `/world-assets/` 已支持；缺失背景或不支持主题值仍会阻止迁移。
   cover 仅归档并报告，当前 UI 不显示；旧卡导入已删掉的执行脚本/图像不能复原。
4. 仅覆盖所审计的 runtime_cast schema 3 与 Profile schema 1；异常记录/混合数据
   必须先解决，不删除记录绕过检查。未遍历真实 Python 用户的全部版本/数据。
5. 生产写入排空、Liveware 目标 UI 验收、真实模型续聊和所有第三方插件未验收。
   依赖安全门禁和正式发布审批独立保留；不能把候选包当成已上线正式版。
6. 当前 MCP 的 cards.fields 仍指向 Runtime Card，不是迁入的独立 cast；不要用
   修改旁白运行卡来冒充修改角色快照。当前独立角色编辑接在已有 UI/World Core
   服务上，本轮未扩展 MCP 工具 schema。

## 可复现命令

```sh
node --test ops/tests/test_python_migration.mjs
python3 -m unittest discover -s ops/tests
node ops/scripts/package-release.mjs --candidate --offline
python3 ops/tests/verify_python_release.py --release-dir <本轮候选包> --old-ref aaa1afceb2e40512cdd52b91e6db4924387c2db9
python3 ops/tests/verify_python_release.py --release-dir <本轮候选包> --old-ref aaa1afceb2e40512cdd52b91e6db4924387c2db9 --via-bootstrap --repeat-update
python3 ops/tests/verify_python_release.py --release-dir <本轮候选包> --old-ref aaa1afceb2e40512cdd52b91e6db4924387c2db9 --fail-after-start
```

最后一项会创建并清理自己的临时测试目录，启动独立端口 Node/MCP；不触碰 8799、
8809 或远端，不执行生成请求。必须同时看返回证据与剩余限制。
