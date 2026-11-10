# 核心构建与交付

本仓只构建核心档案及适用的环境输入。构造入口为 `node tooling/release/package-release.mjs`，开发命令和前提见 [CONTRIBUTING](../CONTRIBUTING.md)。

1. 固定干净源码提交、组件版本、共享维护输入和适用平台/运行时；核对产品设计与数据边界。
2. 先运行相关核心源码、共享消费者及实际目标平台检查；记录通过、失败、跳过和未验收。
3. 使用固定源码构造核心 archives/modules；需要完整首次安装时指定经摘要验证的运行时清单，生成 `core-payload` 及平台 `nora-system` 元数据。
4. 核对源码身份、依赖receipt、包内文件、校验和、旧版本升级/失败恢复与配置保留；候选不能代替真实安装结果。
5. 只发布验收过的同一批实物。推送、上传、创建标签、外部发布或更新正式渠道都须另获明确授权。

打包器只构建，manifest 明确记录 `packaging-only`。本次拆分保留已发布资产、存量协议和所有用户目录。桌面构建及其更新渠道不属于本仓。

## 独立核心流程

`core-ci.yml` 在 Linux、Windows、Mac 执行 `core-source-gate.mjs`：固定输入/归属及发行合同、核心 JS/Python 消费者、酒馆工作流。它只提供源码证据。

`core-build.yml` 手动触发，在 Windows x64、Mac ARM64/x64 上执行相同源码门禁，再由 `build-core.mjs` 构造和验收。本轮复用的 Hermes 运行环境按 `tooling/runtime/runtime-inputs.lock.json` 固定原发行来源、大小和 SHA-256，不重建运行环境，也不读相邻仓源码。更新运行环境时必须单独审查并改锁，不能追随 latest。

每个平台实际恢复密封运行环境，运行真正的冷初始化、首装、酒馆 HTTP/MCP/技能检查、已提交安装的再次开启、两个本地模型端点的保存与实际 Hermes 调用、配置保留及停止/子进程关闭。模型端点是隔离夹具，不证明外部模型或真实 ClawChat 可用。源码失败恢复合同和此处原生成功流程分别记录，不能相互替代。

三份平台 receipt 绑定源码、共享输入、运行环境输入及全部包摘要。只有三平台都通过才由 `assemble-core.mjs` 组装 `core-accepted-batch`，不重新构建，发布器重新检查这些字节。构建产物保留30天；超期须重新构建验收。升级跨度、强制中断/恢复、文件权限和用户环境矩阵按本次变更风险另做目标环境验收，自动构建成功不等于这些场景通过，也不自动授权正式发布。

## 发布与重试

1. 先完成本次核心版本及兼容声明的审查，提交干净源码，获得推送/创建版本标签的明确授权。核心标签必须与 `app/.tavern-release-version` 一致；不得把当前改动冒充已经发布的同版本标签。
2. 在 GitHub 配置 `JIHULAB_PRIVATE_TOKEN` 和 `core-release` environment 的必要审阅人。权限/配置不能靠本地测试证明，本次不配置远端。
3. 授权后运行核心构建；核对目标环境升级、失败恢复及配置保留证据。再手动启动 `core-publish.yml`，指定成功的 **core-build run ID**、解析到同一提交的远端标签和已审阅的发行说明。它下载该 run 的同一批实物，不调用打包器。
4. 发布前再次执行包内实际核心更新选择器，使用最终密封目录离线选择三平台 install/update，校验元数据、摘要及主资源源。发布使用 GitHub + 极狐，所有不可变对象校验成功才切换 **核心** stable/beta 指针；不会写桌面应用渠道。旧资产保留，不覆盖不同字节。跨站切换不是原子事务，失败保留进度。
5. 任一失败下载 `core-publication-checkpoint` 和日志；保留接受过的 build run。重新触发发布时填写前一发布 `checkpoint_run` 和其 `publication-plan.json` 的可信 plan ID。恢复会检查同一源码、构建 run、目标、摘要和原目录字节；遇到上传结果未知时先核对远端，禁止盲目重传。也可用 `publish-release.mjs --resume --plan-id ...` 在受保护环境继续同一计划。

本地 `publish-release.mjs` 默认 `--stage seal`，只生成计划并校验消费者；`prepare` 上传草稿与不可变文件，`promote` 切换已准备渠道，`all` 顺序完成两阶段。三个写入阶段都必须有明确授权和受保护凭据。凭据仅来自临时0600文件，不在包/receipt/checkpoint内。

源码技术验证、Mac本地实物、远端工作流执行、三平台目标环境及实际发布须分别报告。本地流程实现不能写成“GitHub已发布”。
