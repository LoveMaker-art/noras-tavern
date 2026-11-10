# 独立核心更新与旧版本接入

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [项目首页](../README.md)

**适用于已经安装酒馆及配套 Hermes 环境的更新。** 不要求桌面启动器打开，也可核验带桌面安装标记的原目录。不是空白电脑的首次安装流程，也不用于绕过损坏或未知的安装归属。

- 通过 `git clone` 安装的用户，请使用[源码更新](install-tavern.md#更新源码版)。

## 更新前

确认安装位置，结束正在生成的对话，保留原目录和备份。本工具更新酒馆及其配套内容，不负责升级整个 Hermes 运行时。

<a id="legacy-core-entry"></a>
## 旧技能要求启动器时的一次接入

旧技能报“缺少更新器模块”、仍要求启动器处理核心，或旧联合更新提示兼容性拒绝时，使用已发布的官方独立入口。旧技能不会因服务器发布新版而自动改变，也不需要先更换 APP 才能接入核心更新。

以下以**固定 v2.6.5** 为例：它更新原目录的诺拉／酒馆核心及受管技能，保留聊天、角色、世界和用户配置；不替换 APP，也不升级整个 Hermes 环境。入口文件为 [v2.6.5 官方 bootstrap](https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/tavern-updater-bootstrap.py)，SHA256：

```text
3036ad49e1489e5b653dd72f8218351a2652e7071f8a2a9ac7f2543546ff94b1
```

如果实际核心已经高于 2.6.5，不使用这个固定示例降级。其他目标版本须核对该版本自己的入口和摘要。

### 普通用户：复制给当前诺拉

当前诺拉能正常对话、并能执行终端工具时，可发送以下指令，无需自己拼写命令：

> 我授权将当前这套诺拉与酒馆核心更新到 v2.6.5，保留原模型配置、配对、世界和会话。旧入口无法继续，请使用官方独立入口，不调用启动器联合更新。先核对当前版本，高于 2.6.5 则停止；根据当前实例核对原 Hermes 目录、酒馆目录和 Hermes Python，再下载 https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/tavern-updater-bootstrap.py ，核对 SHA256 为 3036ad49e1489e5b653dd72f8218351a2652e7071f8a2a9ac7f2543546ff94b1。提交前生成并告诉我本次 requestId（UUID），以 --request-id 传入，使用 --tag v2.6.5、原目录和原解释器提交一次更新。断线重连后只查询这个编号，不重新提交；只有任务 succeeded、实际核心为 2.6.5 且 systemReady 为 true 时才报告成功。失败时告诉我原错误和恢复结果，不删除数据或任务记录。

若发生断线，重新连接后发送：“查询刚才保存的 requestId 为……的更新任务，不要重新提交。”将省略号替换成已保存的编号。诺拉无法对话时，保留错误和任务编号，由熟悉原部署的人按下面的核心命令核对实例及任务；不要重复提交或清理数据。

这段文本依赖诺拉实际具备终端工具和正确执行指令，不能仅凭文字就保证完成。下面的新增命令组合按 v2.6.5 源码接口和发行摘要核对；本次文档修订没有逐段执行三平台实机验收，不把代码核对称为已验收的一键更新。

### 进阶用户：在原安装账户的终端操作

每段执行成功再继续，路径始终指向**原数据目录**。Windows 使用普通 PowerShell 即可，不需要改变执行策略或额外提权。这里的诺拉根目录不是启动器 EXE／APP 的安装位置。

<details>
<summary>Windows PowerShell：定位、下载核验、提交和查询同一任务</summary>

**1. 定位原安装及其 Python。** 以下适用于正式桌面安装，按 UTF-8 读取自选位置记录；如果路径记录损坏、磁盘不在线或环境缺失，到这里停止。核对打印的位置确实属于原来的核心实例。

```powershell
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$defaultRoot = Join-Path $env:LOCALAPPDATA 'NoraTavern'
$locationFile = Join-Path $defaultRoot 'installer\location.json'
$noraRoot = $defaultRoot
if (Test-Path -LiteralPath $locationFile) {
    $location = Get-Content -LiteralPath $locationFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($location.schema -ne 1 -or $location.scope -ne 'stable' -or
        -not [IO.Path]::IsPathRooted($location.root)) { throw '安装位置记录无法核对，请保留现场。' }
    $noraRoot = $location.root
}
$hermesHome = Join-Path $noraRoot 'hermes'
$installRoot = Join-Path $noraRoot 'tavern'
$python = Join-Path $hermesHome 'hermes-agent\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or
    -not (Test-Path -LiteralPath $installRoot -PathType Container)) { throw '原环境不完整，请停止并核对原安装。' }
"原数据目录：$noraRoot"
"原 Python：$python"
```

**2. 下载、核验并提交一次。** 在同一个 PowerShell 中继续。先将打印的根目录和任务编号复制保存；命令返回不等于更新成功。

```powershell
$bootstrap = Join-Path ([IO.Path]::GetTempPath()) ('nora-v265-' + [guid]::NewGuid().ToString() + '.py')
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/tavern-updater-bootstrap.py' -OutFile $bootstrap
$expected = '3036ad49e1489e5b653dd72f8218351a2652e7071f8a2a9ac7f2543546ff94b1'
if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw '入口摘要不一致，停止执行。' }
$requestId = [guid]::NewGuid().ToString()
"请保存原数据目录：$noraRoot"
"请保存本次任务编号：$requestId"
& $python -B $bootstrap --tag v2.6.5 --hermes-home $hermesHome --install-root $installRoot --request-id $requestId --apply --confirm
if ($LASTEXITCODE -ne 0) { throw '提交结果需检查；保留本次编号和错误，不要重新提交。' }
```

**3. 查询这个编号并等待终态。** 继续使用同一个 PowerShell；重新打开终端时，先把 `$noraRoot`、`$requestId` 赋回刚才保存的值，不要生成新编号。以下调用本次任务保留的官方查询代码；不从正在替换的原程序目录启动旧 `task.py`，也不查询另一个“最新任务”。

```powershell
$controlFile = Join-Path $noraRoot "installer\update-jobs\$requestId\updater-control.json"
$control = Get-Content -LiteralPath $controlFile -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = Join-Path $control.opsRoot 'installer\desktop\updater-task.js'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
@{ action = 'wait'; noraHome = $control.noraHome; requestId = $requestId } |
    ConvertTo-Json -Compress | & $control.executable.path $entry
if ($LASTEXITCODE -ne 0) { throw '原任务未成功或结果尚无法核验；保留输出和编号。' }
```

最终 `event: result` 输出的顶层 `status` 表示任务状态，`busy`、`settled` 表示写入是否结束。成功操作的实际核心版本和系统检查结果位于 `operation.result.version`、`operation.result.systemReady`，按本页“更新后”的标准确认。缺少相应结果、记录读取失败或仍在写入时，保留原编号和错误，不用另起更新代替查询。

</details>

<details>
<summary>Mac 桌面正式安装：使用原 Library/NoraTavern 目录及 Hermes Python</summary>

**1. 定位原目录。** 自选安装位置时读取默认目录留下的记录；不使用独立 Hermes 的 `~/.hermes` 猜测桌面位置。核对打印结果与该实例的安装记录、实际 Hermes 目录及酒馆目录一致；结果冲突时先停止，不猜测目录。

```sh
nora_root="$HOME/Library/NoraTavern"
location_file="$nora_root/installer/location.json"
if [ -f "$location_file" ]; then
    [ "$(/usr/bin/plutil -extract schema raw -o - "$location_file")" = 1 ] || exit 1
    [ "$(/usr/bin/plutil -extract scope raw -o - "$location_file")" = stable ] || exit 1
    nora_root=$(/usr/bin/plutil -extract root raw -o - "$location_file") || exit 1
fi
case "$nora_root" in /*) ;; *) printf '安装位置记录无效，请停止。\n'; exit 1 ;; esac
hermes_home="$nora_root/hermes"
install_root="$nora_root/tavern"
python="$hermes_home/hermes-agent/venv/bin/python"
[ -x "$python" ] && [ -d "$install_root" ] || { printf '原环境不完整，请停止并核对原安装。\n'; exit 1; }
printf '原数据目录：%s\n原 Python：%s\n' "$nora_root" "$python"
```

**2. 下载、核验并提交一次。** 在同一个终端继续，将打印的原数据目录和任务编号复制保存。

```sh
bootstrap=$(mktemp "${TMPDIR:-/tmp}/nora-v265.XXXXXX") || exit 1
curl -fsSL 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.6.5/tavern-updater-bootstrap.py' -o "$bootstrap" || exit 1
actual_sha=$(shasum -a 256 "$bootstrap" | cut -d ' ' -f 1)
[ "$actual_sha" = 3036ad49e1489e5b653dd72f8218351a2652e7071f8a2a9ac7f2543546ff94b1 ] || { printf '入口摘要不一致，停止执行。\n'; exit 1; }
request_id=$("$python" -B -c 'import uuid; print(uuid.uuid4())') || exit 1
printf '请保存原数据目录：%s\n请保存本次任务编号：%s\n' "$nora_root" "$request_id"
"$python" -B "$bootstrap" --tag v2.6.5 --hermes-home "$hermes_home" --install-root "$install_root" --request-id "$request_id" --apply --confirm || { printf '提交结果需检查；保留本次编号和错误，不要重新提交。\n'; exit 1; }
```

**3. 查询并等待同一任务。** 重新打开终端时，先赋回已保存的 `nora_root`、`request_id`，并重新设置原 `python` 路径，不生成新编号。以下只把标准 `wait` 请求交给本次保留的官方查询入口。

```sh
"$python" -B - "$nora_root/installer/update-jobs/$request_id/updater-control.json" "$request_id" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

control = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
entry = Path(control['opsRoot']) / 'installer/desktop/updater-task.js'
query = {'action': 'wait', 'noraHome': control['noraHome'], 'requestId': sys.argv[2]}
result = subprocess.run([control['executable']['path'], str(entry)],
                        input=json.dumps(query), text=True, encoding='utf-8', check=False)
raise SystemExit(result.returncode)
PY
```

最终 `event: result` 输出的顶层 `status`、`busy`、`settled` 用于确认任务是否结束；实际核心版本与系统检查结果查看 `operation.result.version`、`operation.result.systemReady`。按本页“更新后”确认成功，结果字段缺失、返回失败或无法核验时停止并保留原编号。

</details>

## 独立部署的通用入口（Linux／macOS）

本节保留已有独立部署的最新稳定核心入口，**不是 Mac 桌面默认目录的命令**。在原部署主机执行，确认实际 `HERMES_HOME`、酒馆根目录和可用 Python；Windows 不运行此 shell 脚本。更新器不要求桌面 APP 在线。

使用独立部署的既有默认位置时：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

没有设置 `HERMES_HOME` 时，bootstrap 通常查找 `~/.hermes`；Linux 有既定 `/opt/data/skills` 布局时采用 `/opt/data`。不符合原安装就不要用无参数示例。自定义位置与解释器应明确填写，下面三个绝对路径均为占位符：

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | TAVERN_PYTHON="/absolute/path/to/venv/bin/python" sh -s -- --apply --confirm --hermes-home "/absolute/path/to/hermes" --install-root "/absolute/path/to/tavern"
```

入口核验发布目录、摘要和目标执行代码后提交更新。保留输出的任务编号，并按“更新后”查询同一结果；尚未发布的分支修复不会自动进入公开下载。默认稳定核心入口不会因为后来只发布 APP 而选择缺少核心资源的 APP-only 批次。

Linux 原生 2.x 更新会先在临时目录准备并核对新版依赖，成功后才停止原服务和替换程序。依赖准备失败时，原程序和数据保留。旧 Python 版是否可迁移还取决于原服务归属与数据格式，不能把原生 2.x 验收外推到全部 1.x 部署。

## 更新后

1. 保留返回的任务编号。`selecting`、`downloading`、`applying` 等状态表示仍在执行；提交命令返回零不代表更新已成功。
2. 诺拉重新连接后按保存的编号查询，或使用上面的同任务等待命令。只有同一任务为 `succeeded`、实际核心版本符合目标且 `systemReady: true`，才确认核心更新成功；固定示例的目标为 **2.6.5**。提交返回零、下载完成或窗口重开都不代替这些结果。
3. 打开酒馆，检查原有世界、会话和模型配置；使用诺拉时，再检查 IM 对话及应用入口。

`partial` 表示有数据仍待迁移，不等于全部迁移完成。失败时保留提示与现场，不要删除重装。

如果输出表示上次失败事务已恢复，先确认旧版能打开且数据仍在。这次任务的结果是“恢复”，
还没有升级；随后再次明确执行更新。不要在恢复尚未确认时覆盖安装目录。

备份位于 `<酒馆安装目录>/tavern-backups/`，可能包含模型 Key 和私人会话。不要直接上传整个备份目录。

## 自定义文件提醒

`AGENTS.md` 由项目全量管理；自定义开场白等文件按各自规则处理。修改过相关配置时，更新前先查看配置文件管理说明（原始出处：`09b9895:docs/launcher-managed-files.md`）与[部署职责](REPOSITORY.md)。

[返回更新方式选择](update-nora-tavern.md#先选择你的安装方式) · [提交脱敏后的问题反馈](https://github.com/LoveMaker-art/noras-tavern/issues)
