# 更新旧独立部署的酒馆

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [项目首页](../README.md)

**仅适用于以前通过独立部署脚本安装、未由启动器管理完整环境的酒馆。** 不是空白电脑的首次安装流程。

- 下载 DMG 或 EXE 安装的用户，请使用[启动器更新](update-nora-tavern.md#启动器完全版)。
- 通过 `git clone` 安装的用户，请使用[源码更新](install-tavern.md#更新源码版)。

## 更新前

确认安装位置，结束正在生成的对话，保留原目录和备份。本工具更新酒馆及其配套内容，不负责升级整个 Hermes 运行时。

以下命令用于安装主机的 macOS / shell 环境，**不要粘贴进 Windows PowerShell**。

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

## 更新后

1. 确认输出为 `status: installed`。
2. 重启相应 Hermes 会话，让新配置生效。
3. 打开酒馆，检查原有世界、会话和模型配置；使用诺拉时，再检查 IM 对话及应用入口。

`partial` 表示有数据仍待迁移，不等于全部迁移完成。失败时保留提示与现场，不要删除重装。

备份位于 `<酒馆安装目录>/tavern-backups/`，可能包含模型 Key 和私人会话。不要直接上传整个备份目录。

## 自定义文件提醒

`AGENTS.md` 由项目全量管理；自定义开场白等文件按各自规则处理。修改过相关配置时，更新前先查看[配置文件管理说明](launcher-managed-files.md)与[部署职责](../deployment/README.md)。

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [提交脱敏后的问题反馈](https://github.com/LoveMaker-art/noras-tavern/issues)
