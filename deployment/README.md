# 核心部署与维护

- install：核心首次安装、固定发布来源与首次安装事务。
- update：独立核心任务、程序替换、迁移、验证与恢复。
- runtime：运行、实例定位、Nora内容/技能部署与更新检查。
- shared：核心模型、配置、服务、Liveware和实例规则。

共享执行资源由固定外部输入提供，不在本仓复制维护。运行源码使用 `tooling/run.mjs` 的投影；安装布局兼容现有核心版本。维护范围不包含用户目录和凭据。详见[开发指南](../CONTRIBUTING.md)和[核心维护](../docs/core-maintenance.md)。
