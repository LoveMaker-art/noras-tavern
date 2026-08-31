# Nora MCP 本轮优化与验收

> 本文保留 0.2 阶段的历史记录。随后实现的 0.3 运行控制见 README 与 Tavern 的 `docs/architecture/NORA-MCP-RUNTIME-CONTROLS-20260830.md`；下面的“尚未实现前端桥”不再表示当前源码状态。

日期：2026-08-30。状态：本地实现并完成下面列出的技术验证；未提交 Git、未部署远端，未修改宿主 MCP/skill 配置。

## 目标和边界

让 Nora MCP 的默认权限、实例识别、错误语义与当前 Tavern 的 World/Session/账本模型一致。复用既有领域服务，不建立第二套业务状态。此次不实现前端执行桥、不改 UI、不安装插件、不触碰真实用户档案。

| 验收项 | 实现 | 验证及限制 |
| --- | --- | --- |
| 明确工具权限 | 默认 26 个只读工具；operator 共 40 个；不注册原 ST 裸写、shell、源码维护、通用写资源入口 | 真实 stdio 工具发现；未注册工具调用被拒绝。调用参数确认不代替宿主的用户授权 |
| 不混用实例 | 必填状态根、仅 loopback HTTP，领域调用前比较后端 userDataRoot 与本地真实路径 | 路径不符时领域查询也被拒绝。未实现多用户登录/多租户沙箱 |
| 同一请求实现 | Nora/ST 共用 cookie、单飞 CSRF、错误和超时处理 | 冷请求首次携带 cookie+token，不再先 403；超时/5xx 不自动重试；HTML 不能冒充 JSON 成功 |
| 世界业务入口 | 创建、卡文件导入、卡库创建接入 World Core；稳定幂等键和操作查询 | 实际 World Core 创建重放只产生一个世界；文件上传字段与越界路径有单测；复杂卡浏览器执行未做此次验收 |
| 纯读账本 | 新 inspect 契约，不启动压缩、不修复持久状态、不投影档案 | 核心测试覆盖过期候选；真实 HTTP 测试中达到压缩门槛仍不调模型/写状态 |
| 领域编辑 | 用既有 Nora 编辑接口，校验全历史签名，沿用锁定、截断和重新计轮数 | 真实 HTTP 覆盖 active 锁、旧版本拒绝；stdio 集成覆盖截断后文和保留文本空白；没有页面同步确认 |
| 模型费用语义 | 付费动作显式 allowModelCall；预览也需确认；同步模型请求用长超时 | 参数拒绝测试；预览进程预算测试。未执行真实付费模型操作 |
| 备份收敛 | 指定文件、32 MiB/份、20份/128 MiB payload；恢复需当前哈希；旧全量调用失败关闭 | 临时文件测试验证限额、保留数量、拒绝过期恢复和保留无关文件。日常工具未开放此恢复能力；不提供多文件崩溃事务 |
| 独立交付 | 实际 node_modules、精确依赖+shrinkwrap、受控 npm 包清单 | 在全新临时目录解包，离线 npm ci --omit=dev 后两种模式均能初始化并发现工具；不依赖 st-mcp |

## 验证记录

- MCP：npm test，11 项通过（含编译和两种 stdio 模式）。
- MCP → Tavern：test:integration，1 项通过。真实使用 World Core/账本路由；仅替代卡资源物化，无真实模型，两轮临时会话。
- Tavern：nora-story-ledger、nora-world-v2-endpoint、nora-profile-process，22 项通过。
- Tavern：nora-story-ledger-http，1 项通过。真实模型适配代码连接本机模拟供应商，验证压缩候选 → 请求上下文 → 激活 → 保护写入 → 编辑 → 投影流程。
- 分发包：两种模式 stdio 启动检查通过；已确认没有 src/docs/用户数据，也没有 node_modules 符号链接。
- 合计 35 项自动测试通过，另有分发包启动检查。测试数量不代表所有工具和全部复杂卡已获端到端验证。

最初 HTTP 测试因沙箱不允许监听本机端口报 EPERM；获得针对隔离测试的执行许可后通过。没有为此关闭 Tavern 安全机制。

## 变更位置

- MCP：src/config.ts、http.ts、errors.ts、tool-policy.ts、server.ts、nora-control-plane.ts；ST 适配器中的共享 HTTP、只读结果及文件备份；package.json、npm-shrinkwrap.json、tests、README。
- Tavern：src/endpoints/nora-worlds-v2.js（身份字段）、src/endpoints/nora-story-ledger.js（inspect）、src/nora-story-ledger/core.js（纯查询）、runtime.js（查询不触发投影恢复）、src/nora-story-profile-adapter.js（预览进程预算）及对应测试。
- 没有改前端 UI、Story Profile 生成算法、15轮压缩/上下文激活规则、已有用户数据、远端进程或 Liveware 注册。

## 仍需单独处理

1. 若棠/Hermes 的 MCP 配置和配套 skill 接入，以及远端部署验收。
2. 前端执行桥：生成、停止、脚本、MVU 运行状态、页面与外部编辑的同步。不能以写文件或修改能力状态冒充执行。
3. 原 ST 维护方法暂留但不公开，不能仅放开白名单即宣称支持。插件安装和维护需另外确认权限、文件范围与恢复契约。
4. 老 upstream-st-index 是历史参考，未更新为完整 Nora 索引，也不随 npm 包交付。
5. nora-mcp 为 Tavern 同级目录，当前并非独立 Git 仓库；此次没有把它误提交到 Tavern 的既有脏工作树。版本归档需在用户确定仓库归属后处理。
