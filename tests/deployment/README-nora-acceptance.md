# 启动器测试导航

唯一执行范围、验收和阶段状态见 [可靠性交付方案](../../docs/launcher-reliability-plan.md)。本文件只索引既有测试入口，不另维护“已通过”清单。只有确认调用已迁移、没有剩余用途的过期说明和脚本才删除；必要技术报告保留其原候选和场景身份，不能代替当前候选证据。

## 选择测试

修改哪个职责，先运行对应现有合同测试；出现通过范围外的问题，再扩展关联检查。不要因为整理文档就运行所有平台完整流程，也不要以测试数证明完成。

| 主题 | 入口示例 |
| --- | --- |
| 操作、结果与失败次数 | `launcher_operation_state.test.cjs`、`launcher_operation_result.test.cjs`、`launcher_retry_conditions.test.cjs`、`launcher_pair_retry.test.cjs` |
| 原生锁、委托与关闭 | `launcher_operation_lock.test.cjs`、`launcher_operation_inspection.test.cjs`、`test_operation_control.py` |
| 首装、更新与恢复 | `launcher_runtime_transaction.test.cjs`、`launcher_update_executor.test.cjs`、`test_first_install_transaction.py`、`test_update_operation_safety.py` |
| 保留数据重装复制 | `launcher_runtime.test.cjs` 的私人文件、归属与并发变化检查；`launcher_runtime_transaction.test.cjs` 的真实提交／恢复；`launcher_retained_copy_electron.test.cjs` 的物理 ASAR 与 Windows 缓存 junction。最终 APP 门禁自动调用最后一项，不能以 Node 结果代替 Electron 结果 |
| 独立部署更新 | `test_standalone_update_entry.py`、`test_standalone_update_recovery.py`、`test_update_dependency_materialization.py`：单文件入口、无桌面凭据执行、Linux staging 依赖准备与拒绝边界、持久恢复、设置备份轮换与再次中断；不替代旧安装实测 |
| 版本、来源与下载 | `launcher_release_plan.test.cjs`、`launcher_network_policy.test.cjs`、`launcher_network.test.cjs` |
| 日志、故障包和投递 | `launcher_diagnostics_operation.test.cjs`、`launcher_evidence_store.test.cjs`、`launcher_fault_packet.test.cjs`、`launcher_telemetry.test.cjs`、`launcher_telemetry_worker.test.cjs` |
| 引导、进度与界面 | `launcher_guidance_flow.test.cjs`、`launcher_task_progress.test.cjs`、`launcher_controller.test.cjs` |
| 原生配对重试界面 | `launcher_pair_ui_electron.cjs`：生产 HTML/preload/controller 与原生锁，激活回复和服务状态受控；不连接外部 ClawChat，不证明真实账号激活或网关调用 |
| 真实程序流程 | `launcher_product_refactor_smoke.cjs`：实际 native lease、受管生产者与临时安装；不是完整 GUI/真实账户验收 |
| 打包 APP | `launcher_packaged_app.test.cjs`、`verify_launcher_package.cjs`：实际 Electron/ASAR/资源核验；缺输入或 skip 不算通过 |
| Mac 打包 GUI 安装 | `launcher_packaged_install.test.cjs`：真实候选应用点击安装、停止及重开；当前路径与候选端口合同仅适用于 macOS |
| 平台手工检查 | `uninstall-mac-smoke.cjs`：临时 Electron 副本自删除；`uninstall-nsis-fixture.nsi`：真实 Windows 卸载 hook 的编译检查 |
| 可选样例真实 MCP | `verify_starter_stories.py`：在成功保留的隔离产品实例中暂存、导入、读回及验证重试幂等；准入测试不代表此流程已经执行 |

辅助文件 `launcher_owned_test_actor.cjs` 使用真实 native lease，并检查受管执行者 ACK 和关闭；`launcher_operation_test_lock.cjs` 是内存中的单元锁适配器，用于操作提交合同，不证明原生锁或真实进程归属。两者均被现有测试引用，承担不同职责。普通单元测试、native actor、实际 GUI 和生产入库分别报告。

## 夹具维护与清理

修改下载协议、来源配置或操作协议时，同时核对完整 CI 命令、间接调用的测试辅助文件及本轮实际使用的私有验收驱动。静态搜索只能生成清单，不能代替逐项确认用途和执行结果。

- 当前协议夹具必须按构建配置中的完整物理 URL 返回响应，并绑定实际响应 URL；不要只按文件名接受任意地址。
- 历史协议、拒绝非法输入及冻结版本样本必须标明用途并保留原版本身份。旧地址不等于过期代码；历史客户端不得用修改过的源码或 ASAR 代替。
- 原生子进程要在创建时保留句柄或 PID／出生身份。发出 kill、收到 exit／EOF、目录消失或等待固定时间，都不能代替实际 close 和受管进程离线证明。
- 就绪等待、取消、输出管道及下载子进程都需有限期限。无法确认关闭时，报验收失败并保留目录、原错误和关闭状态；不要继续下一轮或将未知结果写成通过。
- 不依赖完整 Hermes 的来源、发布和历史兼容合同放在昂贵的运行时准备前。夹具修复保留原校验断言，必须验证故障分支及正常分支，不能用删除测试或放宽来源／校验规则消除报错。

清理结果按文件记录保留、修复、移除及验证证据。单组通过不代表整个清单清理完成；旧候选的通过报告不能直接转为当前安装包的验收结论。

## 从源码运行

交付相对导入通过唯一映射生成，统一从仓库根运行：

```sh
node "$PWD/tooling/checks/launcher-test-environment.mjs" source
node "$PWD/tooling/run.mjs" node --test tests/deployment/launcher_operation_result.test.cjs tests/deployment/launcher_guidance_flow.test.cjs
node "$PWD/tooling/run.mjs" python -B -m unittest tests.deployment.test_first_install_transaction tests.deployment.test_update_operation_safety
```

依赖和隔离 native 输入见 [开发说明](../../CONTRIBUTING.md)。完整源码门禁的 TLS fixture 需要 PATH 中的实际 OpenSSL／Mac LibreSSL，缺少工具应先由前置检查返回 exit 2。不要直接运行不存在的源码 `ops/tests/`，不要在用户安装目录修补代码。

配对重试原生界面检查使用锁文件固定的 Electron 38.8.6、完整桌面依赖和新的隔离证据目录。顺序执行两阶段：第一阶段触发两次受控激活失败并关闭；第二阶段重开同一目录，等待真实倒计时结束后提交新输入并确认任务成功。Windows 需在已登录用户的交互会话执行。不要用正式用户安装目录作为证据目录。

```sh
node "$PWD/tooling/run.mjs" /absolute/path/to/electron tests/deployment/launcher_pair_ui_electron.cjs --proof-root /absolute/path/to/new-isolated-proof --phase 1
node "$PWD/tooling/run.mjs" /absolute/path/to/electron tests/deployment/launcher_pair_ui_electron.cjs --proof-root /absolute/path/to/new-isolated-proof --phase 2
```

完整流程需已冻结且平台匹配的真实 payload：

```sh
node "$PWD/tooling/run.mjs" node tests/deployment/launcher_product_refactor_smoke.cjs --payload /absolute/path/to/candidate/payload --scratch-base /absolute/path/to/disposable-test-root --keep
```

入口创建隔离实例并运行真实程序，执行前登记候选身份、平台和实例。重用实例读取 receipt 端口和运行事实；测试在失败分支也必须结束自己的 APP、驱动和受管服务。清理失败先停止该轮，不启动第二个候选。

Mac 打包 GUI 安装检查需要 Playwright，以及明确标识的本地候选 APP 绝对可执行路径 `NORA_PACKAGED_APP` 和其元数据中的 `NORA_TEST_BUILD_ID`；缺少输入时会 skip。此入口要求 `~/Library/NoraTavern-Tests/launcher-<buildId>` 尚不存在，并实际写入、启动该隔离实例，不用于正式安装或 Beta 共用目录。`NORA_SCREENSHOT` 可指定截图输出路径。

```sh
NORA_PACKAGED_APP=/absolute/path/to/candidate.app/Contents/MacOS/executable NORA_TEST_BUILD_ID=candidate-build-id node "$PWD/tooling/run.mjs" node --test tests/deployment/launcher_packaged_install.test.cjs
node "$PWD/tooling/run.mjs" node tests/deployment/uninstall-mac-smoke.cjs
```

Mac 卸载检查只复制测试依赖里的 Electron 到一次性目录，等待自己的 helper 关闭后再清理该目录；核验 ALL 保留的 owner／writer lock 外壳和应用副本移除。它不证明正式候选 APP 或 Windows NSIS 卸载已验收。

可选样例 MCP 检查要求完整 product smoke 使用 `--keep`，并将 `--scratch-base` 指向当前平台的保留区：Mac `~/Library/NoraTavern-Tests`，Windows `%LOCALAPPDATA%/NoraTavern-Tests`。随后明确传入其 `products-smoke-XXXXXX` 根目录：

```sh
HERMES_HOME=/absolute/path/to/NoraTavern-Tests/products-smoke-XXXXXX/hermes NORA_TAVERN_HOME=/absolute/path/to/NoraTavern-Tests/products-smoke-XXXXXX TAVERN_DATA_ROOT=/absolute/path/to/NoraTavern-Tests/products-smoke-XXXXXX/tavern node "$PWD/tooling/run.mjs" python -B tests/deployment/verify_starter_stories.py --fixture-root /absolute/path/to/NoraTavern-Tests/products-smoke-XXXXXX
```

该入口核对物理目录、同实例三个根目录、端口、成功且保留的 `harness-result.json`，以及 MCP 的本地端口、状态目录、写入绑定和本实例 Node/server 入口；拒绝链接与普通用户安装。准入失败不会暂存样例或启动 MCP。该流程会向隔离酒馆导入两则样例，执行前应确认这是保留的测试实例。

真实模型/ClawChat、Windows NSIS 覆盖更换、Intel 主机和接收端原操作查询是独立验收项。正式数据、密钥和真实用户事件均不作为可删除 fixture。
