# 启动器卸载验证记录

这是开发与发布记录，不是用户指南。[用户卸载步骤](../launcher-uninstall.md)。

## 发布状态核对

2026-09-10 核对 GitHub `v2.2.11` 发布记录：发布页已有 Mac Apple 芯片、Mac Intel、Windows x64 三个安装程序，更新记录包含卸载流程。因此用户指南中原有“当前为源码实现，尚未重新发布三端安装包”已经过期。

发布文件存在与发布说明提及该功能，不等于每个系统版本的卸载路径均已真机验收。原始实现阶段记录如下，不能作为新的实测结果。

## 原实现阶段验证范围

- 清理核心：保留数据、彻底删除、符号链接边界、长路径、重复执行及归属变化测试。
- 恢复：重新释放 Hermes 运行时后，读取原有配置与记忆，不覆盖新程序文件；恢复酒馆原有运行配置。
- 安全门：取消、二次确认、服务停止失败时不生成删除计划。
- Windows：在 `LongPathsEnabled=0` 的 Windows 机器上执行隔离文件测试；NSIS 钩子另有编译测试。
- macOS：使用临时 Electron App 验证辅助进程删除自己的 App 和临时数据，原 App 不变。

三平台系统卸载界面、取消、保留后重装和覆盖升级的真实用户验收不能由这些单元测试代替。本次文档梳理没有新增三平台实测。

## 当前实现入口

- [桌面端确认与交接](../../launcher/desktop/main.js)
- [卸载清理逻辑](../../deployment/uninstall/uninstall.js)
- [Windows NSIS 集成](../../deployment/uninstall/uninstall.nsh)
- [卸载回归测试](../../tests/deployment/launcher_uninstall.test.cjs)
- [本地主线合并验证](../local-main-integration-verification.md)

[v2.2.11 发布记录](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.2.11)
