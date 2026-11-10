# 架构决策索引

[返回文档入口](../README.md) · [领域语言](../../CONTEXT.md) · [现行产品规则](../product/README.md)

ADR保留作出决策时的背景、备选项和取舍。当前适用范围同时查看正文状态及后续取代关系；已被取代的原文继续留作追溯。

| 决策 | 状态与阅读提示 |
| --- | --- |
| [ADR 0001: Store World Identity With The Chat](0001-store-world-identity-with-chat.md) | 已由[0007](0007-make-world-manifest-authoritative.md)取代。 |
| [ADR 0002: Single Node Runtime](0002-single-node-runtime.md) | 按正文的决策及适用范围使用。 |
| [ADR 0003: Isolate The ST Compatibility Boundary](0003-isolate-st-compatibility.md) | 按正文的决策及适用范围使用。 |
| [ADR 0004: Split Nora UI Workflows Into Deep Modules](0004-split-nora-ui-workflows.md) | 按正文的决策及适用范围使用。 |
| [ADR 0005: Separate Product Brand from Compatibility Identity](0005-separate-product-brand-from-compatibility-identity.md) | 按正文的决策及适用范围使用。 |
| [ADR 0006: Own Core Startup and Use Immutable Critical Assets](0006-own-core-startup-and-use-immutable-critical-assets.md) | 按正文的决策及适用范围使用。 |
| [Make The World Manifest Authoritative](0007-make-world-manifest-authoritative.md) | 取代0001中的世界身份权威存储选择。 |
| [Separate World Readiness From Capability Readiness](0008-separate-world-readiness-from-capabilities.md) | 按正文的决策及适用范围使用。 |
| [Use Atomic JSON Manifests With An In-Memory Index](0009-use-json-manifests-with-an-in-memory-index.md) | 按正文的决策及适用范围使用。 |
| [Create Blank Worlds Through World Core](0010-create-blank-worlds-through-world-core.md) | 共享空白运行卡的选择已部分修订；新世界使用独立副本，详见正文及酒馆设计。 |
| [Preserve Python story identities in a World-owned cast](0011-world-owned-cast-for-python-data.md) | 按正文的决策及适用范围使用。 |
| [ADR 0012: Separate Runtime Ownership from Process Instance Identity](0012-separate-runtime-ownership-from-process-instance.md) | 核心进程身份与实际归属；恢复适用正文，保留原修订来源。 |
| [ADR 0013: Snapshot Replaceable Code at Maintenance](0013-snapshot-replaceable-code-at-maintenance.md) | 核心程序替换、快照与数据保护；历史事务按其协议阅读。 |
| [ADR 0014: Repair Derived Operational State Instead of Treating It as Authority](0014-repair-derived-operational-state.md) | 派生运行状态与权威数据分开；原时点实现缺口不冒充当前验收。 |

<a id="core-scope"></a>
## 核心适用范围与来源

0012～0014于2026-11-10从原修订09b9895恢复：桌面源码迁出不取消核心进程归属、程序替换与派生状态规则。当前产品及[维护合同](../core-maintenance.md)优先；正文中的旧时点实现缺口不等于本轮新验收。三份ADR共同使用本说明，不在各文件重复维护来源段落。
