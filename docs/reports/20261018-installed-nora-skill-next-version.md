# 新版诺拉内置技能更新下一版实测

状态：**Mac ARM 与 Windows x64 的内置技能更新执行链专项均通过，并完成原始证据交叉核对。** 没有合并、推送、运行远端 CI 或发布。

## 本轮要证明的事情

本轮直接执行安装后的诺拉 `tavern-updater/scripts/update.py`，依次使用 `--check`、`--apply --confirm`、`--status`。不替换该技能，不用直接调用 bootstrap／task／operation-cli 冒充技能入口。桌面 APP 全程关闭，既有 APP 程序字节保持不变。

按产品基线 PB-05／PB-06／PB-09 核验：查到下一核心版本；提交调用方退出后独立任务继续；真实程序替换后失败能恢复健康原版并结束任务；通过同一技能重试成功；聊天、角色、世界和配置保留；最终世界及会话可读、任务锁释放。

## 起点、目标与测试分发

起点是上轮从真实公开 2.5.2 安装升级得到的隔离 **2.5.8**，源码 `92498f650d3e0f49e00bb93a7bb4147fb286284a`；不是本轮又修改旧技能来构造起点。安装后的技能 SHA256 为 `e47c8bebb132793464c123f13c6aa78d41bb515c2d7a4d296a2127399f52ff61`，与已安装发布清单一致。全部受管程序同时按清单核验。

下一测试核心 **2.5.9**，私有快照 `2c1042ec405bed54fcd4f392623668786e8b1ea1`。本轮没有修改产品源码；只在独立本地快照中改变测试版本身份。启动器仍为 2.2.5，没有重新构建 APP 或更换其载荷。**这些测试号码没有正式发布。**

目标包 31,764,110 字节，SHA256 `f0dbcae6a3c79e50021c468727aa638a834b06cc3a43ed42b3a06f959acffc48`；发布清单 SHA256 `da2ecb43fd459c56b52449d5d6bb53462e2a5b11145af0b79f0ed5f22ae272cc`。

未发布目标通过两处测试进程内的传输接线提供：

- 查询：仅本次查询子进程的外部 preload 将网络 `fetch` 交给已有 `createLocalRelease`，原版本比较与校验继续执行。
- 更新：外部 `sitecustomize` 只匹配本实例技能实际调用的已安装 `task.py`，在原参数后追加固定 release-dir／tag／commit／目标清单 SHA。`--allow-candidate` 仅用于隔离验收禁用故障上报，目标本身仍为 candidate=false。没有伪造任务或成功结果。
- 状态：原技能直接读取真实任务及锁，没有拦截状态结果。

技能、task、OPS、收据没有为测试改写。命令、原参数及追加后的参数、网络请求 URL 均保留。这是**未发布固定资源的更新执行链验收**，不据此声称新版已完成公网分发；也未执行真实 ClawChat 消息触发或外部模型选技能的验收。实际断开证据是提交进程已退出，而同一真实任务仍运行并持锁，随后完成恢复或升级。

## 实测结果

| 验收项 | Mac ARM | Windows x64 |
| --- | --- | --- |
| 原安装技能查到下一版且允许更新 | 通过 | 通过 |
| APP 关闭，由原技能提交核心更新 | 通过 | 通过 |
| 提交方退出后，原技能查询仍为真实 in-progress／busy=true | 通过 | 通过 |
| 新程序实际应用后，注入本实例端口故障并释放端口进入自动恢复 | 通过 | 通过 |
| 原核心字节及运行健康恢复，任务 rolled-back、settled=true、busy=false | 通过 | 通过 |
| 原技能重试同一固定目标并成功达到下一版 | 通过 | 通过 |
| 909 个既有用户文件、模型配置和凭据保留 | 通过 | 通过 |
| 再检查为当前版本，APP 字节未变，世界和会话实际 HTTP 可读 | 通过 | 通过 |
| 测试进程、端口和任务锁收尾 | 通过 | 通过 |

Mac 故障操作 `14a59e25-4982-4e33-8ae0-a37c5de768cd`，自动恢复结果为 `rolled-back`；重试操作 `f97e0e97-cf9a-4ca7-9ac0-1125a88aa21f`，结果为 `succeeded`。原 909 个文件无删改，仅允许新增内容与原 settings 字节一致的自动备份。配置与 APP 前后字节相同。最后通过原技能确认 settled=true、busy=false，测试进程及端口无残留。

Windows 故障操作 `db0ad46f-f4cb-48d2-a9aa-9e8e01143952` 为 `rolled-back/confirmed/restored-and-verified`；通过原技能重试 `293c84d5-4e32-4f4c-b95b-8c0461743a81`，结果 `succeeded/confirmed`。原 909 个文件在更新、HTTP 读取和最终停服后完全一致，无新增备份；模型配置、凭据、APP 字节均保持。提交进程退出后，另有真实 worker 身份与命令行证明其仍在运行。最终原技能状态 settled=true、busy=false，实际后台健康检查正常后已完成测试进程及端口清理。

主验收者校验 Windows 包内 540 个文件摘要及解压内容，另行核对原安装技能、前后数据与配置、目标程序清单、实际提交与状态命令、调用方退出时间、worker 身份、两个 canonical 结果及最终收尾记录，不仅依赖辅助执行者的汇总。

## 执行工具修正与边界

Mac 测试驱动最初将查询结果的 `latest` 当成不带 v 的版本，并假定首次独立任务目录已经存在；两次均在首次更新提交前停止，保留原查询成功记录后修正驱动。升级已经成功后的附加 HTTP 探针漏传运行时 baseline、清理误用了不存在的 `stop` 方法，改为已有 baseline 和 `stop_run` 后完成后置核对。没有因此重新构建资源或重新执行已经完成的升级。Windows 查询的测试 preload 最初在原依赖验证加载之前就引用依赖，导致真实 Node 探针报缺少 semver；改为实际 fetch 时才加载，原探针返回正常后再提交更新。相关错误属于这些明确的驱动调用，不能拿来解释未经诊断的产品故障。

本轮不改上轮仍未通过的 Mac APP 界面恢复按钮，也不声称未更新的历史旧技能自动拥有新逻辑；这些与本轮“新版已安装技能更新下一版”分开记录。本轮不包含全部历史版本、Mac Intel、真实外部模型／ClawChat 网关或正式发布验收。

原始证据根目录为 `local-state/installed-skill-next-version-20261018/`。

| 证据 | 路径 |
| --- | --- |
| 下一核心快照、包及身份 | `root/frozen-source-identity.json`、`root/target-transport.json` |
| Mac 内置技能原命令、提交／状态、恢复及前后文件清单 | `root/mac/` |
| Mac 原始证据交叉核对 | `root/mac-raw-audit.json` |
| Mac 封存证据包 | `root/mac-installed-skill-proof.zip`；SHA256 `3fb6254f7ebf17666db2746d1c18e58c51ed16ff2cabcb29a2163ae71ec16cd2` |
| Windows 原始命令、任务、库存及收尾 | `component/windows-installed-skill259-evidence/` |
| Windows 原始证据交叉核对 | `root/windows-raw-audit.json` |
| Windows 封存证据包 | `component/windows-installed-skill259-evidence.zip`；SHA256 `e9bd391f22cff54b6bb27b2110806d5da37452e30d4b5f9498a265057b586adf` |
| 测试传输适配器 | `root/sitecustomize.py`、`root/check-transport.cjs` |

本专项的内置技能执行链没有剩余未通过项。真实 ClawChat 消息触发、实际网关连接中断、公网新版下载及前轮 APP 界面恢复问题不由这组证据覆盖，不能将本结果扩大为正式发布总体验收通过。正式发布继续暂停。
