# 安装诺拉与酒馆核心

诺拉运行于 Hermes，酒馆提供角色扮演应用，MCP连接两者。仅使用酒馆时见[酒馆安装](install-tavern.md)。

## 核心安装入口

核心首装实现位于 `deployment/install/`，包括 POSIX 和 Windows PowerShell 入口，以及固定发布来源、摘要校验、首次安装事务与恢复。使用已发布的适用核心资产；源码开发和隔离验收见 [CONTRIBUTING](../CONTRIBUTING.md)。

安装前明确本实例 Nora、Hermes、Tavern 目录和端口，避免选择已有无关安装。先验证支持平台及完整环境输入，再执行首装。设置模型后先验证再保存，完成 ClawChat 配对及 Liveware 入口核验；本地服务健康不等于远程入口已经连接。

<a id="linux-cloud-installation"></a>
<a id="installation-location"></a>
## 部署和数据

Windows、macOS与Linux/云端按适用能力分别验收。源码酒馆启动不要求Hermes；完整诺拉集成须满足Hermes、Node、Python、MCP、技能和连接依赖。缺少某平台实测不视为该平台已验收。

用户配置、密钥、故事和会话位于实例数据目录，不属于安装资产。失败时保留原始原因和恢复记录；不要删除数据目录来绕过未确认的安装状态。
