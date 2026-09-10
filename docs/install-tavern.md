# 只安装 Tavern（源码方式）

[返回项目首页](../README.md) · [改用完整版启动器](install-nora-tavern.md) · [更新已有源码安装](#更新源码版)

这是精简版：只安装酒馆本体，可以配置模型、导入角色卡并开始故事，不包含诺拉的 Agent 管理能力。

**本页需要使用终端，不是双击安装包。** 不想自行安装开发环境，请选择[完整版启动器](../README.md#安装)。以下命令适用于 Windows x64 和 macOS。

## 第一步：打开终端

- **Windows**：打开开始菜单，搜索 **PowerShell**，打开 Windows PowerShell 或 Windows Terminal。
- **Mac**：打开“访达 → 应用程序 → 实用工具 → 终端”。

命令按顺序执行，上一条没有报错再继续。Windows 下使用 `npm.cmd`，避免 PowerShell 的脚本策略拦截 `npm.ps1`；不需要修改系统执行策略。

## 第二步：安装 Git 和 Node.js

### Windows

1. 打开 [Git 官方 Windows 下载页](https://git-scm.com/install/windows)，选择 **Git for Windows/x64 Setup**。运行下载的安装程序，保留默认选项完成安装。
2. 打开 [Node.js 官方下载页](https://nodejs.org/en/download)，选择 **Node.js 24 LTS**、Windows、x64，下载 **Windows Installer (.msi)**。运行安装程序，保留 Node.js、npm 和 PATH 的默认选项。
3. 安装完成后，关闭并重新打开 PowerShell，执行：

```powershell
git --version
node -v
npm.cmd -v
```

### macOS

1. 在终端执行以下命令，按弹窗提示安装 Apple Command Line Tools，其中包含 Git。已安装时会提示无需重复安装。[Git 官方说明](https://git-scm.com/install/mac)

```sh
xcode-select --install
```

2. 打开 [Node.js 官方下载页](https://nodejs.org/en/download)，选择 **Node.js 24 LTS**、macOS，下载 **macOS Installer (.pkg)**。需要选择架构时，Apple 芯片选 arm64，Intel 选 x64。
3. 打开 PKG 并完成安装，然后重新打开终端，执行：

```sh
git --version
node -v
npm -v
```

三条命令都显示版本号后再继续。npm 随 Node.js 安装，不需要再找一个 npm 安装包。若显示“找不到命令”，先确认安装完成并重新打开终端。

## 第三步：下载源码

### Windows

```powershell
New-Item -ItemType Directory -Force "$HOME\Projects" | Out-Null
Set-Location "$HOME\Projects"
git -c core.longpaths=true clone --config core.longpaths=true https://github.com/LoveMaker-art/noras-tavern.git
Set-Location "noras-tavern\app\engine\sillytavern"
```

### macOS

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/LoveMaker-art/noras-tavern.git
cd noras-tavern/app/engine/sillytavern
```

若提示 `noras-tavern` 已存在，不要删除旧目录。已有安装请使用[更新步骤](#更新源码版)；不确定目录用途时，先停下来核对。

## 第四步：安装依赖、构建、启动

以下三条命令逐条运行。依赖安装可能需要几分钟，出现错误时不要继续执行下一条。

Windows：

```powershell
npm.cmd ci
npm.cmd run build:nora
npm.cmd start
```

macOS：

```sh
npm ci
npm run build:nora
npm start
```

看到终端输出本地访问地址后，在浏览器打开 [http://127.0.0.1:8000/](http://127.0.0.1:8000/)；若你改过端口，以终端显示的地址为准。不要双击源码中的 HTML 文件。

## 第五步：配置模型并开始故事

进入酒馆的模型设置，选择服务商，填写 API Key 和模型名称；使用自定义服务时还需填写对应 API 地址。保存配置并确认模型可用后，再导入角色卡、创建世界并开始对话。

API Key 由你自己的模型服务商提供，安装项目不附赠模型额度。

## 停止与再次启动

**停止**：回到运行酒馆的终端，按 **Ctrl+C**。

**再次启动**：重新打开终端，执行与你系统对应的命令。

Windows：

```powershell
Set-Location "$HOME\Projects\noras-tavern\app\engine\sillytavern"
npm.cmd start
```

macOS：

```sh
cd "$HOME/Projects/noras-tavern/app/engine/sillytavern"
npm start
```

然后打开终端显示的本地地址，不需要重复下载或安装依赖。

> 保持运行终端开启。电脑关机、休眠或终端中的服务停止后，酒馆无法继续提供服务；调用外部模型还需要网络。数据默认保存在应用目录的 `data/` 中，修改过 `dataRoot` 时以实际配置为准。

## 更新源码版

只适用于本页通过 `git clone` 安装的酒馆。[启动器用户请走另一条更新流程](update-nora-tavern.md#启动器完全版)。

1. 在运行终端按 **Ctrl+C** 停止酒馆。
2. 备份应用目录下的 `data/` 和 `config.yaml`；如果改过数据路径，备份实际目录。备份可能包含密钥，不要公开上传。
3. 进入仓库目录并检查本地修改。

Windows：

```powershell
Set-Location "$HOME\Projects\noras-tavern"
git status --short
```

macOS：

```sh
cd "$HOME/Projects/noras-tavern"
git status --short
```

**没有输出才继续。** 有输出表示本地存在改动，先保留并确认用途，不要用强制重置或删除文件来消除提示。

4. 获取更新：

```sh
git pull --ff-only
```

如果提示冲突或分支分叉，到这里停止，不要继续构建、不要强制覆盖。

5. 更新成功后重新安装依赖、构建并启动。

Windows：

```powershell
Set-Location "app\engine\sillytavern"
npm.cmd ci
npm.cmd run build:nora
npm.cmd start
```

macOS：

```sh
cd app/engine/sillytavern
npm ci
npm run build:nora
npm start
```

打开酒馆，确认原来的世界、会话和模型配置仍可使用。这条流程跟随仓库当前分支的源码更新，不等同于启动器的正式版更新通道。

## 遇到问题

- **依赖安装失败**：确认 `node -v` 显示 Node.js 24，并检查网络和终端第一处错误。不要重复执行后面的启动命令。
- **8000 端口被占用**：Windows 执行 `npm.cmd start -- --port 8010`，Mac 执行 `npm start -- --port 8010`，然后打开 [http://127.0.0.1:8010/](http://127.0.0.1:8010/)。
- **网页打不开**：检查终端内的服务是否还在运行，使用终端实际显示的地址。
- **想改用完整版**：可另行[安装 Nora + Tavern](install-nora-tavern.md)。它使用自己的安装目录，不承诺自动迁移当前源码版的数据；不要先删除原目录。

仍有问题，请[提交反馈](https://github.com/LoveMaker-art/noras-tavern/issues)，附系统、版本和脱敏后的错误信息。

[返回项目首页](../README.md) · [查看其他更新方式](update-nora-tavern.md)
