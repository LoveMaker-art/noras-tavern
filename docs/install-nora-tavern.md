# 安装、配置和运行诺拉与酒馆核心

[项目首页](../README.md) · [只安装酒馆](install-tavern.md) · [更新与恢复](update-nora-tavern.md)

本页是手工核心部署说明：在已有兼容 Hermes 中安装酒馆、诺拉内容、技能和 MCP，再配置模型与 ClawChat。只想玩酒馆时，按[酒馆源码安装](install-tavern.md)操作。

## 先选择适用流程

| 情况 | 使用入口与边界 |
| --- | --- |
| Windows x64、macOS Apple 芯片或 Intel，已有兼容 Hermes | 使用下文固定发行版核心首装；命令与下载身份已核对，本轮未重新完成三平台空白机器、真实模型和配对验收 |
| Linux／云端已有 Hermes | 使用同一核心入口，并核对[非默认目录](#linux-cloud-installation)和原服务管理器；正式产品目标不等于所有云环境均已验收 |
| 已有诺拉、酒馆及故事数据 | 按[更新与恢复](update-nora-tavern.md)，不用首次安装覆盖旧实例 |
| 要运行尚未发布的 main | 按[开发与隔离构建](../CONTRIBUTING.md)，不要把正式发行资产当作当前源码 |

下文固定为已发布的 **v2.6.5**，不追随 latest，不表示当前 main 已发布。换版本时使用那一版自己的正式资产、摘要与兼容说明；已有更高版本时不照此示例降级。

## 第一步：准备环境与本实例

1. 没有 Hermes 时，先按 [Hermes 官方安装说明](https://github.com/NousResearch/hermes-agent/blob/2237be355906fbe6065ce1815711eee52b2d646e/README.md#quick-install)准备对应平台环境。本项目固定环境的[对照基线](../tooling/runtime/hermes-bootstrap.lock.json)为 Hermes 0.21.1、Python 3.11；其他组合需另行核验。
2. 按[配套 ClawChat 插件说明](https://github.com/clawling/clawchat-plugin-hermes-agent/blob/8651f7078916e60ed1da9f78ec4d1278fef49dd9/docs/install.md)准备并启用插件，[固定身份](../tooling/runtime/clawchat-bundle.lock.json)用于核对。官方页面的 latest 命令不能证明安装了项目固定版本；已有兼容插件不必重装。
3. 准备 Node.js 24，确认 `node -v`。核心首装会校验发行资产，不会自动准备任意电脑上的全部 Hermes、插件和连接依赖。
4. 确认下面三个绝对路径；使用原安装账户，不默认要求管理员或 sudo，不修改系统 HOME、不借用其他实例的凭据。

| 名称 | 用途 |
| --- | --- |
| `HERMES_HOME` | 本实例配置、凭据、人格和技能目录，不是 Hermes 源码目录 |
| `TAVERN_PYTHON` | 能加载本实例 Hermes 的实际 Python；保留虚拟环境路径，不换成其系统解释器 |
| 酒馆程序根目录 | 首装将建立 `apps/tavern-runtime`、`apps/tavern-ops`、`apps/nora-mcp`；首次安装不要指向已有故事或无关安装 |

数据默认在程序根下的 `tavern-state`，显式映射时以实际 `stateRoot` 为准。配置、密钥、世界和会话不属于安装资产。示例端口为 8799，所有绑定必须一致，不能占用其他实例端口。

安装将受管完整 `AGENTS.md`，只保留上一版 `.bak`；自定义人格按[受管内容规则](product/nora.md#managed-content)保留。不要把长期私人约束只写入受管文件。

## 第二步：核对路径与解释器

以下是占位路径，先替换为自己的实际路径。每条成功再继续；已有实例绑定不能为了套示例而搬动。

还要明确 Hermes 的 **profile 选择器**：普通或自定义根目录使用 `default`；已有 `<根>/profiles/<名称>` 目录使用该实际名称，并保持原 `HERMES_HOME`。例如 `/opt/data/profiles/story` 使用 `story`，不能用 `default`。固定版本的 CLI 可能跟随 `active_profile`，仅设置 `HERMES_HOME` 或执行 `--version` 不能证明后续命令选中了它；不要修改原默认档案来绕过选择。规则见[固定版本的 profile 解析](https://github.com/NousResearch/hermes-agent/blob/2237be355906fbe6065ce1815711eee52b2d646e/hermes_cli/profiles.py)。

macOS／Linux：

```sh
export HERMES_HOME="/absolute/path/to/nora-home"
export TAVERN_PYTHON="/absolute/path/to/hermes-venv/bin/python"
nora_install_root="/absolute/path/to/nora-programs"
nora_profile="default"
"$TAVERN_PYTHON" -B -c 'import sys, hermes_cli; print(sys.executable); print(hermes_cli.__file__)'
"$TAVERN_PYTHON" -m hermes_cli.main --version
node -v
```

Windows PowerShell：

```powershell
$env:HERMES_HOME = 'D:\Nora\home'
$env:TAVERN_PYTHON = 'D:\Hermes\venv\Scripts\python.exe'
$noraInstallRoot = 'D:\Nora\programs'
$noraProfile = 'default'
& $env:TAVERN_PYTHON -B -c 'import sys, hermes_cli; print(sys.executable); print(hermes_cli.__file__)'
& $env:TAVERN_PYTHON -m hermes_cli.main --version
node -v
```

上面的 `default` 适用于示例中的普通根目录。使用已存在的命名 profile 时，先把 `nora_profile`／`$noraProfile` 改成其实际名称。Hermes 无法导入、profile 与目录不能对应或环境不符时先处理前提，不新建空配置假装已有环境就绪。`--version` 只核对版本，不承担 profile 身份验证。

## 第三步：下载、核验并安装固定核心

[v2.6.5 首装清单](https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/first-install-manifest.json)中的 bootstrap SHA256 为 `6ddd7f6c076dd831ce7765a0a59406e72fab627e4218ba3db1872b49131d78bb`，源码身份为 `4a0e17866131674c1ff03e29c5791f703a0e3957`，不是本轮文档提交。

在第二步的同一终端执行。只有下载和摘要核验成功后才执行文件；内部继续核验正式清单和组件。

macOS／Linux：

```sh
nora_work=$(mktemp -d) || exit 1
nora_bootstrap="$nora_work/first-install.py"
if curl -fL 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/nora-tavern-first-install-bootstrap.py' -o "$nora_bootstrap" &&
   "$TAVERN_PYTHON" -B -c 'import hashlib,sys; actual=hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest(); sys.exit(0 if actual=="6ddd7f6c076dd831ce7765a0a59406e72fab627e4218ba3db1872b49131d78bb" else "首装入口摘要不一致，停止。")' "$nora_bootstrap"
then
    "$TAVERN_PYTHON" -u -B "$nora_bootstrap" --tag v2.6.5 \
      --nora-home "$HERMES_HOME" --hermes-home "$HERMES_HOME" \
      --install-root "$nora_install_root" --port 8799 --skip-liveware --apply --confirm
fi
```

Windows PowerShell：

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $noraWork = Join-Path ([IO.Path]::GetTempPath()) ('nora-core-' + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $noraWork | Out-Null
    $noraBootstrap = Join-Path $noraWork 'first-install.py'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/nora-tavern-first-install-bootstrap.py' -OutFile $noraBootstrap
    if ((Get-FileHash -LiteralPath $noraBootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -cne '6ddd7f6c076dd831ce7765a0a59406e72fab627e4218ba3db1872b49131d78bb') {
        throw '首装入口摘要不一致，停止。'
    }
    & $env:TAVERN_PYTHON -u -B $noraBootstrap --tag v2.6.5 --nora-home $env:HERMES_HOME --hermes-home $env:HERMES_HOME --install-root $noraInstallRoot --port 8799 --skip-liveware --apply --confirm
    if ($LASTEXITCODE -ne 0) { throw '核心安装未成功，保留原错误及恢复记录。' }
}
```

`--skip-liveware` 只把远程入口初始化留到配对之后，不跳过核心校验。`status: installed` 仍表示等待模型、连接和入口核验。失败时保留首个错误、操作编号和恢复位置，不加 `--force-first-install`、删除记录或重复提交来绕过未知状态。

<a id="installation-location"></a>
<a id="linux-cloud-installation"></a>
## 非默认目录与 Linux／云端

已有绑定优先沿用。需要声明分离的程序、数据和解释器时，在本实例 `config.yaml` 中合并下列章节，不覆盖其他设置：

```yaml
nora_tavern:
  installRoot: /srv/nora-programs
  stateRoot: /mnt/stories/nora-state
  hermesInstallDir: /opt/hermes
  python: /opt/hermes/.venv/bin/python
  port: 8799
  serviceOwner: external
```

这是已有目录映射，不是迁移命令。`installRoot` 包含 `apps/`，`stateRoot` 指向真实数据，MCP 与端口须一致；程序、技能和数据不能重叠。Windows YAML 路径可用 `D:/Nora/programs`。需原子替换的目录不要直接使用卷挂载根，应规划卷内子目录；工具不自动搬动旧数据。

Linux 的 systemd、容器或其他 supervisor 继续管理所属服务，不在其自动拉起服务时再启动第二个网关。源码适配、平台安装、真实模型和外部入口分别验收，不能凭某个进程存活宣布全部通过。

## 第四步：配置并验证诺拉模型

安装成功后，在交互终端使用已安装向导。它复用本实例 Hermes 的服务、认证和候选验证，密钥不要写进命令参数。

macOS／Linux：

```sh
"$TAVERN_PYTHON" -B "$HERMES_HOME/skills/system/model-provider-config/scripts/configure_provider.py" --wizard
```

Windows PowerShell：

```powershell
& $env:TAVERN_PYTHON -B (Join-Path $env:HERMES_HOME 'skills\system\model-provider-config\scripts\configure_provider.py') --wizard
```

选择实际服务、认证方式和模型。自定义服务填写本人确认的 API 地址、模型 ID 和 Key；订阅／云服务按原生登录与地区流程完成，不用假 Key 代替。最后明确同意诊断验证，可能产生调用费用。

只有退出码 0 且结果含 `ok: true`、`verified: true`、`validation: api-response` 才算所选模型验证并保存。失败保留旧配置；保存默认不表示进行中的所有会话已切换。酒馆文本模型在酒馆设置中另行核对，不能用诺拉回复代替酒馆模型可用。详情见[模型技能](../nora/skills/system/model-provider-config/SKILL.md)。

## 第五步：连接 ClawChat 与应用入口

1. 按 [ClawChat 官方连接码指引](https://clawling.com/zh/chat/docs/connect-code/)登录客户端，通过 Add Agent 获取本人新连接码。不公开它，不用文档中的演示码。
2. 使用相同解释器、`HERMES_HOME` 及第二步确认的显式 profile 运行交互式 `gateway setup`，选择 ClawChat 并按提示输入连接码。macOS／Linux：`"$TAVERN_PYTHON" -m hermes_cli.main -p "$nora_profile" gateway setup`；PowerShell：`& $env:TAVERN_PYTHON -m hermes_cli.main -p $noraProfile gateway setup`。此流程可能启动／重启所选实例网关；已有正常连接不必重新配对。
3. 在 ClawChat 找到诺拉，发送“你好”并确认收到实际回复。配对、模型调用和当前会话已加载技能是不同结果。
4. 对新实例可告诉诺拉：“我授权初始化当前实例的 Tavern 和 Story Profile 应用入口。请按现有技能核对身份并复用已有 App，不创建重复入口；结果不明先查询。”由现有 `tavern-ops` 和平台技能完成；缺工具、登录或权限时报告缺项。
5. 分别打开 Tavern 和 Story Profile，核对酒馆、MCP 与远程入口指向同一数据实例。应用注册成功不等于客户端已刷新或公网可以访问。

## 下次使用、停止与重启

新终端先重新设置第二步的实际路径。以下命令只控制**酒馆**，不控制诺拉网关：

| 操作 | macOS／Linux | Windows PowerShell |
| --- | --- | --- |
| 查看状态 | `"$TAVERN_PYTHON" -B "$HERMES_HOME/scripts/nora-instance.py" status` | `& $env:TAVERN_PYTHON -B (Join-Path $env:HERMES_HOME 'scripts\nora-instance.py') status` |
| 启动酒馆 | 同一入口，最后参数改为 `start` | 同一入口，最后参数改为 `start` |
| 停止酒馆 | 同一入口，最后参数改为 `stop` | 同一入口，最后参数改为 `stop` |

重启前结束当前生成，确认 `stop` 成功且原写者结束后再 `start`。本地地址使用实际端口，示例为 `http://127.0.0.1:8799/`。状态未知时保留记录，不另起实例。

**诺拉网关**：已有 systemd／容器／其他服务管理器时，使用原管理器。手工前台实例先确认没有其他网关，再运行 `"$TAVERN_PYTHON" -m hermes_cli.main -p "$nora_profile" gateway run`；PowerShell 使用 `& $env:TAVERN_PYTHON -m hermes_cli.main -p $noraProfile gateway run`。保留第二步已确认的目录与 profile，不跟随其他默认档案。停止时在该前台终端按 Ctrl+C 并等待退出。关闭酒馆不等于关闭诺拉；电脑关机／休眠后本机服务不能继续提供远程访问。

## 故障定位与日志

| 现象 | 先检查什么 |
| --- | --- |
| 首装失败 | 首个错误、原操作编号及恢复结果；仍在执行时不重提，不删除数据重装 |
| 本地酒馆打不开 | 酒馆 `status`、实际端口与日志；不要先重启诺拉或重新配对 |
| 诺拉不回复 | 本实例网关、ClawChat 连接及所选模型；本地 HTTP 健康不能证明这些都正常 |
| 本地可用、远程打不开 | 已存在的 App、绑定、账号和公共入口；不要盲目再次 provision |
| 更新失败或中断 | 按[更新与恢复](update-nora-tavern.md)查询原任务，不新提交代替查询 |

酒馆日志通常为实际 `stateRoot/native-runtime/runs/production/native.log`；自定义 run ID 时以其运行记录为准。网关日志按当前 Hermes／服务管理器读取；只有项目受管执行者启动的网关才使用其 `noraHome/installer/gateway.log`。反馈时仅提供故障时段与脱敏错误，不公开配置、Key、连接码或完整聊天。

本页补齐现有入口的手工步骤和判定条件，不表示本轮已完成空白 Windows／Mac／Linux 安装、真实账号或全部远程入口验收。
