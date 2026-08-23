# Hermes + Tavern 部署

本文只负责把 Tavern 接入一个**已经能够正常对话的 Hermes Agent**。Tavern Bootstrap
不会安装 Hermes，也不会替 Hermes 选择模型服务商。

Tavern 使用 Hermes 官方的技能目录规则：`$HERMES_HOME/skills/` 是已安装技能的唯一来源。
没有设置 `HERMES_HOME` 时，Hermes 默认使用 `~/.hermes`；使用 profile 时应让 Hermes
提供对应的 `HERMES_HOME`，不要把路径写死为 `~/.hermes` 或 `/opt/data`。

## 适用平台

- 完整 Hermes + Tavern 集成：Linux、macOS、WSL2。
- 原生 Windows：Hermes 官方支持原生安装，但本项目的完整集成仍依赖 POSIX `sh`；请使用
  WSL2，或按[独立部署](standalone.md)只运行 Tavern。
- ClawChat Liveware：可选，且只在运行环境提供相应插件与 Liveware 命令时启用。

## 从零开始

### 1. 安装 Hermes

按照 Hermes 官方[安装指南](https://hermes-agent.nousresearch.com/docs/zh-Hans/getting-started/installation)执行：

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

安装后如终端还找不到 `hermes`，按官方提示重新加载当前 shell。不要使用
`pip install hermes-agent` 代替官方安装器。

### 2. 配置并验证 Hermes

```sh
hermes setup
```

使用 Nous Portal 时可以运行官方提供的 `hermes setup --portal`。完成配置后，先打开 Hermes
并进行一次真实对话。只有 Hermes 能稳定返回普通消息后，才继续安装 Tavern；Tavern 不负责
修复 Hermes 本身的 provider、模型或网络配置。

### 3. 安装完整 Tavern 集成

运行经过清单校验的 Bootstrap：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

它会以 `$HERMES_HOME` 为数据根目录；若未设置，则使用 Hermes 默认的 `~/.hermes`。
旧 ClawChat 容器只有在真实存在 `/opt/data/skills` 时才会自动进入兼容模式。

默认安装结果：

```text
$HERMES_HOME/apps/tavern-runtime/             Tavern 运行时
$HERMES_HOME/tavern-state/                    用户和实例数据
$HERMES_HOME/skills/creative/tavern*/         创意技能
$HERMES_HOME/skills/system/tavern-updater/    更新技能
$HERMES_HOME/skills/system/model-api-manager/ 模型 API 管理技能
```

Bootstrap 会先下载 manifest、验证归档和逐文件哈希，再审查当前基线与新版本的兼容性。
只有无冲突的计划才会应用；健康检查失败时回滚受管理文件。用户世界、角色、故事、密钥、
素材、`SOUL.md` 和其他自定义技能均不在覆盖范围内。

### 4. 验证安装

```sh
hermes skills list
python3 "${HERMES_HOME:-$HOME/.hermes}/skills/creative/tavern/scripts/tavern_cli.py" doctor --json
curl -fsS http://127.0.0.1:8799/api/health
```

`doctor` 应确认 API、技能和实例路径；健康接口应返回 `"ok": true`。随后可以直接打开
`http://127.0.0.1:8799/`，或在 Hermes 中提出“创建一个酒馆世界”“导入这张角色卡”等请求。

## 已有 Tavern，只安装技能

Tavern 已在本机或其他位置运行，只需要让 Hermes 控制它时，可使用官方 Custom Tap：

```sh
hermes skills tap add LoveMaker-art/noras-tavern
hermes skills install LoveMaker-art/noras-tavern/tavern
hermes skills install LoveMaker-art/noras-tavern/tavern-world
hermes skills install LoveMaker-art/noras-tavern/tavern-story-profile
hermes skills install LoveMaker-art/noras-tavern/tavern-continuity
hermes skills install LoveMaker-art/noras-tavern/tavern-ops
hermes skills install LoveMaker-art/noras-tavern/tavern-world-visuals
hermes skills install LoveMaker-art/noras-tavern/tavern-updater
hermes skills install LoveMaker-art/noras-tavern/model-api-manager
```

技能安装后会进入当前 `$HERMES_HOME/skills/<category>/`。使用 `hermes skills update`
更新 Tap 技能；新会话自动加载，当前会话需要立即生效时按 Hermes 的提示使用 `--now`
或重新开始会话。

若 Tavern 不在默认位置，给运行环境设置：

```sh
export TAVERN_APP_DIR=/absolute/path/to/tavern/app
export TAVERN_STATE_DIR=/absolute/path/to/tavern-state
export TAVERN_CONSOLE=http://127.0.0.1:8799
```

## Hermes 如何驱动 Tavern

`tavern` 是轻量路由技能，只把请求交给一个专业工作流：

| 技能 | 职责 |
| --- | --- |
| `tavern-world` | 创建世界，导入和整理角色卡、世界书、Persona 与开场 |
| `tavern-world-visuals` | 世界背景和视觉主题 |
| `tavern-story-profile` | 故事回忆与长期偏好 |
| `tavern-continuity` | 剧情账本、角色状态、压缩与生成诊断 |
| `tavern-ops` | 模型、服务健康、Liveware、命名与语言 |
| `tavern-updater` | 版本审查、安装和回滚 |
| `model-api-manager` | 区分 Agent 与 Tavern 配置域，验证并接入模型 API |

技能不直接修改生产 JSON。它们调用同包安装的结构化 CLI，CLI 再调用 Tavern 本机 HTTP
API；运行时负责校验和数据一致性。标准入口为：

```sh
python3 "$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py" doctor --json
```

如果只运行独立 Tavern，`tavern-ops` 中的 `runtime.sh` 可启动、停止和检查服务：

```sh
sh "$HERMES_HOME/skills/creative/tavern/scripts/runtime.sh" restart
```

## 可选的人格与 ClawChat 适配

`integrations/hermes/SOUL.md` 是首次部署的人格模板，不是技能依赖，也不会由更新器覆盖。
需要使用它时再复制到当前 profile：

```sh
install -m 600 integrations/hermes/SOUL.md "$HERMES_HOME/SOUL.md"
```

ClawChat Hook、Liveware 注册和恢复脚本随 `tavern` 技能安装，但只有检测到相应插件和
Liveware 二进制时才使用。普通 Hermes 或独立 Tavern 不会触发这条链路。
