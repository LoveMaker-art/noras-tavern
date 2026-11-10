# 核心测试与验收导航

源码入口为 `node tooling/checks/verify-core.mjs`，前置条件见根 CONTRIBUTING.md。共享执行输入先按锁获取；不能用相邻源码副本补缺失输入。

| 范围 | 当前入口 |
| --- | --- |
| 固定输入与源码归属 | tests/core/*.test.mjs |
| 核心版本与下载 | core_releases、core_network_policy |
| 独立核心任务 | core_operation_cli、updater_task_capability、updater_process_identity |
| 状态、授权、证据与锁 | core_operation_state、core_operation_policy、core_operation_inspection；native用core_operation_lock |
| 首装与模型 | test_first_install、test_first_install_transaction、test_model_candidate_commit、core_model_config |
| Nora配置与资料 | test_nora_system、test_nora_profile |
| 无窗口的核心部署/更新 | test_standalone_update_entry、test_standalone_update_recovery、test_cloud_instance_paths、test_cloud_lifecycle_cli |
| 子进程夹具生命周期 | core_fixture_lifecycle、test_core_fixture_lifecycle |
| 完整隔离产品 | core_product_refactor_smoke.cjs，给定实际core-payload |

源码合同、真实Hermes解释器、平台原生锁与权限、完整安装、真实模型及ClawChat分别举证。`--native`需要显式声明实际Hermes环境。跳过不是通过，维护子进程需实际close证明；未知关闭保留目录及原始原因。

全机进程检查按主机串行运行。模板修复保留原断言与保护目标；核心不承担已经迁出的窗口、APP替换或桌面安装器测试。旧组合测试及原文保存在原修订09b9895和迁移归档中。
