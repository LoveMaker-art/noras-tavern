# 启动器测试清理（2026-10-12）

范围为启动器、部署测试、手工验收工具及其 CI 调用。产品源码沿用上一轮稳定性修正，本轮没有为了通过测试改变产品行为；没有打包、提交、推送或发布。

## 文件处理

盘点 `tests/deployment` 全部 131 个文件；其中 126 个 JavaScript／Python 代码文件完成语法检查，包含 Python 无效转义告警检查。当前未发现可证明废弃且可安全删除的现存验收脚本：有调用的工具及无等价替代的 Mac 自删除、NSIS、真实 MCP 验收均保留。历史版本与脱敏样本也保留，不能以旧版本号或无 CI 调用为由删除。

| 问题 | 处理与验证 |
| --- | --- |
| 忽略声明的 Node，使用 PATH 上的 Bun shim；显式坏路径被跳过 | 13 个 Python 模块统一 Node 选择与真实执行文件核验；坏路径、空值、Bun 和不同执行文件明确报测试前置错误。PATH 无 Node、显式 Node 有效时，原先跳过的 MCP／程序检查实际执行通过 |
| Python 输入分叉、旧 Hermes 变量 | 统一 `NORA_TEST_PYTHON` 优先于 `NORA_PYTHON`；移除 `NORA_TEST_HERMES_ROOT`，使用真实 `NORA_TEST_HERMES`。模型保存 fixture 可从真实 venv 元数据取得缺失的 basePrefix，保留受管身份检查，避免新 venv 丢失测试依赖。官方 prompt loader 和 managed venv 的 requests／Hermes 导入在既有只读 QA runtime 中验证 |
| JSON 解析异常逃出异步回调、监听错过关闭 | 共用测试 helper 在创建子进程后缓存实际 `close`，解析／缺输出／超时经 promise 返回；真实坏 JSON、晚输出和关闭竞态有回归 |
| 子进程／客户端／目录清理次序错误 | guard-owned jobs 通过原 lease 取消并释放；普通 fixture 等待实际 `close`，包括无 PID 的 spawn 失败，再删目录；所有重开 telemetry clients 先关闭，再释放 SQLite 和临时目录。真实缺失程序和延迟关闭有回归，诊断回调不再重建已删测试目录 |
| PATH 被恢复成空串，线程退出打印误报栈 | 环境变量精确恢复存在／不存在状态；服务器线程有有界 join，预期关闭安静处理，真实线程错误返回主测试 |
| Linux fixture 本身语法错误与错误就绪等待 | 修复非法 lambda raise，生成脚本先编译；通过 ready marker 确认注册退出 handler，失败清理自己的子进程。Mac 实际 fixture 启动／停止通过，Linux 产品行为仍按平台区分 |
| Windows 路径和 Unix 测试输入混用 | 合并 `Path`／`PATH` 并保留系统工具路径；预先验证 PowerShell。更新提醒运行真实 Python CLI，POSIX shell 单独验收；cron 保留产品执行适配，脚本在所有平台实际运行，执行位仅在 POSIX 检查。服务匹配使用本机绝对路径 |
| 可用符号链接检查仍被 Windows 平台条件跳过 | 移除两条旧平台跳过，实际验证文件链接摘要与安装目录逃逸拒绝；前置要求链接能力，缺失时先报环境错误 |
| CLI 别名路径绕过前置检查 | 按实际文件身份识别入口；真实符号链接调用也必须执行检查并对坏输入返回 exit 2。Windows 的 Python 失败替身单独处理 PowerShell，避免注入错误层级 |
| 手工 Mac 卸载断言仍要求整个根消失 | 对齐当前 ALL 的 owner／writer lock 外壳；使用空闲端口和绝对 helper 入口；正常、失败、超时、入口缺失分别验证。没有将 helper 测试称作真实 App 自删除 |
| 手工样例验收只接受旧一次性实例名 | 改为显式 `--fixture-root`，限定保留区和当前产品 fixture；核对成功报告、三根目录、端口、MCP 状态与执行入口。准入失败不调用子进程、不改文件；真实 MCP 导入流程保留 |
| 导航把内存单元锁称为真实 native 验收 | 明确内存适配器与真实 actor 的区别；补齐 Mac GUI／真实包输入与手工脚本的适用范围 |
| 测试前置和 CI 调用不一致 | 新增 source／native／chromium／receiver 前置检查；校验 Node、Python、依赖 ABI、链接能力和实际 runtime 身份。CI 提前准备 Python，使用绝对 runner 入口，native 前置失败不能复用 Windows 制品；手工文档采用相同绝对入口 |

## 后续执行规则

从源码运行前先直接调用 `node "$PWD/tooling/checks/launcher-test-environment.mjs" source`，再运行 `verify-launcher-stability.mjs`。不满足前置返回 **exit 2／test_environment**，在测试和昂贵构建前停止；有效测试断言失败仍需要定位，不能直接归为产品 bug，也不能跳过或删除断言来获得通过。根目录布局、门禁和发布工具测试在 authored tree 直接运行；部署测试通过 `tooling/run.mjs` 进入交付布局。

后续统一门禁加入真实 TLS 网络回归，因此 source 前置也要求 PATH 中有实际可执行的 OpenSSL 或 macOS LibreSSL。缺失、拒绝执行或无效版本输出先报 `tls_tools`，不能等到生成测试证书时把环境问题报成产品故障。只对测试 runner 设置 PATH，保留系统设置；当前完整证据见产品收敛对账。

完整 Hermes actor、Chromium 本地 TLS 和 Receiver／D1 使用各自前置。Receiver 测试没有接收端源码时不属于已通过的源码 UI 检查，因此从原来会全量跳过的 CI presentation 列表移出；独立 Receiver 流程和 15 项集成回归保留。Windows／POSIX 等平台专属跳过不计通过。

## 本轮验证

- 全文件语法检查：131 文件盘点，126 代码文件通过，没有语法错误或无效转义告警。
- Mac 关键源码门禁：Node 481 项通过；Python 123 项运行，122 通过、1 项 Windows 专属跳过。
- Mac 修改涉及的 native／Receiver JavaScript 检查：65 项通过，无跳过；真实只读 Hermes 与 Worker 源码快照参与，未访问生产接收端。
- 修改涉及的 Python 模块：205 项运行，201 通过、4 项平台专属跳过；包括真实 Hermes loader、Node actors、实例归属、操作控制和新的手工准入。
- 最终入口／布局／工作流／发布消费／复用检查：112 项通过，无失败或跳过。
- Windows 关键 JavaScript 回归：481 项运行，478 通过、3 项 POSIX chmod 检查跳过；Python 154 项运行，149 通过、5 项平台专属跳过，均无失败。
- Windows 前置／门禁用例：15 项通过；真实坏 PowerShell 路径被前置拒绝。最后的诊断与关闭顺序复核：42 项通过，没有新增测试目录。
- Mac 最后的 native／Receiver 关闭顺序复核：79 项通过，含实际 Hermes venv、原生 writer 和本地 Worker／D1；Python 跨平台夹具定向检查：21 项运行，20 通过、1 项 Linux 专属跳过。
- Mac 最后源码 Python 输入与诊断复核：42 项通过，显式测试 venv 优先于缺少依赖的通用 Python；Windows 对应 42 项也通过，测试前后没有残留测试目录。

完整门禁与最后的定向检查分别记录：完整运行后修改的输入选择、CLI 入口和生命周期 helper 按影响范围复核，不能把较早完整运行的源码摘要当作最后一版。Windows 的 5 项 Python 跳过分别是 POSIX 权限恢复、由真实 Windows 长路径检查代替的模拟路径限制、POSIX shell 包装、POSIX SIGTERM、Linux `/proc` 停止；符号链接检查已经实际执行。

原始日志、全文件清单和源码摘要位于 Git 忽略的 `artifacts/launcher-test-cleanup-20261012-1791784727/`。Windows 现场检查未发现本轮遗留进程；已删除之前迟到回调重建的两个诊断目录及本轮隔离 TMP 中的 PowerShell 探测文件，清理后 TMP 为空。复现日志和所需独立依赖保留，既有用户数据、其他修改和历史事故证据不作为垃圾删除。

本轮不包含新正式安装包验收、真实 MCP 样例导入、Mac App 自删除、Linux 产品停止或生产接收端部署。测试维护能够防止已发现的工具错误复发，不能保证未来新增测试或环境变更永远无错误。

后续产品收敛已修正 PowerShell 查询错误时读取缺失 stdout 的缺陷：未知结果返回 `UNINSTALL_PARENT_UNCONFIRMED`、保留原 cause 并阻止删除；Mac／Windows 源码卸载检查通过。此项属于产品代码加固，不能反推所有历史用户卸载事故的原因。默认 Node 与本地失效依赖链接也已对齐。[产品收敛对账](launcher-product-convergence.md) 记录最新证据；正式制品用户流程与公网间歇超时仍为放行阻断。
