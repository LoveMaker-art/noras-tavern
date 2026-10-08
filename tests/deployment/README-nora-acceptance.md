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

辅助文件 `launcher_owned_test_actor.cjs` 与 `launcher_operation_test_lock.cjs` 被现有测试引用，承担真实受管执行，不属于可按名称删除的重复测试。普通单元测试、native actor、实际 GUI 和生产入库分别报告。

## 从源码运行

交付相对导入通过唯一映射生成，统一从仓库根运行：

```sh
node tooling/run.mjs node --test tests/deployment/launcher_operation_result.test.cjs tests/deployment/launcher_guidance_flow.test.cjs
node tooling/run.mjs python -B -m unittest tests.deployment.test_first_install_transaction tests.deployment.test_update_operation_safety
```

依赖和隔离 native 输入见 [开发说明](../../CONTRIBUTING.md)。不要直接运行不存在的源码 `ops/tests/`，不要在用户安装目录修补代码。

完整流程需已冻结且平台匹配的真实 payload：

```sh
node tooling/run.mjs node tests/deployment/launcher_product_refactor_smoke.cjs --payload /absolute/path/to/candidate/payload --scratch-base /absolute/path/to/disposable-test-root --keep
```

入口创建隔离实例并运行真实程序，执行前登记候选身份、平台和实例。重用实例读取 receipt 端口和运行事实；测试在失败分支也必须结束自己的 APP、驱动和受管服务。清理失败先停止该轮，不启动第二个候选。

真实模型/ClawChat、Windows NSIS 覆盖更换、Intel 主机和接收端原操作查询是独立验收项。正式数据、密钥和真实用户事件均不作为可删除 fixture。
