# 核心仓导航

| 路径 | 本仓维护职责 |
| --- | --- |
| `app/` | 酒馆后端、前端、原生模型／生命周期接口及生成的 Story Profile 运行快照 |
| `nora/` | 诺拉人格、运行指引、技能、Hook 和内置内容 |
| `nora-mcp/` | 通过现有后端管理酒馆的工具接口 |
| `story-profile/` | 故事档案唯一手写源码和测试 |
| `deployment/install/` | 核心首装、固定发布身份与事务 |
| `deployment/update/` | 独立核心任务、版本替换、旧数据迁移与恢复 |
| `deployment/shared/` | 核心实例、模型、Nora配置、Liveware及进程服务实现 |
| `deployment/runtime/` | 核心运行、技能安装、实例定位和更新检查 |
| `tooling/` | 固定维护输入消费、源码投影、核心构建与校验 |
| `tests/` | 核心业务、安装、更新、数据保护与共享执行消费者合同 |
| `docs/` | 核心产品、使用、开发、技术和保留历史依据 |

<a id="shared-implementation-boundaries"></a>
## 实现归属

世界、会话与资源业务只在酒馆后端实现，HTTP、前端和MCP调用同一份业务。Story Profile 在 `story-profile/` 编辑，明确生成运行快照。模型、安装、更新与 Liveware 使用既有实例定位和配置保护规则。

共享维护执行源码由外部作者维护，本仓仅消费 `tooling/maintenance-input.lock.json` 固定的57份共享实现、只读原始依赖锁和封存生产依赖，不保留第二份可编辑副本。其来源、SHA256、文件清单、协议与依赖锁全部记录在固定输入中；缓存或临时投影不属于 Git 源码。

<a id="implementation-owners"></a>
<a id="instance-contexts"></a>
<a id="startup-order"></a>
## 运行与交付

诺拉与酒馆分别核验本实例服务身份和健康。ClawChat 是对话入口，Liveware 是应用入口。停止、重启、配置和更新遵守真实执行者及跨语言写锁，不用页面或进程标签代替结果。

`tooling/source-layout.json` 保留已部署的 `ops/` 兼容布局。部分共享执行资源仍位于历史交付路径 `ops/installer/desktop/`；该路径是存量核心任务协议，临时交付内容通过固定依赖物化，不代表本仓维护桌面应用。

核心从源码运行及打包入口见 [CONTRIBUTING](../CONTRIBUTING.md)。文件交付清单限制在核心和必要共享执行代码，模型密钥、用户配置、会话、日志及备份禁止进入程序资产。

## 维护与演进

开发命令唯一维护于[CONTRIBUTING](../CONTRIBUTING.md)，文档阅读入口唯一维护于[文档首页](README.md)，架构原因与原始证据在[演进记录](architecture/README.md)。本页只维护当前路径和作者归属，不维护另一份逐文件清单或验收统计。

### 尚未整合的拆分返修（2026-11-10核对）

基线main为`73220ae`，已验收分支`3e8d814`仍未整合：旧APP更新发现兼容声明修正、112条核心测试的活动归属恢复。它们是源码返修，不由文档收敛代替；后续核对实际合并状态再更新本段。已登记的旧运行缺陷、MCP门禁选择及平台验收也不因整理文档被宣称解决。
