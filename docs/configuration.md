# 配置参考

以下变量由 Tavern 核心运行时读取。独立部署只需配置“必需”部分；Hermes 部署通常由
`bringup.sh` 从 `$HERMES_HOME/config.yaml` 解析模型地址和密钥。

## 必需配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TAVERN_MODEL_BASE` | 无 | OpenAI-compatible API 根地址，通常以 `/v1` 结尾 |
| `TAVERN_MODEL_KEY` | 无 | 文本模型密钥 |
| `TAVERN_MODEL` | `deepseek-v4-flash` | 模型 ID |
| `TAVERN_STATE_DIR` | `$TAVERN_DATA_ROOT/tavern-state` | 持久化状态根目录；独立模式建议显式设置 |

独立部署必须显式设置状态目录、模型地址和密钥。Hermes 环境在未设置模型变量时可读取
`$HERMES_HOME/config.yaml`，但这只是 Hermes 兼容回退，不应作为独立部署方式。

独立部署的 `python3 start.py` 会在首次运行时创建并维护项目根目录的 `.env`。直接运行
后端时也会自动读取该文件；已经存在的进程环境变量优先级更高。可用
`TAVERN_ENV_FILE=/path/to/custom.env` 显式指定其他配置文件。

## 服务与安全

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TAVERN_HOST` | `127.0.0.1` | 监听地址 |
| `TAVERN_PORT` | `8799` | 监听端口 |
| `TAVERN_ALLOWED_ORIGINS` | 空 | 允许的浏览器 Origin，逗号分隔 |
| `TAVERN_TRUSTED_USER_HEADER` | 空 | 可选的可信代理身份请求头 |
| `TAVERN_MAX_HTTP_WORKERS` | 运行时默认 | HTTP 并发上限 |
| `TAVERN_MAX_EVENT_BODY_BYTES` | 8 MiB | 普通事件请求体上限 |
| `TAVERN_MAX_CLONE_BODY_BYTES` | 14 MiB | 语音克隆请求体上限 |
| `TAVERN_WORLD_ASSET_MAX_BYTES` | 运行时默认 | 单个世界素材大小上限 |

`TAVERN_TRUSTED_USER_HEADER` 仅在前方代理确实清洗并注入该请求头时启用。

## 文本生成

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TAVERN_MODEL_TEMP` | `0.85` | 正文生成温度 |
| `TAVERN_ACTOR_MAX_TOKENS` | `10000` | 单次正文最大输出 token |
| `TAVERN_MODEL_TIMEOUT` | `120` | 模型请求超时秒数，限制在 10-300 |
| `TAVERN_MODEL_MAX_RESPONSE_BYTES` | 8 MiB | 模型响应体上限 |
| `TAVERN_LORE_LOOKBACK` | `6` | 世界书关键词回看消息数 |
| `TAVERN_LORE_BUDGET_CHARS` | `6000` | 单轮世界书注入字符预算 |
| `TAVERN_LORE_RECURSIVE_PASSES` | `2` | 显式递归世界书的最大扫描轮数 |
| `TAVERN_MEMORY_MODEL` | 与 `TAVERN_MODEL` 相同 | 剧情账本与角色状态整理模型 |

## 语音

语音是可选能力。未配置时不影响文本故事。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TAVERN_TTS_BASE` | 文本模型地址 | OpenAI-compatible `audio/speech` 根地址 |
| `TAVERN_TTS_KEY` | 文本模型密钥 | TTS 密钥 |
| `TAVERN_TTS_VOICE` | `longanlingxin` | 默认音色 |
| `TAVERN_TTS_TIMEOUT` | `240` | TTS 超时秒数 |
| `TAVERN_TTS_MAX_CHARS` | `4096` | 单次语音输入字符上限 |
| `TAVERN_TTS_CACHE_RETENTION_DAYS` | `15` | 未使用缓存的保留天数 |

## 配置原则

- 密钥只通过环境变量、Hermes 配置或 Tavern 状态文件保存，不进入前端和 Git。
- `.env.example` 只提供占位符；`.env` 已被 `.gitignore` 排除。
- `TAVERN_MEMORY_MODEL` 留空时自动使用 `TAVERN_MODEL`，不需要重复填写。
- 自定义模型由运行时写入 `TAVERN_STATE_DIR/model_configs.json`，属于实例数据。
- 修改环境变量后应重启运行时；修改世界、角色卡或模型选择不需要更新源码。
