# Nora MCP 接入 Hermes：远端部署记录

日期：2026-08-30。用户明确授权部署 Tavern 配套接口、Nora MCP 并接入若棠。

## 已部署

- Nora MCP 0.3.0：`/opt/data/apps/nora-mcp`，锁定依赖安装，不使用 npx 动态更新。
- Tavern：`/opt/data/apps/tavern-runtime`，本次精确更新26个文件；包含控制接口、页面执行器、Helper/MVU适配以及配套构建。基础库和其他分块哈希相同，未重复覆盖。
- Hermes：通过原生 `_save_mcp_server` 保存 `mcp_servers.nora`；stdio连接本机8799，不经过Liveware，不新增公网端口。
- operator模式，固定45工具白名单（30读、15写）；关闭MCP resources、prompts、sampling，并保持敏感写操作既有确认字段。
- Tavern通过现有生命周期管理重启。Hermes通过现有supervisord向服务发送USR1，使用原生等待在途任务的优雅重启流程加载工具；没有重建会话。

## 目标环境证据

- Tavern进程10760健康；实例身份指向`/opt/data/tavern-state/native/default-user`，控制目录37个动作。
- `hermes mcp test nora`连接成功（221ms），实际发现45个工具。
- 使用Hermes真实注册器、平台工具集解析、stdio传输调用11个只读工具成功：状态、世界列表、控制目录、在线页面、MVU模型配置、扩展、正则、Story Profile、世界详情、账本状态、聊天读取。
- 世界列表5个；实际读取其中1个世界的聊天窗口及账本状态。验证前后27个受保护数据文件哈希一致。
- Hermes新进程10899处于running，ClawChat connected；其watchdog10950持有实际Nora MCP进程10951，而非仅在独立CLI测试中启动。
- 重启后Hermes配置与备份比较，仅增加nora服务器，其他配置语义完全相同。
- 首页资源版本`6eb2d737065fb762`；通过实际HTTP读取entry及inline manifest，哈希均等于本次部署文件。
- 未触发模型调用、生成、脚本执行或用户数据迁移。

## 未宣称验收的部分

验收时在线Tavern控制页面数量为0。后端查询不要求打开页面；MVU、Helper脚本和按钮等浏览器运行控制，需要打开/刷新Tavern并进入目标世界。此次未操作浏览器，也未让若棠通过真实对话执行写动作，因此不声称37个页面动作已全部完成用户流程验收。

远端tavern-ops技能仍引用当前CLI已不存在的doctor命令；本次按其数据保护和生命周期约束执行，但改用当前HTTP健康检查。技能修订不在本次部署范围，未修改任何技能。

## 备份与记录

本次私有备份目录：`/opt/data/deployments/nora-mcp-20260830.Qj4awr`。

- `runtime-before.tar.gz`：受影响源码、托管扩展和原引擎配置，约4.8MiB，权限600。
- `hermes-config.before.yaml`：Hermes原配置，权限600，可能含凭据，禁止公开。
- `manifest.json`：精确文件清单及前后哈希。
- `deployment-result.json`、`hermes-verification.json`、`host-verification.json`：部署、真实只读调用和宿主验收结果。

未提交Git；未更改Liveware注册。后续部署必须同时携带同级nora-mcp包及Tavern配套代码，不能仅部署其中一侧。
