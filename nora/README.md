# 诺拉定义

这里是交付给 Hermes 的诺拉内容源，不是开发者工作规则目录。

| 文件 | 用途 |
| --- | --- |
| [SOUL.md](SOUL.md) | 诺拉人格 |
| [AGENTS.md](AGENTS.md) | Hermes 操作规则与技能分工，全量受管 |
| [greeting.md](greeting.md) | ClawChat 首次问候，含简中、繁中与英文 |
| `skills/creative/` | Tavern、Tavern Ops、Nora CardForge 及可选故事样例 |
| `skills/system/` | 更新技能，区分启动器系统与独立酒馆 |
| `hooks/` | Liveware 注册与卡片通知 |

安装与更新读取这里的同一份内容。AGENTS 替换只保留前一份 `.bak`；SOUL 与问候的自定义保留条件由 [共享部署逻辑](../deployment/README.md) 决定，不在启动器 UI 里另写一套。

Tavern 内部开场白不在本目录，而在 `app/engine/sillytavern/src/nora-world-core/builtin/`。两个入口、两种用途，不要混改。
