---
name: model-provider-config
description: 配置或切换本地诺拉的模型、模型服务、API Key 或订阅登录。先查询当前实例 Hermes 支持的服务和认证方式，再使用共用配置程序。
version: 3.0.0
author: Nora Tavern
platforms: [macos, windows]
metadata:
  hermes:
    tags: [模型配置, 本地诺拉, API, 订阅登录]
    category: system
    related_skills: [tavern-ops]
---

# 配置诺拉模型

只配置当前受管本地实例的诺拉主模型。供应商、模型目录、认证及请求处理复用已安装的 Hermes；不修改酒馆／MVU、人格、MCP、回退配置或其他实例。

## 调用入口

使用实际安装目录中 `scripts/configure_provider.py`，通过当前实例 Python 调用：

- macOS：`"$HERMES_HOME/hermes-agent/venv/bin/python" -B "<本技能绝对路径>/scripts/configure_provider.py"`
- Windows PowerShell：`& "$env:HERMES_HOME\hermes-agent\venv\Scripts\python.exe" -B "<本技能绝对路径>\scripts\configure_provider.py"`

请求为标准输入第一行 JSON；Key、授权码和后续登录回复均不放入命令参数、持久请求文件、回复或日志。不从历史对话寻找凭据。

| action | 用途与必要输入 |
| --- | --- |
| `catalog` | 查询当前 Hermes 的供应商、认证方式、模型默认值，不需 Key |
| `inspect` | 查询当前已配置模型及认证是否就绪，不返回凭据 |
| `models` | 查询指定 `provider` 的候选模型，按需要提供 `api_key`、`base_url`、`auth_mode` |
| `save` | 保存 `provider`、`model` 及必要认证信息，新会话生效；默认操作 |
| `authenticate` | 为 `provider` 启动 Hermes 原生订阅登录；不切换当前主模型 |
| `test` | 用户明确要求测试时，通过 Hermes 实际调用指定模型，可能收费 |

## 操作顺序

1. 先以 `{"action":"catalog"}` 查询当前安装能力。使用返回的供应商 ID 和 `authModes`；不维护另一份名单，不根据 Key 猜测服务商。
2. 明确用户要使用的服务和模型。只有 Key 时先询问；不挑目录第一项。保留既有 DeepSeek 缺省选择 `deepseek-v4-flash`，其他模型由用户选择。
3. API Key 使用 `auth_mode:"key"`；已登录的订阅使用 `oauth`；原生外部凭据使用 `external`；目录支持的免认证配置使用 `none`。自定义服务及用户明确指定的接口覆盖需准确 `base_url`，不猜地址。
4. 需要登录时执行 `authenticate`，把返回的安全登录地址／用户码转交本人完成。登录成功取决于 Hermes 的认证结果，不取决于页面是否打开。外部程序或云凭据缺失时说明必要前提，不自动安装依赖。
5. 执行 `save`。只在返回 `ok:true` 后报告“模型配置已保存，新会话生效”；仍说明 API 尚未验证。当前会话不热切换，不自动重启网关。
6. 用户明确要求测试时才执行 `test`。以返回的实际响应结果报告成功；模型在列表、登录成功或配置保存均不能代替真实调用。失败报告原始安全原因，不改用其他服务冒充成功。

API Key 配置示例（值来自当前用户请求）：

```json
{"action":"save","provider":"deepseek","model":"deepseek-v4-flash","api_key":"<用户提供的 Key>","auth_mode":"key"}
```

订阅登录后保存时不提交 Key，使用目录中的实际供应商 ID 和模型名。

## 登录输入与失败

登录可能持续等待本人操作。保留同一个交互式终端进程及标准输入；收到 `promptId` 提示后，将本人的回复作为下一行 `{"promptId":"<提示编号>","response":"<本人回复>"}` 送回该进程。不得猜测或自动同意提示。一次性标准输入已关闭时不能声称稍后另一条命令能继续旧登录；改用支持交互输入的终端或启动器现有登录入口。设备码登录只需本人访问服务商页面时，可在同一进程等待其完成。

`HERMES_HOME`、实例 Python、安装记录或受控入口不匹配时停止，报告原因；不换系统 Python、其他 Hermes、不手改配置绕过。普通保存异常由共用程序按内存原值恢复配置与凭据，结果需核验；不额外复制含 Key 文件，不承诺断电或强制结束后自动恢复。原生登录可能已经保存新授权账户，这与主模型是否切换分别报告，不擅自删除该账户。

酒馆无法使用所选服务时，保留成功的诺拉配置，说明酒馆模型需单独设置；不将其说成诺拉配置失败，不覆盖现有酒馆配置。此技能不扩大到无桌面管理记录的云端部署。
