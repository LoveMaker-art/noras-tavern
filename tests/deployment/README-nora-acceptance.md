# Nora 安装验收记录

## 2026-09-08 资料同步修复

- 只读检查参考机器：`clawchat/greeting.md` 原本要求模型在首次问候前设置昵称和指定的公开头像；本地简短问候模板缺少这段要求。
- 启动器现由程序在配对后、启动 gateway 前同步名字和头像，并通过服务端读回验证。中文使用「诺拉」，其他语言使用「Nora」；头像沿用参考机器的公开图片 URL。
- 成功记录与当前配对账号绑定。重复启动保留用户后续修改；换账号重新初始化。同步失败保留配对，不重放一次性配对码，也不标记启动检查完成。
- 使用本地整合包的真实 ClawChat API 客户端对本地模拟 HTTP 服务完成初始化、读取验证、重复启动测试。未调用真实 ClawChat 写接口，未计作手机端头像显示验收。
- 版本检查区分「发现更高发布版本」与「完整包可安装」；平台组件缺失时显示阻塞状态，不再误报可用更新。
- 21 项 Python 检查、15 项 Node 检查通过。此次为源码验证，尚未替换用户桌面测试应用或修改测试账号。

## 2026-09-07 安装验证

2026-09-07，本机 macOS arm64。

补充桌面验收：已生成独立本地候选 `.app`，通过真实界面点击安装、Nora 完整性检查和 MCP 读取，
自动进入模型配置；停止并重开仍停在模型配置，不重复安装。修复了首次打开借用系统 Python、
因缺少 yaml 而阻塞安装入口的问题。该桌面验收通过，未使用模型 Key 或 ClawChat 配对信息。

## 已验证

- 从新生成的候选发布包，在独立临时目录解压真实 Hermes、Python、Node.js、ClawChat、Liveware 和酒馆。
- Hermes 加载 Nora SOUL、AGENTS、四组 Nora 技能及 ClawChat 技能；通过 Hermes Hook loader 加载启动 Hook。
- 实际注册 ClawChat 插件并检查工具、Hook、Liveware 可执行文件。
- 通过真实 MCP stdio 请求读取本次安装的酒馆实例，使用随机非默认端口。
- 通过 Hermes cron 执行器实际执行 Python 更新检查脚本；版本源使用本地测试文件，不访问模型或发送消息。
- 未配置模型、未配对时 setupCompleted 为 false；测试结束后停止并删除临时实例。
- 回归覆盖配置及任务回滚、Key 保留、托管组件损坏、任务重复和禁用、端口传递、发布漏文件、版本判断与下载校验。

## 尚未验证或交付

- Windows x64、macOS Intel 的真机安装与账户流程；CI 配置不是已通过的运行结果。
- 用户模型响应、手机收到 Nora 问候、手机 Liveware 访问和定时通知送达。
- 整套 Hermes 跨版本迁移及启动器自更新，当前禁止用旧 Tavern 更新器替代。
- GitHub 最新正式发布的完整平台资产。实时检查 v2.2.8 缺少 nora-system-darwin-arm64.json，安装前会报错，不降级使用旧嵌入包。
- 当前用户测试应用未替换，现有测试 Key、配对信息及主酒馆未修改。

## 重复执行

在提供 Node 和测试 Python 的环境中，从仓库根目录执行：

```sh
python3 -B -m unittest ops.tests.test_nora_instance ops.tests.test_nora_system ops.tests.test_first_install ops.tests.test_update_check ops.tests.test_liveware_cache_release ops.tests.test_launcher_services
node --test ops/tests/launcher_releases.test.cjs ops/tests/launcher_bundle_contract.test.cjs ops/tests/launcher_runtime.test.cjs
node ops/tests/launcher_bundle_smoke.cjs <候选目录>/nora-tavern-launcher/payload
```

UI 布局未修改。此前控制器测试因未配置 Playwright 路径未运行；后续使用已配置的 Playwright
完成上述打包应用端到端测试。未将账户配对和实际模型对话计作已通过。
