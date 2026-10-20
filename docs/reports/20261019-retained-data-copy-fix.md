# 保留数据重装复制修复：独立分支

后续发行（2026-10-20）：本修复已随核心 2.5.5／启动器 2.2.5 在 GitHub、极狐正式交付。固定产品 `4907f85` 的三平台成品及实际 Electron／Windows 缓存链接验收结果见[发行记录](20261019-v2.5.5-release-preparation.md)。以下记录保留独立修复阶段的历史范围。

后续状态（2026-10-19）：用户已授权合并；本分支提交 `ce43a8d` 与双更新修复无冲突集成，组合验证通过后已纳入本地 `main`（集成提交 `350f62a`，测试协议校正 `0f5c615`）。本次未推送、打包、发布或重新访问 Windows 测试机。组合检查及失败记录见[双更新修复报告的本地主分支集成一节](20261019-dual-update-contract-fix.md)；以下“本轮／本分支”保留独立修复阶段的事实范围。

## 本次范围与核对

用户于 2026-10-19 授权在独立分支实现，之后自行统一合并。本轮从本地 `main` 的 `cfec1b97457508f83a9cd6af2773b76c48ed26fb` 创建 `codex/fix-retained-data-copy-20261019`；使用独立 worktree，不带入原工作区发布提速、文档或其他任务的未提交改动。不合并、不推送、不构建完整安装包、不发布，不修改用户正在使用的安装。

已读取原工作区产品基线 1.11 和分支基点基线 1.9；本次适用 PB-03、PB-05、PB-06、PB-07、PB-08、PB-09。只修正偏离既有数据保护规则的复制实现，不改变产品规则、UI、目录归属、维护锁、退出保护或恢复协议。

目标：正式源码在保留数据重装时，物理 ASAR 按文件复制和校验；Windows 缓存树内部兼容链接不跟随、不重新创建，其原件保留在原目录备份。普通缓存文件、未知私人文件及用户配置继续复制并验证；越界链接、目标重定向、源文件变化仍拒绝。复制失败时不切换原运行时，成功后原备份仍可用于失败恢复。

保留：聊天、角色、世界、配置及凭据；原程序备份和故障证据；原单一运行时事务的日记和恢复逻辑。独立 R7 修复器不搬入主项目。双更新兼容声明缺失属于另一个问题，不纳入本分支。

## 证据与验收计划

R7 独立项目已在 Windows 11 验证固定 2.2.4／2.5.4 上的修正；该结果只作为本次迁移来源，不能冒充新分支的新成品验收。

本轮先在未修正的源码上用真实 Electron 复现物理 ASAR 复制故障，保留旧代码失败和修正通过的输出。迁入四个相关模块，补齐正式打包清单。使用现有运行时测试入口覆盖普通文件、原配置、新程序隔离、路径重定向、源文件变化及真实事务提交／恢复；最终 APP 门禁直接运行已打包模块的 ASAR 和 Windows 缓存链接检查，避免仅在 Node 下通过。定向检查和实际原生检查分别记录；没有最终安装包时不声称完整安装器验收。

## 实际结果

已实现于本分支，未合并、推送、构建完整安装包或发布。

### 实现

- 将 R7 已验证的 `runtime-retained-data.js` 迁入正式源码，替代事务内原有的通用递归复制。迁入前核对三个原模块 SHA256，均与已审查的官方 2.2.4 基点一致；没有覆盖其他新版逻辑。
- `runtime-transaction.js` 和 `tree-integrity.js` 在 Electron 下使用物理文件接口；`runtime.js` 的链接核验同样按物理文件遍历，不把历史 ASAR 的内部虚拟文件当作磁盘目录。
- 普通文件复制后核对摘要与源文件身份／时间／大小；Windows 指定缓存树内、目标仍在同一缓存树的兼容链接只保留于旧副本，其路径和原因写入既有运行时事务日记。普通缓存文件和未知私人内容不被整体跳过。
- 新模块加入 `launcher/desktop/package.json` 的正式 `build.files`，不新增依赖、不修改锁文件或版本。
- 复用既有源码测试入口。最终 `launcher_packaged_app.test.cjs` 自动调用新的 Electron 回归，使用实际打包模块；不能只凭模块存在或源码测试放行。

### 验证

| 检查 | 实际结果与边界 |
| --- | --- |
| 未修正代码的真实 Electron | Mac ARM、Windows x64 均重现物理 ASAR 的 `ENOTDIR/opendir`。Windows 当前令牌允许创建链接，旧代码实际重建了缓存 junction；不是本轮重现了权限拒绝。对应的“不重建缓存兼容链接”断言失败，证明旧路径仍依赖该操作。 |
| 修正后的真实 Electron | Mac ARM 的物理 ASAR 复制、原摘要、全树封存和链接核验通过，Windows 专用项按平台跳过；Windows x64 两项全部通过，原 ASAR、配置、普通缓存字节和原缓存链接保留，暂存目录不重建兼容链接。Windows 上 7 个源码／测试输入摘要与本分支逐一相同。 |
| Mac ARM 定向源码检查 | 真实 Node 24.19.0，Python 3.12.14／psutil 7.0.0／PyYAML 6.0.2，四个现有文件共 37 项通过、零跳过。包括普通内容、真实同名 `.asar` 目录、目标重定向、外链、复制期间源变化，以及受 native lease 管理的真实提交／整项回滚、KEEP 重装、硬中断及恢复、备份缺失／修改拒绝和原失败证据保留。 |
| 源码交付布局 | 现有仓库布局检查 17 项通过，含新源码的候选投影、路径映射和执行者退出／导出清理；不是完整安装包验收。 |
| 完整新安装器 | 未构建，因此不声明本分支的新 EXE／DMG 或完整 Windows 安装向导已验收。R7 先前完整安装／数据读取证据保持其原 ZIP 身份，不追认为本分支安装包结果。 |

测试环境初检发现所选共享 Python 缺 psutil，已在本次忽略目录建立独立 venv 并使用要求中的固定版本，之后前置检查通过。初次 Windows 只复制了最小源码，遗漏 `launcher-errors.js` 的 `telemetry-contract.json` 依赖；补齐原文件后重新验证。新增事务断言最初误读只读投影中不存在的 `recoveryVerification`，已改为读取实际日记字段，同时断言投影的 `effectState=restored` 和 `canRecover=false`。这些首次执行均未计为通过，未为其改产品保护规则。

维护入口：

```sh
node tooling/checks/launcher-test-environment.mjs source
node tooling/run.mjs node --test --test-concurrency=1 \
  tests/deployment/launcher_runtime.test.cjs \
  tests/deployment/launcher_runtime_transaction.test.cjs \
  tests/deployment/launcher_restore_runtime.test.cjs \
  tests/deployment/launcher_install_source.test.cjs
ELECTRON_RUN_AS_NODE=1 node tooling/run.mjs /absolute/path/to/Electron --test \
  tests/deployment/launcher_retained_copy_electron.test.cjs
```

上述命令要求真实 Node 24 和前置检查通过的依赖；worktree 可通过既有 `NORA_TEST_DESKTOP_NODE_MODULES` 指向锁文件匹配的独立依赖。Electron 检查需要其真实 `app.asar`／`default_app.asar`，也可通过 `NORA_RETAINED_COPY_ARCHIVE` 明确传入一份真实归档；普通 Node 下该文件会明确按平台条件跳过，不能作为原生通过。

诊断阶段从旧事务模块提取当时真实的私有复制函数，在原生 Electron 中获得失败证据；该原始复现驱动只留在忽略目录。最终长期维护的 Electron 回归直接调用新模块公开的 `copyUserData`，与真实事务使用同一接口，不依赖私有函数源码抽取。

本机原始证据位于忽略目录 `local-state/retained-data-copy-20261019/`：`mac-before.tap`、`mac-after.tap`、`windows-before.tap`、`windows-after.tap`、`windows-original-repro-after.tap`、`mac-source.tap`、`layout.tap`、`source-checksums.json` 和 `original-repro.cjs`。原始复现驱动在修正后的 Windows 源码上重跑两项通过。未提交运行环境、原始日志、正式包、用户数据或凭据。

Windows 只在本次带 owner 标记的临时目录运行源码检查，未替换已安装 APP 或用户数据，未停止现有服务。证据取回后已核对 owner 并删除该临时目录；SSH、Tailscale、Clash 服务仍运行，远程连接正常。

没有因本轮发现另改双更新发布协议、卸载策略、ClawChat、UI 或修复器交付。统一合并后仍需按实际变化进行新成品验收；原双更新兼容声明缺失不由本分支解决。
