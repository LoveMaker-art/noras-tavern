# 构建工具

- `source-layout.json`：源码路径到现有交付路径的唯一映射。
- `layout.mjs`：映射、路径冲突与缺失检查，不包含安装业务。
- `run.mjs`：从源码生成临时交付布局后运行开发命令，结束清理自身导出目录。
- `release/`：发布源码导出、平台运行时封装、系统清单与最终资产校验。
- `runtime/`：ClawChat 固定来源、构建审核和包内组件检查。
- `checks/`：架构、兼容性、工作流、索引与运行指标检查。

`release/package-release.mjs` 直接从 Git 源码构建；`checks/index-project.mjs` 直接索引当前源码，输出到忽略的 `.codebase-memory/project-index.json`。其他依赖交付相对路径的内部命令通过 `run.mjs` 运行。完整命令见 [开发说明](../CONTRIBUTING.md)。

映射只改变导出位置，不改写人格、提示词、业务代码或图片。已有发布包使用的旧文件名、模块名、安装目录继续有效。新增交付文件须检查映射、发布白名单、完整组件清单及对应测试。

## 核心流水线

`checks/core-source-gate.mjs` 串行运行备份安全、固定输入/发行合同、全部保留的核心消费者及酒馆工作流。源码环境与实际Hermes环境分别验证；`checks/verify-core.mjs --native` 必须选择已恢复的实际解释器及只读Hermes源码，不能以小型源码venv替代。

`release/build-core.mjs` 要求干净提交及通过的同提交源码记录，消费 `runtime/runtime-inputs.lock.json` 的固定运行环境，完成实际隔离首装、配置、服务和原生执行者验收。失败保留原始原因；确认停止和执行者关闭后才清理测试目录。

`release/assemble-core.mjs` 只组装同提交、同输入且全部平台通过的原字节；`release/publish-release.mjs` 再校验这些字节及包内实际核心消费者。发布状态与不可变文件摘要独立封存，恢复不能换来源、换实物或盲目覆盖未知上传结果。

自动化定义见 `.github/workflows/core-ci.yml`、`core-build.yml`、`core-publish.yml`；授权、实际平台/历史迁移补验及发布重试见[核心发布流程](../docs/release-process.md)。源码、原生、远端工作流与实际发布分别举证。
