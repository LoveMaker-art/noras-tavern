# 启动器主分支整合与源码清理（2026-10-13）

## 整合范围

已验收优化提交 `51882b8fee0900a1f3133b57ab58bf7f33553e61` 于 2026-10-12 快进合入并推送 GitHub `main`，包含此前六个启动器修正提交和本轮 75 个明确任务文件。没有构建安装包、创建 tag、执行发布或修改生产服务。

`docs/README.md` 与 `docs/launcher-handoff/` 的既有其他任务修改保留在工作区，未混入本轮提交。所有工作树、用户数据、故障证据和标签保留。

## 文件审计与清理

按运行入口、动态引用、源码投影、构建／包清单、测试与兼容职责检查当前模块。现行文件职责见 [仓库导航](../REPOSITORY.md)，逐文件路径与摘要由现有 `tooling/checks/index-project.mjs` 生成。

| 清理项 | 依据和同步处理 |
| --- | --- |
| `launcher/desktop/pnpm-lock.yaml`、`pnpm-workspace.yaml` | 当前开发、CI、构建使用 npm 锁；真实 Electron Builder 检测在双锁时退回环境判断。删除备用锁与配置，保留 npm 锁及依赖版本，增加单锁及 lock/package 一致性合同 |
| `launcher/previews/legacy.html`、`refinement.html` | 无正式运行或独有验收消费者，原本已被运行包排除。退出源码映射和索引分类，更新当前导航；历史 baseline 的排除规则仍保留，设计原件可从 Git 历史回溯 |
| `nora-mcp/scripts/index-upstream-st.mjs` | 已被统一项目索引替代；无现行 npm、CLI、CI、构建或测试消费。README 指向仓库根目录的现行命令，历史架构材料保留 |
| `main.js::checkCommand`、`ConfirmationRequiredError` | 无运行或动态消费者；同时退出仅供死函数使用的 `spawnSync` 导入，实际错误类型和托管 Python 查找保留 |
| `first_install.py::restore_targets` | 已无生产消费，仅旧测试调用。先将三个用例切换到现有 `FirstInstallJournal` 真实恢复，再移除旧 helper；`snapshot_targets` 仍由更新器使用，保留 |
| 过期职责说明 | 修正 `deployment/README.md`：旧 JS 系统更新文件负责历史恢复；当前完整更新经 executor／bridge 进入 Python updater 与 Journal |

实际删除 5 个过期文件及 3 个无生产消费的函数／类，保留所有现用测试。恢复回归保留原配置、AGENTS 与旧 `.bak`、源快照、新建目标清退、失败候选归档及真实 Windows 长路径要求。

明确保留的相似／旧文件：Story Profile 的手写源与受校验快照；前端构建运行资产和许可证；Helper／EJS／MVU；旧 World 迁移和资源保护；公开 ST 模块地址；隐式编译的类型声明；Mac／NSIS 和真实 actor 验收；原事故 fixture。`runtime_process.stop_process` 有实际动态调用，`test-build.js` 是候选隔离协议，均保留。

## 分支清理

清理前保存了完整 Git bundle、引用清单及工作区文件副本，bundle 验证通过。删除远端引用使用逐项旧 SHA lease 和原子 push；本地删除核对引用身份，保留默认分支、tags 和所有工作树。

- 9 个本地、11 个远端分支的提交已经属于 `main` 祖先或全部补丁已等价进入 `main`，清理其引用。
- 另 2 个本地／远端分支是已结束的 prompt-loader 与 Windows bootstrap 隔离诊断。各自独有提交仅修改诊断 CI；相关功能修正已在主线，无 open PR、占用工作树或运行／排队任务。按“退休诊断分支”归档后清理，未冒称这些独有诊断提交已合并。
- 合计删除 11 个本地、13 个 GitHub 分支。保留本地 `main` 和仍有未提交工作的 `codex/chat-120s-diagnosis`；远端保留 `main`。

恢复依据为忽略的 `artifacts/launcher-main-cleanup-20261012-1c4cf9f9/before-refs.bundle` 和 `branch-cleanup-result.json`，包含每条原始引用、SHA、删除理由及保护结果。没有删除或归档其他任务的工作树。

## 验收与边界

- 文件布局／发布计划及主进程定向回归：114 项通过，无跳过。
- MCP：类型检查通过，隔离导出内 25 项单元测试通过；本地原有 `dist` 摘要未变。
- 清理后统一源码门禁：610 项 JavaScript 通过，无跳过；208 项 Python 运行、206 通过、2 项平台专属跳过。
- 实际 Mac Hermes 环境的三个安装模块：58 项运行、57 通过、1 项原生 Windows 长路径跳过。
- Windows 三个完整安装模块复验：58 项运行、57 通过、1 项按既有条件跳过真实 Hermes 集成。源码前置检查通过；原生 >260 字符路径的 Journal 备份／恢复，以及修正后的字节、原始备份与 failed-new 断言通过。源码／上下文摘要一致，关联进程关闭，私有 TMP 和传输目录清理完成。

Windows 首轮真实执行发现新增恢复测试的换行假设错误：`write_text` 写出 CRLF，字节断言固定为 LF，失败发生在调用恢复之前。修正仅限测试：在准备前捕获原始与候选真实字节，应用、恢复、快照和失败归档均严格比较这些字节，保留平台真实换行；没有修改产品、归一化数据或跳过断言。首轮失败和原因说明保留，Mac 与 Windows 修正后均完整复验三个模块通过。成功回执为 `windows-cleanup-newline-fix-result.json`，初次失败没有覆盖成成功。

源码清理、合并和技术回归不建立最终安装包验收、正式发布或全部历史事故闭合。公网间歇性超时与最终三平台包的首装、升级、恢复、卸载及历史版本矩阵仍是后续放行事项。

执行记录及源码／日志摘要保存于 `artifacts/launcher-main-cleanup-20261012-1c4cf9f9/`。全部本轮源码清理提交并推送后，按实际 GitHub 主分支 SHA 另存最终回执。
