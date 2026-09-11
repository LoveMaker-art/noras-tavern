# AGENTS.md

## 系统与环境

- 诺拉运行于 Hermes，通过 ClawChat 对话；酒馆是独立服务。分别确认两者的状态，不能用酒馆健康检查代替诺拉或 ClawChat 连接检查。
- 从当前 `HERMES_HOME` 定位配置。启动器安装的实例用 `nora-instance.json` 中的 `hermesHome`、`installRoot`、`port`；该文件不存在时，按 `tavern-ops` 检查已有 MCP 绑定，不猜路径、端口，也不自行创建第二套实例。
- 人格来自 `HERMES_HOME/SOUL.md`；`HERMES_HOME/clawchat/greeting.md` 是 ClawChat 首次问候，与酒馆内部开场白不同。
- Agent 模型、酒馆文本模型和 MVU 模型分别配置，修改前确认用户指的是哪一个。

## 技能分工

根据请求选择技能，用 `skill_view(name="技能名")` 加载；参考文件通过 `file_path` 按需读取。普通聊天不需要加载酒馆技能。

- `nora-cardforge`：分析、解释、创作、修改、翻译和导出角色卡及其世界书、MVU、Regex、状态栏。制作后的导入按技能的暂存与 MCP 流程执行。
- `tavern`：创建空白世界、从卡库创建世界、直接导入现有卡，以及管理世界、角色、Persona、世界书、模型、会话、剧情账本、已安装插件、Story Profile 和外观。直接导入已有卡不需要先重新制卡。查找或保存可复用的我的角色、其他角色和世界书也使用 `tavern`，按其库操作参考处理。
- `tavern-ops`：诊断酒馆服务、MCP、连接和 Liveware 故障，执行授权的恢复。普通角色卡或插件问题先通过 `tavern` 检查，环境故障再转入运维。
- `tavern-updater`：检查版本、处理更新请求。启动器管理的实例由启动器更新整套系统，不使用旧版酒馆更新脚本或单独升级 Hermes 替代；旧独立安装按技能的对应流程处理。

ClawChat 平台操作用 `clawchat-core`，Liveware 入口用 `clawchat-liveware`，ClawChat 首次问候配置用 `clawchat-set-greeting`。独立应用开发用 `clawchat-liveware-dev`，插件自带 Liveware Sample 的修改用 `clawchat-liveware-sample`；不要把酒馆日常操作当成应用开发。

## 操作边界

- 默认使用简体中文。询问、只读检查、写入、付费模型调用和更新是不同范围；按用户授权执行，目标世界、会话或服务不明确时先确认。
- 使用实际工具 schema、查询返回的标识和必要的修订信息。酒馆数据操作通过 Nora MCP；缺少技能或接口时说明限制，不编造命令，也不直接改运行数据或源码绕过。
- 用户选择内置故事后，读取 `nora-cardforge` 的 `references/starter-stories.md`，使用随包文件暂存并导入。样例可选，问候时不预先导入，不生成替代故事。
- 保留无关世界、会话、角色、身份和配置；配置变更前备份。凭据不进入回复或日志。故事档案使用 Story Profile 流程，不把虚构经历记成用户的现实经历。
- 启停、重启和恢复只作用于用户指定的服务，按对应技能使用当前实例的受维护入口。诊断失败不自动扩大为重启、重装或升级。

## 完成标准

- 制卡：生成并验证实际文件；文件已生成不代表已导入。
- 导入或修改：核对操作回执和目标状态；数据已保存不代表页面或插件已经生效。
- 服务与连接：分别验证酒馆、诺拉和所需的 ClawChat / Liveware 连接。`nora-instance.py status` 仅检查酒馆，不能据此宣称诺拉已运行。
- 更新：检查最新版本不代表已安装；以更新结果、安装版本和相关就绪检查为准。
- 报告已确认的结果与仍待完成的部分；失败、待处理和证据不足要明确说明，不将旧日志视为当前成功。
