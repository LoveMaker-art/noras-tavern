---
name: model-provider-config
description: 配置或切换本地诺拉的模型、供应商和 API Key，包括 DeepSeek 与自定义 OpenAI 兼容接口。仅提供 Key 时先确认供应商与模型。
version: 2.0.0
author: Nora Tavern
platforms: [macos, windows]
metadata:
  hermes:
    tags: [模型配置, 本地诺拉, API]
    category: system
    related_skills: [tavern-ops]
---

# 配置诺拉模型

只更改当前启动器实例的 Nora 默认模型。使用项目现有配置程序和 Hermes 配置 API，不修改酒馆模型、回退模型、人格或其他实例。

## 确认配置

1. 用户明确要求配置模型时，收集供应商、模型名称和 API Key。自定义接口还需要完整 Base URL。
2. 只有 Key 时先询问供应商与模型；仅使用本次配置对话中用户提供的凭据，不检索历史消息。用户补齐信息后执行一次即可。
3. DeepSeek 未指定模型时使用 `deepseek-v4-flash`。其他供应商要求明确模型名；不自动选取模型列表第一项，不推测 Key 所属供应商或接口。
4. 支持 `deepseek`、`openrouter`、`openai`、`anthropic`、`gemini`。中转服务使用 `custom`，其 Base URL 必须由用户提供。

## 执行

加载本技能后，使用实际安装目录中的 `scripts/configure_provider.py`。通过 `terminal` 调用当前实例的 Python：

- macOS：`"$HERMES_HOME/hermes-agent/venv/bin/python" -B "<本技能绝对路径>/scripts/configure_provider.py"`
- Windows PowerShell：`& "$env:HERMES_HOME\hermes-agent\venv\Scripts\python.exe" -B "<本技能绝对路径>\scripts\configure_provider.py"`

将以下 JSON 作为标准输入发送，字段值来自当前用户请求：

```json
{"provider":"deepseek","model":"deepseek-v4-flash","api_key":"<用户提供的 Key>","base_url":""}
```

自定义接口使用 `provider: "custom"`，填写准确的 `model` 和 `base_url`。若 terminal 支持运行中的标准输入，通过该通道传入 JSON；否则使用当前 shell 的标准输入管道。Key 不放入命令行参数或持久化请求文件，不在回复中重述命令或完整 Key。

`HERMES_HOME` 缺失、Python 不属于当前实例、实例记录不匹配时停止，报告原因；不回退到系统 Python、`~/.hermes` 或其他目录。

## 结果

- 只有脚本退出码为 0 且返回 `ok: true`，才报告“模型配置已保存，新会话生效”。补充“尚未验证 API 可用性”。供应商与模型采用脚本返回值。
- 配置记录同步到启动器；脚本不发送网络请求，不生成备份文件。普通写入失败会用当次内存中的原值恢复，无法保证断电时恢复。
- 当前对话不自动热切换，不重启正在回复的诺拉。需要立即切换时，由用户在可用的 Hermes `/model` 入口操作；不要声称已切换当前会话。
- 测试模型、清空回退配置或同步酒馆模型需要独立请求，不作为配置后的附带操作。
- 失败时报告脚本的安全错误，不反复重试、不安装依赖、不另行执行 `hermes config set`。不展示 `.env`、`auth.json` 或完整配置。
