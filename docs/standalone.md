# 独立部署

独立模式只运行 Tavern 核心 Web 应用，不要求 Hermes、ClawChat 或 Liveware，也不依赖
任何 Hermes 目录布局。

## 前置条件

- Python 3.10+
- 可写的持久化目录
- OpenAI-compatible `POST /chat/completions` 模型接口

## 一条命令启动

```sh
git clone https://github.com/LoveMaker-art/noras-tavern.git
cd noras-tavern
python3 start.py
```

首次运行时，启动器会：

- 检查 Python 是否为 3.10 或更高版本；
- 询问模型接口、API Key 和模型 ID；
- 在项目根目录生成权限受限的 `.env`；
- 自动创建 `.venv` 并安装或更新依赖；
- 启动前后端同源服务。

以后再次进入项目目录运行 `python3 start.py` 即可。Windows 使用 `py start.py`。
需要更换模型基础配置时运行 `python3 start.py --configure`。

也可以复制 `.env.example` 后手动填写。后端会自动读取项目根目录的 `.env`，无需再执行
`source`、`set -a` 或逐项导出环境变量：

```sh
cp .env.example .env
python3 start.py
```

浏览器打开 `http://127.0.0.1:8799/`。健康检查：

```sh
curl -fsS http://127.0.0.1:8799/api/health
```

不要直接打开 `app/frontend/index.html`。Tavern 的网页和 API 必须由同一个后端地址提供；
直接打开静态文件时，“开启新世界”等操作会因无法连接后端而失败。

## 持久化与升级

`TAVERN_STATE_DIR` 是实例数据的唯一根目录，包含世界、角色卡、世界书、故事、
模型配置、语音配置与世界素材。升级源码时保留该目录即可。

推荐把状态目录放在仓库外，或至少保留默认的 `./tavern-state` 并确保它不进入版本控制。
不要把密钥、状态目录或日志提交到 Git。

## 网络暴露

默认只监听 `127.0.0.1`。需要远程访问时，应在 Tavern 前放置带 TLS 和认证的反向代理，
并配置 `TAVERN_ALLOWED_ORIGINS`。不要直接把无认证的运行时监听到公网地址。

## 独立模式不包含什么

- 不会安装或调用 Hermes 技能。
- 不会自动注册 ClawChat Liveware。
- 不会同步 ClawChat 昵称、语言或身份。
- 不会为其他 Agent 自动创建工具定义。

这些能力属于适配层，而不是 Tavern 核心运行时。
