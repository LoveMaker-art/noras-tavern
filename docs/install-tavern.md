# 安装 Tavern

这是 Nora Tavern 的精简版安装方式。

精简版只安装 AI 角色扮演应用本体。你可以本地打开 Tavern、配置模型、导入角色卡、创建 World 并开始游玩，但不会包含 Nora / Agent 管理能力。

如果你希望让 Hermes Agent 中的 Nora 管理酒馆，请选择 [安装 Nora + Tavern](install-nora-tavern.md)。

## 温馨提醒

精简版 Tavern 也是本地运行。

Tavern 启动后依赖当前电脑和终端窗口。电脑关机、休眠、断网，或者启动 Tavern 的终端被关闭后，Tavern 页面就可能打不开。

这不是 24 小时在线的云服务。如果你希望长期使用，请保持电脑开机，并保持 Tavern 启动终端运行。

如果浏览器打不开 Tavern，请先检查：

- 电脑是否开机并联网
- 启动 Tavern 的终端是否还开着
- 终端里是否仍显示 Tavern 正在运行
- 浏览器地址是否是 `http://127.0.0.1:8000/`

## 你会得到什么

安装完成后，你会得到：

- Nora Tavern 应用本体
- Nora UI
- World 基础管理能力
- SillyTavern 角色卡、世界书、脚本和扩展兼容能力
- 本地数据目录

不会自动得到：

- Nora MCP
- Hermes skills
- Nora / Agent 管理能力
- Hermes 中的 `SOUL.md` / `AGENTS.md` 初始化

## 安装前准备

请先安装：

- Git
- Node.js 20 或更新版本
- npm

检查命令：

```sh
git --version
node -v
npm -v
```

如果 `node -v` 显示的主版本号小于 20，请先升级 Node.js。

## 第一步：打开终端

### Windows

1. 点击 Windows 开始菜单。
2. 搜索 **PowerShell**。
3. 打开 **Windows PowerShell** 或 **Windows Terminal**。

### macOS

1. 打开 **访达**。
2. 进入 **应用程序**。
3. 进入 **实用工具**。
4. 打开 **终端**。

## 第二步：下载源码

### Windows

在 PowerShell 中执行：

```powershell
mkdir "$HOME\Projects"
cd "$HOME\Projects"
git clone https://github.com/LoveMaker-art/noras-tavern.git
cd noras-tavern
```

如果 `Projects` 已经存在，`mkdir` 报错可以忽略。

### macOS

在终端中执行：

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/LoveMaker-art/noras-tavern.git
cd noras-tavern
```

## 第三步：进入 Tavern 应用目录

Tavern 应用位于：

```text
app/engine/sillytavern
```

进入这个目录：

```sh
cd app/engine/sillytavern
```

## 第四步：安装依赖

执行：

```sh
npm ci
```

这一步会根据锁定文件安装 Node 依赖。第一次执行可能需要几分钟。

## 第五步：构建前端资源

执行：

```sh
npm run build:nora
```

如果命令成功结束，说明 Tavern 前端资源已经构建完成。

## 第六步：启动 Tavern

执行：

```sh
npm start
```

终端中应该能看到类似内容：

```text
Nora Tavern is listening on IPv4: 127.0.0.1:8000
Nora Tavern runtime: http://127.0.0.1:8000/
```

只要这个终端还开着，Tavern 就在运行。不要关闭这个终端。

## 第七步：打开浏览器

在浏览器中打开：

```text
http://127.0.0.1:8000/
```

如果页面能打开，说明 Tavern 已经启动。

## 第八步：开始使用

进入 Tavern 后，你可以：

- 配置模型供应商和 API Key
- 导入角色卡
- 创建或打开 World
- 开始 AI 角色扮演会话

模型配置和密钥保存在你的本地数据目录中，不需要提交到 Git。

## 如何停止 Tavern

回到启动 Tavern 的终端，按：

```text
Ctrl+C
```

终端返回命令提示符后，Tavern 就停止了。

## 如何再次启动

进入应用目录。

Windows：

```powershell
cd "$HOME\Projects\noras-tavern\app\engine\sillytavern"
npm start
```

macOS：

```sh
cd "$HOME/Projects/noras-tavern/app/engine/sillytavern"
npm start
```

然后打开：

```text
http://127.0.0.1:8000/
```

## 如何更新源码版 Tavern

先停止正在运行的 Tavern，也就是在启动终端按：

```text
Ctrl+C
```

回到项目根目录。

Windows：

```powershell
cd "$HOME\Projects\noras-tavern"
git pull
cd app\engine\sillytavern
npm ci
npm run build:nora
npm start
```

macOS：

```sh
cd "$HOME/Projects/noras-tavern"
git pull
cd app/engine/sillytavern
npm ci
npm run build:nora
npm start
```

## 常见问题

### npm ci 失败怎么办？

先检查 Node.js 版本：

```sh
node -v
```

如果版本低于 20，请升级 Node.js 后重新执行：

```sh
npm ci
```

### 浏览器打不开怎么办？

确认 Tavern 启动终端还在运行，然后检查终端中显示的地址。

默认地址是：

```text
http://127.0.0.1:8000/
```

如果 8000 端口被占用，可以换一个端口启动：

```sh
npm start -- --port 8010
```

然后打开：

```text
http://127.0.0.1:8010/
```

### 能不能让局域网其他设备访问？

默认安装只建议本机访问。

如果你知道自己在做什么，可以用 listen 模式启动：

```sh
npm start -- --listen --port 8000
```

开启 listen 后，请自行配置访问控制、防火墙、反向代理和认证。不要把没有保护的本地 Tavern 直接暴露到公网。

### 之后还能不能安装 Nora + Tavern？

可以。之后如果你想使用完整 Agent 管理能力，可以再按照 [安装 Nora + Tavern](install-nora-tavern.md) 的流程配置完整环境。
