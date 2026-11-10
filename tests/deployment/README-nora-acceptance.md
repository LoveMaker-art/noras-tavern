# 核心测试与验收导航

源码入口为 `node tooling/checks/verify-core.mjs`，前置条件见根 CONTRIBUTING.md。共享执行输入先按锁获取；不能用相邻源码副本补缺失输入。

| 范围 | 当前入口 |
| --- | --- |
| 固定输入与源码归属 | tests/core/*.test.mjs |
| 核心版本与下载 | core_releases、core_network_policy |
| 独立核心任务 | core_operation_cli、updater_task_capability、updater_process_identity |
| 状态、授权、证据与锁 | core_operation_state、core_operation_policy、core_operation_inspection；native用core_operation_lock |
| 首装与模型 | test_first_install、test_first_install_transaction、test_model_candidate_commit、test_core_model_status、test_core_tavern_model |
| Nora配置与资料 | test_nora_system、test_nora_profile |
| 无窗口的核心部署/更新 | test_standalone_update_entry、test_standalone_update_recovery、test_cloud_instance_paths、test_cloud_lifecycle_cli |
| 子进程夹具生命周期 | core_fixture_lifecycle、test_core_fixture_lifecycle |
| 完整隔离产品 | core_product_refactor_smoke.cjs，给定实际core-payload |
| 世界与会话升级校验 | updater_worlds.test.mjs，与部署CJS一起进入默认源码检查 |
| 核心技能状态 | core_update_skill_status、test_updater_skill_environment；不运行桌面请求接收器 |
| MCP与Story Profile | 完整源码门禁分别运行MCP单元／集成及story-profile/tests的Python集合 |

源码合同、真实Hermes解释器、平台原生锁与权限、完整安装、真实模型及ClawChat分别举证。`--native`需要显式声明实际Hermes环境。跳过不是通过，维护子进程需实际close证明；未知关闭保留目录及原始原因。

全机进程检查按主机串行运行。模板修复保留原断言与保护目标；核心不承担已经迁出的窗口、APP替换或桌面安装器测试。旧组合测试及原文保存在原修订09b9895和迁移归档中。

模型HTTP适配器、APP发现、APP提交／恢复及桌面技能接收器的专属用例由外部作者维护。核心保留旧发布元数据到原核心的解析、固定目标与摘要保护、共享写锁、拒绝接管APP交接任务及独立更新不查询APP目录的消费者合同。发布测试只推进一个核心渠道，继续覆盖CAS冲突、响应丢失后的核验／续跑和诊断脱敏。

原混合文件中恢复的112条核心用例见`restored-core-protections.json`：记录原文件、原始摘要、保留方法和未恢复的桌面用例。恢复活动入口不代表本轮已经运行，也不等于恢复整份旧桌面测试。

可选服务专项：在具备相应SDK/账号的已固定Hermes环境，显式运行 `test_nora_native_model`、`test_model_native_flows`、`test_model_native_probe`。它们的所有断言继续保留，缺前提和失败单列。基础原生profile仅覆盖实际解释器的锁与操作执行者；完整隔离产品另外执行既定的本地模型保存/调用。
