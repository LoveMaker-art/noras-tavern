# 受管内容的部署写者

本页供[诺拉运行内容](../nora/README.md)定位部署实现。产品保护要求唯一维护于[受管内容规则](../docs/product/nora.md#managed-content)，目录归属见[仓库结构](../docs/REPOSITORY.md)；这里不再复制目录地图或安装步骤。

| 写入对象 | 实现入口 | 调用方必须知道的事实 |
| --- | --- | --- |
| 完整AGENTS文档 | `shared/managed_context.py::install_agents` | 拒绝空文档/旧片段；内容相同不重写，变化前保存上一份`.bak`；事务快照和恢复由调用方负责 |
| 首次问候及实例脚本 | `shared/managed_context.py::prepare_greeting` | 根据模板及现有收据准备受管替换；自定义问候保留，模板进入示例；返回准备好的交换项而非声称已提交 |
| 管理配置与首装证明 | `shared/nora_system.py::prepare_managed`、`configure_managed` | 结合实例、MCP和问候配置；文件准备、实际提交和运行证明是不同阶段 |
| 首装模板及核心事务 | `install/first_install.py`、`update/` | 按现行保护规则处理SOUL/既有内容，不能因为发布模板变化就覆盖用户人格 |

共享执行输入及投影只从[固定维护合同](../docs/core-maintenance.md)取得；不要修改安装实例、解包缓存或生成视图来替代作者源码。该说明不授权部署、服务启停或用户目录写入。
