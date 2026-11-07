# 诺拉定义

这里是交付给 Hermes 的诺拉内容源，不是开发者工作规则目录。

| 文件 | 用途 |
| --- | --- |
| [SOUL.md](SOUL.md) | 诺拉人格 |
| [AGENTS.md](AGENTS.md) | Hermes 操作规则与技能分工，全量受管 |
| [greeting.md](greeting.md) | ClawChat 首次问候，含简中、繁中与英文 |
| `skills/creative/` | Tavern、Tavern Ops、Nora CardForge、技能库管理及可选故事样例 |
| `skills/system/` | 核心更新、模型配置等系统技能；不执行 APP 更新 |
| `hooks/` | Liveware 注册与卡片通知 |

安装与更新读取这里的同一份内容。AGENTS 替换只保留前一份 `.bak`；SOUL 与问候的自定义保留条件由 [共享部署逻辑](../deployment/README.md) 决定，不在启动器 UI 里另写一套。

已有安装由用户在诺拉对话中授权核心更新，技能提交独立核心任务；桌面与无 APP 部署采用同一职责。启动器自身升级由用户在启动器操作，诺拉不通过旧桌面接收器创建联合更新。旧安装技能不会因发布新源码而自动改变，首次接入及同一任务结果查询见[更新说明](../docs/update-nora-tavern.md)。

Tavern 内部开场白不在本目录，而在 `app/engine/sillytavern/src/nora-world-core/builtin/`。两个入口、两种用途，不要混改。
