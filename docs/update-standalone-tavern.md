# 更新旧独立部署的酒馆

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [项目首页](../README.md)

**适用于已经安装酒馆及配套 Hermes 环境的更新。** 不要求桌面启动器打开，也可核验带桌面安装标记的原目录。不是空白电脑的首次安装流程，也不用于绕过损坏或未知的安装归属。

- 下载 DMG 或 EXE 安装的用户，可使用[启动器按钮或诺拉技能](update-nora-tavern.md#启动器完全版)，共用同一更新器。
- 通过 `git clone` 安装的用户，请使用[源码更新](install-tavern.md#更新源码版)。

## 更新前

确认安装位置，结束正在生成的对话，保留原目录和备份。本工具更新酒馆及其配套内容，不负责升级整个 Hermes 运行时。

以下命令用于安装主机的 Linux 或 macOS shell，**不要粘贴进 Windows PowerShell**。

这条路径不需要桌面启动器。诺拉也可以在原 Linux 主机执行同一更新入口。
旧技能报“缺少更新器模块”或要求启动器执行凭据时，不要安装桌面启动器、
删除任务记录或清空数据；改用下面的官方独立入口，让本次更新取得新版执行代码。
尚未发布的分支修复不会自动进入这条正式下载入口。

## 执行更新

默认安装位置：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

使用过自定义位置时，需要填写真实路径。下面两处路径是占位符，不可原样执行：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm --hermes-home "/absolute/path/to/hermes" --install-root "/absolute/path/to/tavern"
```

更新器会识别可迁移的旧安装，检查发布文件并创建备份。不要在执行期间关机或移动目录。

Linux 原生 2.x 更新会先在临时目录准备并核对新版依赖，成功后才停止原服务和替换程序。
依赖准备失败时，原程序和数据保留。旧 Python 版是否可迁移还取决于原服务归属与数据格式；
不能把原生 2.x 的验收结果当作所有 1.x 部署均已兼容。

## 更新后

1. 保留返回的任务编号。`selecting`、`downloading`、`applying` 等状态表示仍在执行；提交命令返回零不代表更新已成功。
2. 诺拉重新连接后查询上次更新结果，确认同一任务为 `succeeded`、版本正确且 `systemReady: true`。仅在提示需要时重开相应会话。
3. 打开酒馆，检查原有世界、会话和模型配置；使用诺拉时，再检查 IM 对话及应用入口。

`partial` 表示有数据仍待迁移，不等于全部迁移完成。失败时保留提示与现场，不要删除重装。

如果输出表示上次失败事务已恢复，先确认旧版能打开且数据仍在。这次任务的结果是“恢复”，
还没有升级；随后再次明确执行更新。不要在恢复尚未确认时覆盖安装目录。

备份位于 `<酒馆安装目录>/tavern-backups/`，可能包含模型 Key 和私人会话。不要直接上传整个备份目录。

## 自定义文件提醒

`AGENTS.md` 由项目全量管理；自定义开场白等文件按各自规则处理。修改过相关配置时，更新前先查看[配置文件管理说明](launcher-managed-files.md)与[部署职责](../deployment/README.md)。

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [提交脱敏后的问题反馈](https://github.com/LoveMaker-art/noras-tavern/issues)
