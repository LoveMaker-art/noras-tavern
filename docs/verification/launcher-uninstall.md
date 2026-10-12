# 启动器卸载验证记录

这是开发与发布记录，不是用户指南。[用户卸载步骤](../launcher-uninstall.md)。

## 发布状态核对

2026-09-10 核对 GitHub `v2.2.11` 发布记录：发布页已有 Mac Apple 芯片、Mac Intel、Windows x64 三个安装程序，更新记录包含卸载流程。因此用户指南中原有“当前为源码实现，尚未重新发布三端安装包”已经过期。

发布文件存在与发布说明提及该功能，不等于每个系统版本的卸载路径均已真机验收。原始实现阶段记录如下，不能作为新的实测结果。

## 原实现阶段验证范围

- 清理核心：保留数据、彻底删除、符号链接边界、长路径、重复执行及归属变化测试。
- 恢复：重新释放 Hermes 运行时后，读取原有配置与记忆，不覆盖新程序文件；恢复酒馆原有运行配置。
- 安全门：取消、二次确认、服务停止失败时不生成删除计划。
- Windows：在 `LongPathsEnabled=0` 的 Windows 机器上执行隔离文件测试；NSIS 钩子另有编译测试。
- macOS：使用临时 Electron App 验证辅助进程删除自己的 App 和临时数据，原 App 不变。

三平台系统卸载界面、取消、保留后重装和覆盖升级的真实用户验收不能由这些单元测试代替。本次文档梳理没有新增三平台实测。

## 2026-10-12 稳定性整顿：恢复历史与彻底卸载

本节记录候选源码的验证，尚未打包或发布，不能视为正式版本已具备此行为。

原缺陷：保留数据和彻底卸载都要求历史安装、更新及启动器替换事务的恢复证明完整。用户已确认永久清空当前安装时，缺失的旧证明仍会阻止清理，与彻底卸载的目录删除范围冲突。

当前改动：只有保留数据模式要求历史事务可安全保留；彻底卸载不消费旧事务中的路径或恢复证明来决定删除目标。两种模式仍要求当前目录归属、路径边界、原生 writer 独占和维护执行器离线检查。彻底卸载仍需要界面的两次确认；保留数据模式无法确认恢复时不删除程序或数据。

接管安全：辅助程序取得自己的 writer 后，再确认酒馆、网关和本安装相关进程离线，避免 GUI 停服到辅助程序接管之间的重启空档。检查绑定当前启动器、ASAR（源码回归为实际源码入口）、只读 bridge 的资源闭包、当前目录和权威端口；文件变化、缺失绑定、监听端口或无法核验进程都保留文件。已有 Python 时执行现有 `repair-preflight --offline-only` 并要求真实成功退出和完整离线结果；缺 Python 时执行有界、只读的系统进程检查，不凭缺少 PID 文件认定离线。

仅彻底卸载允许未知端口的 `native-root` 模式：当当前实例记录已损坏，或旧历史在真正停服调用之前阻止准入，界面将明确移交给辅助程序现场检查，端口保持 `null`，不猜默认值。此模式不读取旧事务或损坏实例来授权删除；候选进程的相对脚本、内联命令、缺失路径或未知归属仍阻断。实际停服调用开始之后失败仍中止，保留数据卸载没有此例外。

红绿回归在隔离真实源码投影中执行，使用临时安装目录、原生锁、现有操作 guard 及独立 worker；没有替换历史读取或锁实现。新增的 10 项核心检查在改动前有 9 项因 `UNINSTALL_RECOVERY_REQUIRED` 失败，改动后 10 项通过。其中覆盖 Operation、runtime、first-install、system、legacy、launcher-update 六类残缺记录，外部伪造历史目标的边界，以及 helper 的实际完成结果。另有现有确认界面 fixture 验证两次确认和显示目录，不将它称为系统卸载界面实测。

只读历史检查的超时回归使用真实子进程，验证实际读取进展可以延长空闲截止，重复计数与诊断心跳不能延长截止，持续进展仍受总时限约束，终止后等待子进程关闭，且成功退出与最终安全结果缺一不可。此检查不代表所有用户磁盘速度下的真实性能。

复现命令（在仓库根目录，先提供既有原生测试依赖和含 `psutil`、`PyYAML` 的隔离 Python）：

```sh
node tooling/run.mjs node --test --test-name-pattern='all clears incomplete|all ignores forged|all with incomplete|standalone all worker' tests/deployment/launcher_uninstall.test.cjs
node tooling/run.mjs node --test tests/deployment/launcher_uninstall.test.cjs
```

接管缺口另有一条真实端口回归：修前即使监听服务已重新出现，worker 仍删除文件并写 `complete`；修后写 `UNINSTALL_SERVICES_UNCONFIRMED` 且所有原文件保留。Mac 源码回归还启动真实 Node 进程占据临时安装目录，验证不监听、没有 PID 提示时的两种模式都阻断；坏实例、坏状态、坏旧 journal、无 Python 且实际无服务时，彻底卸载可完成。托管 Python 模式也读取现有真实 bridge 的离线结果。Windows 的结构化 parser 样本在 Mac 运行只证明解析规则，不代表 Windows 系统进程实测。

只读系统 Adapter 的中文路径单独以真实进程验证：Mac `lsof` 在 C locale 下输出 UTF-8 字节转义，必须严格解码后比较目录；未解码时的新增 Adapter 曾在回归中误报完成，修正后中文安装目录及其活进程均保留。非法 UTF-8、未知转义、缺路径字段不产生离线证明。Windows 固定 PowerShell 入口显式输出 UTF-8；无当前辅助程序的快照、相对脚本、内联执行、隐式标准输入和无明确绝对脚本入口也不产生离线证明。以上规则没有测试进程的豁免。

Mac 的 Hermes 模块启动还可能由 `HERMES_HOME` 指向当前安装，尽管解释器和工作目录都在外部。此形态已用真实外部 Python 进程、匹配的 `-m hermes_cli.main gateway run` 调用及临时环境绑定复现：原先误报完成，修正后作为未知归属阻断。内联/交互入口同样不能凭外部 cwd 认定无关；正常绝对脚本位于其它目录、进程归属可完整读取时的正向回归仍可卸载当前临时安装，不删除脚本或结束该外部进程。

活进程回归先在 `finally` 中终止本测试创建的进程并等待 `close`，随后删除临时目录；不依赖多个 cleanup hook 的排序，避免 Windows 工作目录占用导致残留测试进程。所有这类测试都有执行时限，没有增加产品中的杀进程机制。

边界：本轮没有运行新安装包的 Windows NSIS、Mac App 自删除、用户真实目录卸载或三平台保留后重装。接管检查已在源码路径验证，最终封装的资源布局和原生产品流程仍需对应平台验收。helper 失败仍以本机结果文件和标准错误记录；尚未补齐退出后卸载错误到接收端的上传协议。

本轮最终 Windows 源码回归补充：在独立普通 Python 3.11.16（psutil 7.0.0、PyYAML 6.0.2）与官方 Node 24.21.0 上，最终卸载 suite 参与 13-suite 稳定性全组运行并通过，包含真实中文脚本、现场监听／活进程阻断、外部明确脚本不干扰目标，以及未知端口残缺历史的 ALL 清理。整个 Node 组 469 通过、3 个 POSIX 权限检查跳过；不是最终 NSIS 或用户目录卸载。测试子进程统一在 `finally` 中先结束并等待关闭，再清理临时目录，最终没有依赖清理 hook 的先后顺序来放行。

## 当前实现入口

- [桌面端确认与交接](../../launcher/desktop/main.js)
- [卸载清理逻辑](../../deployment/uninstall/uninstall.js)
- [Windows NSIS 集成](../../deployment/uninstall/uninstall.nsh)
- [卸载回归测试](../../tests/deployment/launcher_uninstall.test.cjs)
- [本地主线合并验证](../local-main-integration-verification.md)

[v2.2.11 发布记录](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.2.11)
