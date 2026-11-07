# Local Main Integration Verification

## Scope

Integrate local `main` at `551b28c384df669a7374154a318b7f15da7abe02`
with repository organization at `ff7fbdb0afd58d031a34cb5f6ae75cde4b36f6ed`.
The organization branch includes upstream main at
`9f19d7d999aa86a91c5d3b9b20f3b306b8abcd3f`.
This is local integration, not a GitHub publication or desktop deployment.

## Conflict Resolution

Upstream commit `7ad4ad83c0235f44a84d37188ed362afb50da1a6` reverted
independent character settings introduced by `175717a`.
Local commit `551b28c` built preset and guarded setting controls on that
feature. Its merge conflicted with upstream even before directory changes.

With explicit approval to retain the local features, commit `1031841`
restored the reverted feature on the organization branch. Merging `551b28c`
then required no manual source conflict resolution. Generated frontend
assets were rebuilt from the combined sources instead of choosing one
side's old bundle.

Preserved behavior:

- Independent character settings and stable character references.
- Explicit preset import/application, character and Worldbook switches,
  guarded setting deletion, and startup resume ordering.
- Upstream model configuration and locale-aware Tavern welcome behavior.
- Current launcher, Nora files, deployment logic and source directory layout.

No second implementation was added. Launcher, deployment, Nora and tooling
sources match the organization branch. Uncommitted experimental library
work remains outside this integration.

## Verification

- Repository layout and delivery projection: 8 tests passed.
- Character, preset, setting, World isolation and startup behavior:
  100 focused tests passed.
- Launcher release, update, location, model, uninstall and release-source
  contracts: 90 tests passed.
- Tavern welcome initialization and language selection: 7 tests passed.
- Managed context, initial install, incremental update, shared launcher
  logic, refinement and Windows path unit tests: 70 tests run,
  68 passed and 2 skipped.
- `npm --prefix app/engine/sillytavern run build:nora`: passed, with
  webpack asset-size warnings.
- Offline candidate packaging, including Tavern and MCP builds: passed.
- Isolated macOS arm64 bundle smoke: passed. It exercised actual Hermes
  and Tavern, source/package/installed persona parity, skill and Hook
  loading, MCP instance access, locale-aware welcome creation, optional
  sample import idempotency and cron execution against a local fixture.
  The test service was stopped and its temporary home cleaned up.
- Original working tree: hashes and path sets of all 58 modified/untracked
  files matched the pre-integration snapshot.

The first launcher test attempt lacked desktop dependencies in the new
worktree; installing locked dependencies resolved it. The welcome test
must run from `app/engine/sillytavern`, as its codec resolves the default
image relative to the engine working directory. It passed from that
directory. Neither issue required changing product code.

## Limits

No Windows or Intel Mac runtime test, interactive UI acceptance, real API
request, real ClawChat pairing, GitHub push or public release was performed.
The local smoke did not use personal credentials and leaves setup pending.
The candidate is a verification artifact, not a replacement installed app.

---

本节保留2026-09-10仓库整理的原始记录，绑定其自己的源码基线；前文的主线整合采用另一组源码组合。两份记录的结果与未验范围分别使用，不合计为一次验收。

<a id="repository-organization-20260910"></a>
## 仓库整理验证记录

日期：2026-09-10。基线：`9f19d7d999aa86a91c5d3b9b20f3b306b8abcd3f`。工作分支：`codex/repository-organization`。

<a id="repository-organization-change-scope"></a>
### 改动边界

- 将原 `ops/` 的 203 个文件归入 Nora、启动器、部署、构建和测试目录。
- 其中 199 个文件保持字节一致，包括人格、AGENTS、问候、技能、Hook、安装更新业务、UI 和诺拉图片。
- 其余四个文件：桌面开发 README、发布源码导出器、本地封装依赖链接处理、源码索引器。
- 新增统一目录映射、开发执行入口和布局测试；更新三平台工作流路径与当前文档。
- `app/`、`story-profile/`、`nora-mcp/` 源码及用户安装目录不变。未创建第二份可编辑的 Nora 或更新业务代码。

<a id="repository-organization-evidence"></a>
### 已取得的证据

| 检查 | 结果与范围 |
| --- | --- |
| 路径映射与源码哈希 | 源码导出保持逐文件字节一致；拒绝遗漏映射、路径冲突和旧目录副本。 |
| 稳定包来源 | 测试确认稳定导出使用已提交布局，拒绝未提交变更。 |
| 开发执行入口 | 成功、失败和监听模式均清理自身临时导出；错误退出码保留。 |
| 安装与内容 | 首装、全量 AGENTS、问候模板、技能、实例定位、模型同步、Windows 路径回归测试通过。 |
| 更新与卸载 | 版本与平台清单、下载校验、更新事务、失败恢复、数据保留和卸载边界测试通过。 |
| 候选打包 | 使用现有已封装的 macOS arm64 Hermes 运行时，完成离线依赖构建与完整系统候选交付。 |
| 本机真实安装 | 在一次性目录安装真实 Hermes/Tavern；核对 SOUL、AGENTS 与源码；检查 Hook、技能、MCP、定时脚本和中文新手世界；测试后停止并清理自身实例。 |
| 工作流与文档 | 三平台构建命令改为新入口，YAML 结构检查通过；当前主要文档链接检查通过。 |

<a id="repository-organization-limits"></a>
### 尚未证明的范围

- 本轮没有运行 GitHub Actions、发布 Release、替换用户桌面包或更新用户安装。
- Windows / Mac Intel 原生构建与完整安装需要在对应机器验证；Mac 上的路径单测不能替代 Windows 真机验收。
- 真实安装测试没有输入真实 Key 或 ClawChat 配对码。插件离线注册不等于账户配对、外网 Liveware 或模型对话验收。
- 更新恢复的定向测试不等于已经执行过真实远端跨版本升级。
- UI 文件未改变；本轮未重新进行浏览器或桌面视觉验收。

复现命令见 [CONTRIBUTING.md](../CONTRIBUTING.md)。源码职责与旧交付布局的关系见 [仓库导航](REPOSITORY.md)。
