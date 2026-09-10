# 构建工具

- `source-layout.json`：源码路径到现有交付路径的唯一映射。
- `layout.mjs`：映射、路径冲突与缺失检查，不包含安装业务。
- `run.mjs`：从源码生成临时交付布局后运行开发命令，结束清理自身导出目录。
- `release/`：发布源码导出、平台运行时封装、系统清单与最终资产校验。
- `runtime/`：ClawChat 固定来源、构建审核和包内组件检查。
- `checks/`：架构、兼容性、工作流、索引与运行指标检查。

`release/package-release.mjs` 直接从 Git 源码构建；`checks/index-project.mjs` 直接索引当前源码，输出到忽略的 `.codebase-memory/project-index.json`。其他依赖交付相对路径的内部命令通过 `run.mjs` 运行。完整命令见 [开发说明](../CONTRIBUTING.md)。

映射只改变导出位置，不改写人格、提示词、业务代码或图片。已有发布包使用的旧文件名、模块名、安装目录继续有效。新增交付文件须检查映射、发布白名单、完整组件清单及对应测试。
