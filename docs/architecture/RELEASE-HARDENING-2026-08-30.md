# Tavern 发布收口执行记录

## 范围与验收

基线：main@9f0ba72634e1fbbd93bb915d4a9c61cd25b50ab5。目标是每用户/Agent 独立实例的可靠交付，不是共享多租户 SaaS。
保留现有 UI、World v2、ST 兼容执行及 Story Profile 生成逻辑。只修复有证据的缺陷，退出旧接口前检查实际调用和兼容契约。
本轮不部署、不推送、不调用付费模型，不修改真实用户数据；真实浏览器与目标 Liveware 环境验收需要授权后另行执行。

正式发布必须同时满足：干净隔离安装、安全且可追溯的发布包、核心五流程验收、重启/更新数据保留、明确的复杂卡支持范围。技术测试通过不能代替用户结果验收。

## 当前结论

本轮已经修改源码并完成多项技术复验，不再是仅生成审计文档。原审计报告保留为修改前证据，不代表修复后的测试状态。

**当前仍是本地发布候选，不是正式稳定版。** 安全依赖剩余项、目标环境五流程与复杂卡矩阵、最终提交/发布身份还没有全部收口。本轮没有以“测试全绿”替代这些条件。

最新追加实施见文末“后续代码收敛”。下文旧候选包是上一轮证据，不包含这次新增的接口清理和重绘修复，不能直接拿它部署本次源码。

## 审查清单

| 范围 | 审查路径 | 状态 |
| --- | --- | --- |
| 交付与隐私 | 打包输入、构建来源、产物/数据分离、依赖、生命周期 | 候选包隔离构建通过；安全残留待收口 |
| 启动与缓存 | core/UI/World readiness、tokenizer、静态资源与 Snapshot | 确认缺陷已修复，规模性能尚未定量验收 |
| World 生命周期 | 导入幂等、并发存储、资源引用、删除/修复、操作恢复 | 存储提交、修复/删除、文件暂存竞态已修复 |
| 网络与取消 | HTTP body/headers deadline、后台 operation ID、切换释放 | 请求 deadline 已覆盖 headers/body，保留操作 ID |
| 聊天与兼容 | dispatcher、编辑/重生成/智能回复、Helper/MVU、思考流 | 技术回归已补；真实复杂卡矩阵未执行 |
| 档案适配 | 宿主 CSRF、子进程退出、快照来源 | CSRF、总时限、输出上限、信号退出已修复 |
| 冗余与架构 | 调用图、动态调用补充、有效适配与失效接口区分 | 两个无产品调用入口退出；有兼容用途者保留 |
| 验收门禁 | 当前测试/契约、真实流程、报告与版本绑定 | 技术门禁通过；正式发布严格门禁仍阻断 |

## 证据与执行纪律

- MCP 主索引已全量刷新；结合实际文件和运行时夹具，不把图无入边等同于无调用。
- 2026-08-30 再次运行原 `local-state/architecture-audit-20260830/reproduce-*.mjs`：readiness、tokenizer、WorldStore、transport、CSRF 均为 FAIL，正向对照通过。
- 既有审计报告保留为修改前基线，不覆盖成“全部修复”。
- 每项修复先增加失败测试，再修改负责模块，再复验；未证实的风险不当作已发生故障。
- 不承诺静态索引能穷尽第三方脚本和所有逻辑漏洞。

## 已实现及直接验证的改动

下表的测试均在 `app/engine/sillytavern/tests/`，不是用户真实数据。关键缺陷先复现失败，再改实现复验。

| 项目 | 实际行为变化 | 源码责任位置 | 回归证据 |
| --- | --- | --- | --- |
| 空工作区 readiness | UI 初始化完成独立发 `nora:runtime-ready`；不依赖世界已打开，不伪发 `usable` | `public/script.js`；`nora-ui/startup-controller.js` | `nora-startup-readiness.test.mjs` |
| 全局 Store 一致性 | 磁盘提交、资源目录、操作唯一性校验在同一短提交锁内；保留逐世界锁 | `src/nora-world-core/store.js` | `nora-world-store.test.mjs`：并发共享引用/同操作键竞争 |
| World 身份 | 更新不能把已有 World 的 ID 改成另一个 ID | 同上 | 同上 |
| 删除/修复互斥 | 同 World 的不同持久 mutation 不能交错，让修复把已删世界重新置 READY | `src/nora-world-core/service.js` | `nora-world-core.test.mjs`：延迟 inspect 后并发 delete |
| 导入不可覆盖 | 同一操作键的暂存文件原子发布，已存在时比较内容；不同上传不能互相覆盖 | `src/nora-world-core/st-import-staging.js` | `nora-staging-concurrency.test.mjs` |
| 请求超时 | 普通请求默认 30 秒，覆盖头与响应体；操作轮询遵守剩余 deadline 并保留恢复 ID | `public/scripts/nora-worlds/world-core-client.js` | `nora-world-core-client.test.mjs` |
| 分词器冷路径 | 合并同 tokenizer 的并发初始化；失败可重试；SentencePiece 加载成功前不发布实例；下载总时限 20 秒 | `src/endpoints/tokenizers.js` | `nora-tokenizer-initialization.test.mjs` |
| 消息展示分层 | 仅 ST message adapter 识别原生 DOM；pending view 接收投影 | `nora-ui/st-message-view-adapter.js`、`pending-message-view.js` | UI 模块契约及 native reasoning 回归 |
| 思考展开与时钟 | 用户可先展开 pending 空框等原生流；Nora 新生成计时不含之前的历史/分词准备 | `public/scripts/reasoning.js`、`public/script.js` | `nora-native-reasoning-stream.test.mjs`，包含真实原生点击处理器 |
| 档案宿主请求 | 原 actor UI 保持，mutation 从宿主拿 CSRF token 再发送，不替换全局 fetch | `public/nora-profile-request.js`、构建同步器 | `nora-profile-host-request.test.mjs` |
| 档案子进程 | 三次模型调用命令总时限 360 秒，其余 30 秒；stdout 16 MiB/stderr 256 KiB；信号退出不是成功；终止升级到 SIGKILL | `src/endpoints/nora-story-profile.js` | `nora-profile-process.test.mjs` |
| 发布隔离 | 不再 tar 活动 app；从确定源码导出，独立安装/测试/构建，显式文件列表与禁止项检查 | `ops/scripts/release-source.mjs`、`package-release.mjs` | `nora-release-source.test.mjs`；实际隔离候选构建 |
| 固定档案快照 | 普通 build 只验证嵌入文件校验和；显式 sync 才读取兄弟仓库并记录来源 revision/hash | `build/sync-story-profile-runtime.mjs` | 独立 Tavern 副本构建成功，原 UI 反向还原 hash 验证 |
| 门禁有效性 | 先检查列出的测试存在；补 dispatcher/Helper 覆盖；浏览器报告绑定 commit/sourceDigest/环境/时间；增加自有代码 lint | `ops/scripts/verify-product-workflows.mjs`、`ops/eslint-owned.cjs` | 当前全量技术检查 |
| 图片输入边界 | dimensions 调用前按实际 magic bytes 只允许图库已有支持的 PNG/JPEG/GIF/WebP/BMP/TIFF，阻断伪装成 .png 的 ICNS/JXL/HEIF | `src/image-dimensions.js`；两个图片端点 | `nora-image-dimensions.test.mjs`：16 字节夹具原来超时，修复后拒绝 |

“思考时长”仍是客户端请求阶段观测值，不宣称等于供应商内部纯推理时间。没有生成虚构思考正文。

## 冗余和架构判断

实际删除的是浏览器旧 `executeStActivationPlan` 执行器，以及产品 Worldbook 域中未调用的 `listRecentWorlds`。旧测试转为验证当前 Snapshot 执行器；后端 plan schema、ST recent-chat 端点保留。没有通过大批删测试换取通过。

此前暂缓删除的 `prepareCharacterRuntime` / `waitForCharacterRuntime` 已在后续收敛中退役：复核了 Story 域投影、Nora UI 调用、随包 Helper/MVU 文本引用和旧测试。当前随包产品没有调用；原 ST 的上下文和插件 API 不属于本次删除范围。不能据此保证任意外部脚本对 Nora 私有模块的直接导入兼容。

当前不是两个完整在线后端：World Core 是权威身份/生命周期，ST 是资源和生成兼容执行层，Story Profile 是随包快照与按需 Python 子进程。磁盘 tokenizer 缓存、HTTP 静态缓存、Snapshot 重验证分别解决不同问题，不能按“重复缓存”全部删掉。

主要结构债务不是目录名或 ST 代码数量，而是：兼容插件上游变更缺少完整可重建补丁链；全量索引重建/历史聚合有规模成本。此次没有引入微服务、第二套 World、换数据库或重写 UI。后续接口退役的具体范围见文末，不能泛化为全仓库零冗余。

## 依赖安全结果与发布阻碍

2026-08-30 对实际锁文件执行生产依赖审计：初始 32 个被标记的包（11 high、21 moderate、0 critical）。这不是 32 个独立且已验证可利用的漏洞。

兼容范围更新了 DOMPurify、Multer、Express/body-parser、simple-git、ws、Jimp/file-type、form-data、URI/IP 等依赖；`lodash-es` 用同主版本 4.18.1 override，保留 Chevrotain 11。没有执行 `audit fix --force`。更新后生产审计剩 **2 个包：image-size（high）、showdown（moderate）**。

1. **image-size**：[ICNS 公告](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)、[JXL/HEIF 公告](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)无修复版本。已经在本项目两个已知调用入口做输入范围防护并验证 ICNS 夹具；依赖本身仍有漏洞，不能写成 audit=0 或全面安全。第三方插件若自己直接调用它，不在该入口防护内。
2. **Showdown**：[ReDoS 公告](https://github.com/advisories/GHSA-rmmh-p597-ppvv)无修复版本。主消息链是先转换 Markdown 再 DOMPurify；后置清洗不能消除转换过程的 CPU 阻塞风险。其 XSS 公告不等于已证明本项目 XSS 可利用，现有清洗需分别验证。为保持原 ST 输出和扩展行为，本轮没有擅自替换 Markdown 内核，也没有假装简单限制消息长度就解决问题。下一步须对原 subparser 做可复现测试，选择语义等价修复/可维护补丁来源或经批准替换，跑 Markdown、复杂 HTML 卡和扩展矩阵。

   补充实际探测：使用当前锁定 Showdown 和项目已有 `addShowdownPatch`，普通 28KB 文本约 4ms、24KB 未闭合嵌套链接约 70ms；240007 字节同类文本超过 1500ms 被隔离进程硬截止。这是解析器级可复现超预算，不是对用户当前正常对话耗时或浏览器 P95 的测量。记录在 `showdown-probe.json`；此项尚未修复。

稳定打包已加 production audit 门禁；当前两个残留项会阻断 stable，而不是默认豁免。Candidate 允许生成但标记为非用户结果验证版。

其他明确未完成项：

- Linux/Liveware 新用户安装、访问控制/绑定、真实五流程和冷/热 P95；本轮只有 macOS Node 22 的隔离证据。
- 复杂卡 Regex/Helper/MVU、脚本按钮、编辑/重生成/智能回复的真实浏览器矩阵；1 项真实模型流测试有意跳过，未付费调用。
- 完整 tokenizer 缓存损坏校验、缓存容量和千世界规模基准；已解决并发冷初始化，不等于所有缓存问题。
- 全局 Store 一致性已修；跨物理资源删除与另一个世界新增引用的完整事务证明仍未建立，不能把短锁改动宣传成跨文件数据库事务。
- 插件上游补丁 manifest/可重建源码链、明确支持范围与许可交付检查。
- 最终提交、tag、部署和目标版本确认，本轮没有授权执行。

## 验证与复核入口

最新完整检查、构建、候选包和安装重启记录保存在 Git 忽略的 `local-state/release-hardening/`：`check-results.json`、`build-results.json`、`package-result.json`、`smoke-result.json`。这些是真实执行证据，但不会随 app 分发。最终数字和候选身份在本记录收尾节记录。

隔离安装验证覆盖：仅从 app/ops 压缩包安装生产依赖；初始世界列表为空；经 CSRF 创建世界；等待持久操作完成；读取激活 Snapshot；ETag 二次请求 304；停服务、重新解压同一 app 包、安装并重启后 World ID 与资源可读。它证明同包重装/重启保留数据，不证明任意旧版迁移或 UI/MVU 可用。

测试夹具在同一进程同步停止/启动子服务时，曾复用旧 HTTP keep-alive 连接出现 `fetch failed`；重启日志正常。复核请求改用新连接后通过，没有为此改生产网络重试逻辑。

## 上一轮候选包收尾结果（后续源码已有变化）

- 最终隔离候选内：296 项测试，295 通过、0 失败、1 跳过（需真实模型授权）；25 项架构契约通过；引擎/自有 UI/ops/build 静态检查通过；完整构建通过。
- 构建后启动资源预算契约通过，inline manifest Brotli 为 509348 字节；这不是 Liveware 全链路加载秒数。
- 最终候选离线生产安装及上述重装/重启验证通过；不读取作者世界、密钥或模型配置。
- 候选路径：`release/candidate-9f0ba72634e1-1788077314357/`。`candidate=true`、`dirty=true`，Node `v22.22.3`；不是 tag/部署身份。
- 打包时 sourceDigest：`5670e9d20bd5b2c11158fb01a73c28f3adcf6bed635644102517e1a07e722e58`。当时包内 976 个 artifact 哈希与同名本地文件全部一致；**后续源码已修改，这项一致性不再适用于当前工作树**。
- app 包 SHA256：`12f6d86c456b471cb415cdf66b1d19cdf9724438c868969d0aba88e54fcb5e86`；其他产物以候选目录 `SHA256SUMS` 为准。
- 嵌入 Story Profile 来源 revision：`a579b7db28e505de182295c7d046014224883ab1`，未修改兄弟仓库生成逻辑。
- MCP 主图全量刷新，Actor/Helper 语法补充与文件覆盖核对见 `INDEX-COVERAGE.md`。索引有明确边界，不标记为“全项目已完全证明”。
- 未提交、未推送、未部署、未打开浏览器。测试创建的假世界仅存在于临时隔离目录，测试服务均已停止。

发布决定：**允许继续候选验收；不批准正式 stable 发布。** 需要先收口 Markdown 解析安全和兼容策略，再经授权执行目标 Liveware/浏览器矩阵，之后才能固定最终提交和发布版本。没有把待办风险改写成已完成项。

## 后续代码收敛 — 2026-08-30

用户范围：继续真实清理当前项目；暂缓 Markdown 解析器问题。保留 UI、World 语义、原 ST/Helper/MVU 能力和 Story Profile；不部署、不提交、不修改用户数据。

本次沿用已有模块边界，使用模块设计方法缩小接口；发现接口漏接后，按诊断流程先做真实模块组合的失败测试，再修改实现。没有添加新的服务、缓存或兼容代理层。

### 已删除及保留的边界

| 范围 | 实际改动 | 为什么可以删除／必须保留 |
| --- | --- | --- |
| 卡运行时 | 删除 `prepareCharacterRuntime`、`waitForCharacterRuntime` 实现及导出 | 只有旧测试和两个旧函数自身相互引用；当前按能力走 `ensureCharacterCapability`，包含授权、激活和就绪证据 |
| 创建／导入 | 删除 Nora card adapter 的 `createCharacter`、`importCharacter` 和 Story cards 对应投影 | UI 真实调用为 World Core 的 `createBlank`、`importCard`、`createFromLibrary`；旧入口可绕开 World 生命周期。原 ST `getContext().importCharacter` 保留给兼容层 |
| 角色卡库 | 删除未调用的 `findDuplicate`、其私有 `sourceFingerprint`、未使用的 `store` 注入；`identity` 留在内部，不再导出 | 旧导入前扫描已无产品调用；现有库分页、按需展开、内容分组和未使用副本清理仍有实际用途，全部保留 |
| 测试与门禁 | 旧准备/等待测试改测当前能力接口；旧直接建卡测试改为防绕行契约；删除只测试 `findDuplicate` 的文件并移除门禁引用 | 在当前库入口增加浅卡/编辑差异/来源差异/使用中保护用例；World Core 的创建和导入集成测试保留并执行 |

源码、调用图与随包脚本精确引用检索共同支撑上述判断，不是仅凭“索引零入边”。清理后图中相关 Nora 模块没有四个旧函数定义；构建后的 JS 也没有对应旧标识。测试中的负向契约和历史文档引用不是残留运行逻辑。

### 同时发现并修复的接口缺陷

`card-capability-controller` 在能力 READY 后要求重绘当前聊天；ST adapter 已实现 `rerenderCharacterChat`，但 `createStorySurface` 没有把它传给 UI。原 `typeof` 判断让这一步静默跳过。此前测试直接注入假 cards 对象，因此没覆盖这条真实接线。

修复：把已有重绘方法加入 Story cards 的显式接口，移除静默跳过缺失方法的分支。适配器保留活动卡校验，并在**已经生成中的情况下不重载聊天**，避免晚到的能力结果清掉流式页面；未增加等待队列。

直接证据：组合实际 Story projection、ST adapter 和 UI controller，只有最底层运行时与服务结果使用夹具。原代码 READY 后重载次数为 0，期望 1，失败；只补接口后通过。补充生成中场景原来重载 1 次，期望 0，失败；加入生成保护后通过。另覆盖空结果、DEGRADED、已切到其他卡不重绘，以及重试 READY 的路径。

这证明接口漏接和已生成中保护得到技术修复；不证明所有异步竞态、第三方卡页面或目标 Liveware 的视觉结果已验收。

### 当前技术结果与剩余边界

- 本次改动直接相关的 8 个测试文件：59 项通过、0 失败。
- 本地 `npm run test:nora`：300 项，299 通过、0 失败、1 跳过（真实模型）；25 项架构契约通过。
- 完整构建、引擎/UI/ops/build 静态检查通过；构建后单独再跑 25 项契约通过。
- `verify-product-workflows.mjs`：继续会话、导入、游玩修改、卡库建世界、刷新/重启五组技术检查通过。输出明确 `browser.passed=false`，未冒充用户结果验证。
- 构建更新了工作树交付 JS；**本次没有重新打候选包，也没有部署**。上节旧包不可视为本次实现。
- MCP `tavern` full + persistence 刷新；文件哈希索引同步。详见 `INDEX-COVERAGE.md`，不宣称语义全覆盖。
- 未触碰 Showdown，也没有新增 npm 依赖或修改模型费用策略。前述安全残留、目标环境验收及其余明确债务仍然有效。
- 工作树仍包含上一轮和本轮未提交修改。代码接口更收敛，不等于 Git 已干净，更不等于正式发布批准。
