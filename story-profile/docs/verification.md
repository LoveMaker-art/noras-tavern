# Story Profile 内置模块本地验收记录

> 历史记录：以下是 2026-08-28 当时的验收，不代表当前部署状态。
> 2026-08-31 已改为同仓 `story-profile/` 源码；源码对齐检查为
> `check:story-profile-source`，`check:story-profile` 只校验嵌入快照自身。
> 当前审查结论见仓库 `docs/architecture/MONOREPO-RELEASE-20260831.md`。

验收日期：2026-08-28

## 已验证

- Story Profile 源码作为 `tavern` 同级独立项目存在。
- `core/story_profile.py`、`core/reflection.py`、Nora adapter 与 actor UI 文件由 Tavern 的 `npm run sync:story-profile` 生成受控内置快照。
- `npm run check:story-profile` 通过时，证明同级源码、内置运行快照与清单同步。
- Nora Story Profile 单元测试与单进程合约通过，覆盖后台复盘、失败重试、持久化游标、页面读取和进程边界。
- Nora 全量本地测试、ESLint 与 Nora 构建通过。
- 服务器、运维工具与安装脚本只读取 `app/story_profile_runtime`，构建脚本是唯一读取同级 `story-profile` 源码的接口。
- 应用发布归档包含 Story Profile 内置运行快照，归档可在没有同级源码项目的环境中运行。
- `tavern/app` 顶层旧 `story_profile.py` 与 `story_profile_reflection.py` 双实现已移除；所有模型写操作统一通过 Nora HTTP 路由使用当前文本模型。

## 尚未验证或未完成

- 尚未用包含明确偏好证据的真实用户对话演示原版页面出现新增内容，因此还未达到“用户结果验证”。
- 未在远端环境部署；本阶段没有远端部署授权。
- 剧情账本及剧情连续性注入明确延后，不属于本次偏好链路验收。
