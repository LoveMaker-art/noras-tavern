# 启动器测试导航

唯一执行范围、验收和阶段状态见 [可靠性交付方案](../../docs/launcher-reliability-plan.md)。本文件只索引既有测试入口，不另维护“已通过”清单。过期验收说明与临时脚本已删除；必要技术报告保留其原候选和场景身份，不能代替当前候选证据。

## 选择测试

修改哪个职责，先运行对应现有合同测试；出现通过范围外的问题，再扩展关联检查。不要因为整理文档就运行所有平台完整流程，也不要以测试数证明完成。

| 主题 | 入口示例 |
| --- | --- |
| 操作、结果与失败次数 | `launcher_operation_state.test.cjs`、`launcher_operation_result.test.cjs`、`launcher_retry_conditions.test.cjs` |
| 原生锁、委托与关闭 | `launcher_operation_lock.test.cjs`、`launcher_operation_inspection.test.cjs`、`test_operation_control.py` |
| 首装、更新与恢复 | `launcher_runtime_transaction.test.cjs`、`launcher_update_executor.test.cjs`、`test_first_install_transaction.py`、`test_update_operation_safety.py` |
| 版本、来源与下载 | `launcher_release_plan.test.cjs`、`launcher_network_policy.test.cjs`、`launcher_network.test.cjs` |
| 日志、故障包和投递 | `launcher_diagnostics_operation.test.cjs`、`launcher_evidence_store.test.cjs`、`launcher_fault_packet.test.cjs`、`launcher_telemetry.test.cjs`、`launcher_telemetry_worker.test.cjs` |
| 引导、进度与界面 | `launcher_guidance_flow.test.cjs`、`launcher_task_progress.test.cjs`、`launcher_controller.test.cjs` |
| 真实程序流程 | `launcher_product_refactor_smoke.cjs`：实际 native lease、受管生产者与临时安装；不是完整 GUI/真实账户验收 |
| 打包 APP | `launcher_packaged_app.test.cjs`、`verify_launcher_package.cjs`：实际 Electron/ASAR/资源核验；缺输入或 skip 不算通过 |
| Mac 打包 GUI 安装 | `launcher_packaged_install.test.cjs`：真实候选应用点击安装、停止及重开；当前路径与候选端口合同仅适用于 macOS |
| 平台手工检查 | `uninstall-mac-smoke.cjs`：临时 Electron 副本自删除；`uninstall-nsis-fixture.nsi`：真实 Windows 卸载 hook 的编译检查 |
| 可选样例真实 MCP | `verify_starter_stories.py`：在成功保留的隔离产品实例中暂存、导入、读回及验证重试幂等；准入测试不代表此流程已经执行 |

辅助文件 `launcher_owned_test_actor.cjs` 使用真实 native lease，并检查受管执行者 ACK 和关闭；`launcher_operation_test_lock.cjs` 是内存中的单元锁适配器，用于操作提交合同，不证明原生锁或真实进程归属。两者均被现有测试引用，承担不同职责。普通单元测试、native actor、实际 GUI 和生产入库分别报告。

## 从源码运行

交付相对导入通过唯一映射生成，统一从仓库根运行：

```sh
node "$PWD/tooling/checks/launcher-test-environment.mjs" source
node "$PWD/tooling/run.mjs" node --test tests/deployment/launcher_operation_result.test.cjs tests/deployment/launcher_guidance_flow.test.cjs
node "$PWD/tooling/run.mjs" python -B -m unittest tests.deployment.test_first_install_transaction tests.deployment.test_update_operation_safety
```

依赖和隔离 native 输入见 [开发说明](../../CONTRIBUTING.md)。完整源码门禁的 TLS fixture 需要 PATH 中的实际 OpenSSL／Mac LibreSSL，缺少工具应先由前置检查返回 exit 2。不要直接运行不存在的源码 `ops/tests/`，不要在用户安装目录修补代码。

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
