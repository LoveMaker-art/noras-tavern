# 旧卡文案润色

目标是同一张卡、同一套玩法，文字更符合用户需要。基础流程只有：检查待润色文案
与直接依赖 → 润色副本 → 对照交付，不做整卡评分或技术改造。
仅要求导入不触发润色；“优化”若可能指修程序、改玩法或改文笔，先确认。
此流程不要求旧卡具备 Zod 或 Nora 标记，不重新编译 MVU，也不操作运行中的世界和存档。

## 确定范围

先阅读目标字段的完整原文及其关联世界书、正则与脚本，不以 inspect 的计数代替读卡。
`inspect` 返回原文件 SHA-256；原始 JSON 直接读取。PNG 可在技能目录用只读命令提取：

```bash
node -e 'const fs=require("fs");const {readPngCardData}=require("./src/core/card-io");process.stdout.write(JSON.stringify(readPngCardData(fs.readFileSync(process.argv[1])).card,null,2))' /absolute/card.png
```

向用户简述准备润色的部分与风格；方向已明确就执行。默认保留事实、姓名、关系、
玩家自主权、数值阈值和玩法触发条件，不把润色变成剧情重设或一味扩写。
针对具体问题改善重复、空泛、语气不一致和开场缺少行动空间；不为评分增加字数。

| 部分 | 处理 |
| --- | --- |
| description、personality、scenario、开场白、示例对话 | 可润色纯文案片段，保留事实和对话结构 |
| 世界书条目 content | 可润色设定片段，保留变量指令、关键词及其依赖；不移动、合并或重排条目 |
| 初值、Zod、MVU 规则/输出协议、宏、脚本、Regex、HTML/CSS | 原样保留；缺 Zod 不补，有 Zod 不改 |
| 标识、姓名、触发键、启用状态、位置、顺序、扩展元数据 | 原样保留，避免引用和触发失效 |

文字也可能是接口：脚本或正则可能依赖“状态栏”等普通文本标签。将此类固定文本、
数字条件和自然语言变量规则列为保留片段。混合条目只选可分离的叙事部分；无法确认
依赖时保留该段并说明，不静默丢弃功能。现有命令不支持扩展字段中的人物数组文案、
脚本内文案或系统提示词；遇到这些位置先说明范围缺口，不迁移到 description 绕过。

## 在原卡副本精确修改

用一个 `prose.json` 汇总本次编辑，无需建立新卡项目或另一套评估报告目录。
路径相对原始 `data`（V1 则相对根）；数组下标绑定这次源文件哈希，不跨版本复用。

```json
{
  "format": "nora-card-prose/1",
  "sourceSha256": "替换为inspect返回的原文件sha256",
  "edits": [
    {
      "path": ["first_mes"],
      "before": "门外下着雨，她看着你。",
      "after": "雨点敲着檐角。她抬起眼，将桌边的干毛巾推到你面前。"
    }
  ]
}
```

支持的路径：单字段 description/personality/scenario/first_mes/mes_example；
`["alternate_greetings", 0]`、`["group_only_greetings", 0]`；
`["character_book", "entries", 0, "content"]`。
每个 before 必须是原字段内唯一、非空且互不重叠的原文片段；只替换纯文案，不整段
复制混合脚本。已有技术错误只记录，不随润色修复。

```text
node scripts/nora-cardforge.js prose-edit --input <original.png> --edits <prose.json> --output <new-copy.png> --dry-run
node scripts/nora-cardforge.js prose-edit --input <same-original.png> --edits <same-prose.json> --output <same-new-copy.png>
```

预览不写文件。正式命令验证源哈希、限定路径、唯一原文、可识别的代码/宏/标签保护，
然后一次写新文件；不覆盖输入或已有候选。保持输入格式及原有卡数据字段，不归一化。
PNG 的 chara/ccv3 若同时存在，分别保留各自元数据并应用同一编辑；任一不匹配就整批
停止，不自行取一份覆盖另一份。封面与其他 PNG 块保留。

命令不执行卡片代码、不调用模型、不导入。标记保护不是任意脚本解析器，更不能
识别所有自然语言玩法约束；`unchangedDataOutsideEdits` 只证明指定片段外的数据没改，
不证明改后语义等价或可玩。JSON 排版、PNG 卡元数据编码可能变化，不声称文件字节不变。

## 复核与交付

1. 回读新文件，对照每处 before/after，核对事实、人物口吻、触发词、玩法条件和
   已识别的显示/脚本依赖。检查是否新引入歧义或破坏玩家行动空间。
2. 复核命令的修改范围与源/成品哈希，确认其他数据保持不变。发现具体技术疑点
   才调用 diagnose，不为基础润色做整卡诊断或清零旧卡规范警告。
3. 交付副本、源/成品哈希和简短改动摘要；说明保留内容与尚未运行验证的部分。
   修订失败保留原卡，重新编辑计划使用原文件，不对过期候选连续打补丁。
4. 只有用户还要求导入时，才按 `tavern` 的已有文件导入流程交接复核后的副本；
   不走 `build` 或新卡 `prepare-import --project`。替换当前世界须单独确认，不能
   将“润色卡文件”理解为覆盖已有聊天。获准实测时检查正文、状态、美化及按钮。
