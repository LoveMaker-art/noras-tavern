# 更新 Nora Tavern

先确认你使用哪一种安装方式。**启动器整合安装与单独安装酒馆，不能混用更新入口。**

## 用启动器安装的完全版

macOS 和 Windows 都从启动器中查看版本并执行更新。它更新的是启动器所管理的完整本地 Nora 系统，不仅是酒馆页面：

- Hermes 与发布包配套的 Python、Node.js、ClawChat 运行组件。
- 诺拉的人格、AGENTS、开场白、技能、Hook 和受管任务配置。
- Tavern、内置 Story Profile 与 Nora MCP。

启动器先核对目标版本及本平台完整组件，再停止相关服务、备份、替换、验证；失败时尝试回滚。缺少本平台组件、校验不符或启动器版本过旧时，会阻止更新，不能当作更新成功。

用户数据和模型 Key 不随发布包分发。更新保留本机用户状态，但项目受管文件按版本维护：`AGENTS.md` 全量替换，只保留前一份 `.bak`。不要把需要长期保留的私人内容写进项目受管文件。

### 启动器本身是另一层

完整系统更新不等于替换桌面应用。如果提示需要更新启动器，应下载对应系统的新启动器安装包，替换桌面应用，保留原来的 Nora 安装目录。不要为了更新而选择“完全卸载”或删除数据。

如果你使用过自选安装目录，保留该位置与安装记录，让新启动器识别原有安装。

## Git 源码安装的精简版

如果你按精简版文档 `git clone` 后运行 `npm start`，使用 [精简版文档中的源码更新流程](install-tavern.md)：停止服务、拉取源码、安装依赖、重新构建并启动。不要对源码检出直接运行部署更新器。

## 旧独立部署的酒馆

没有由启动器管理整个 Nora 系统的既有安装，使用单独酒馆更新器。它更新 Tavern、Story Profile 快照、Nora MCP，以及与酒馆有关的技能和配置；它不是 Hermes 运行时升级器，也不是空白电脑首次安装器。

macOS / shell 环境在实际安装主机执行：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

非默认目录应显式传入实际位置：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm --hermes-home "/absolute/path/to/hermes" --install-root "/absolute/path/to/tavern"
```

Windows 完全版请使用启动器，不要把上面的 shell 命令粘贴进 PowerShell。

单独更新器会识别旧 Python 安装并迁移可识别的数据；已有 2.x 安装按清单复用未变更模块和依赖。`AGENTS.md` 也是全量项目管控，不再是插入一小段托管块。自定义开场白的保留规则见 [部署职责](../deployment/README.md)。

执行成功后确认输出为 `status: installed`，再重启相应 Hermes 会话以载入新配置。`partial` 数据迁移表示有记录待处理，不等于所有旧内容都已经迁移成功。

## 更新前后

更新前结束正在生成的对话，保留安装目录，不要自行删掉缓存、备份或安装记录。

更新后检查酒馆可以打开、原有世界和会话仍在、模型配置可用；使用 Nora 时再检查 ClawChat 与应用入口。

失败时保留错误提示和日志，不要反复删除重装：

- 完全版事务目录：`<安装根目录>/installer/system-update/`。
- 单独酒馆备份：`<酒馆安装目录>/tavern-backups/`。

这些备份可能含 Key 和个人会话，**不要直接上传整个目录**。分享经过脱敏的错误日志即可。恢复失败时先保留现场，不能把“尝试回滚”当作“已恢复成功”。

首次安装见 [完全版](install-nora-tavern.md) / [精简版](install-tavern.md)。开发者见 [仓库导航](REPOSITORY.md)。
