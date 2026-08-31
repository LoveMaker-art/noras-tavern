#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Structural scorer for character cards in card.md format (rule-based, deterministic).

角色卡结构化评分——基线来自 2 万+ 张社区热门卡统计观察、2907 张酒馆卡/64766 条世界书
词条解包与四大社区预设拆解。对 card.md（frontmatter + ## 章节）做逐项检测，输出八大类
得分 + 命中明细。评分标准全文见 skills/character-card-author/SKILL.md §7。

维度分值（100）：字段完整度13 / 开场白结构18 / 活人感九写法24 / 标签与赛道10 /
              美化与指令12 / 世界书8 / 图片提示词10 / 反AI味5

内含 `ai_flavor_scan()`：AI 味检测器（黑名单套话 + 句式病灶配额制），权重经 gold
判例集校准——孤立套话词降权（人类也用「一丝凉意」）、句式 tic（引语点题/对仗翻转/
生造概念词/伪精确数字）高权重。回归锁在 tools/tests/test_ai_flavor_gold.py。

用法（仓库根目录）：
    python3 tools/score_card.py cards/zh/*/card.md [--json]
退出码：任一卡 <75 分返回 1（可直接当 CI 闸门）。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.M)

# ---- 社区通行标签体系（头部卡站官方创建表单规范）----
ORIENTATION_TAGS = {"BG", "BL", "GL", "GB", "女性向", "全性向", "限左", "限右", "不限左右", "bg", "bl", "gl", "gb", "主控限女", "限女"}
WORLD_TAGS = {"近代", "现代", "古风", "科幻", "未来", "架空世界", "校园", "都市", "星际", "修仙", "武侠", "玄幻", "宫廷", "县城"}
MODE_TAGS = {"单人", "多人", "群像", "模拟器", "无限流", "系统", "攻略"}
EMOTION_TAGS = {
    "治愈", "救赎", "强制爱", "双向奔赴", "破镜重圆", "万人迷", "豪门世家", "追妻火葬场", "酸涩", "甜宠",
    "一见钟情", "虐恋", "恨海情天", "日久生情", "抓马", "搞笑", "日常", "重生", "难攻略", "反差",
    "冷脸萌", "热脸贱", "拉扯", "虐心", "狗血", "纯爱", "背德", "骨科",
}
ATTR_TAGS = {"洁", "不洁", "人外", "温柔", "熟男", "爹系", "渣男", "daddy", "坏狗", "疯批", "病娇", "小狗", "毒舌", "前任", "总裁", "杀手", "钓系", "年上", "年下", "青梅竹马", "竹马竹马", "欢喜冤家", "相爱相杀", "双强", "师徒", "金丝雀", "美强惨", "网恋", "电竞", "刑侦", "娱乐圈", "ABO", "直播", "悬疑", "同人"}

# ---- 反 AI 味负面词（图片 prompt 和正文都查）----
GENERIC_BAD = {"精美", "高清", "绝美", "唯美", "二次元", "动漫风", "高质量", "细节丰富", "电影感", "氛围感", "masterpiece", "best quality"}
# 合并冥王星【语言审查@禁词表】+ 小图书馆【去八股】+ 双人成行【禁用词表】高频黑名单
AI_FLAVOR_PHRASES = [
    # 原 v2 基础组
    "哦？有趣", "眼中闪过一丝", "嘴角勾起一抹", "危险的气息", "让我看看", "似笑非笑", "低沉磁性", "不容置疑", "宠溺",
    # 烂大街动作（冥王星/双人成行）
    "张了张嘴", "抿成一条直线", "鼻子一酸", "指节泛白", "青筋暴起", "呼吸一滞", "倒吸一口凉气", "喉结微滚", "浑身一震", "身子一僵", "眸色一沉", "邪魅一笑",
    # 廉价修辞（三家共识）。v10.7 gold 校准：裸「一丝/一抹/带着几分」人类描景也用（一丝凉意/
    # 一抹夕阳），移到下方 AI_FLAVOR_REGEX 只在「搭情绪词」时命中，消除对人类的误伤。
    "不易察觉", "无法形容", "难以描述", "不可名状", "某种东西", "某种情绪",
    # 烂大街比喻
    "石子投入", "泛起涟漪", "像淬了", "像触电", "像小兽", "像烙铁", "碎掉的玻璃",
    # 权力/战争/宗教隐喻（去八股）
    "献祭", "虔诚地", "猎人与猎物", "游戏才刚开始", "防线崩塌", "溃不成军", "四肢百骸",
    # 伪科学解剖腔
    "瞳孔骤缩", "肾上腺素", "毛细血管",
    # 情色油腻八股（小图书馆去油腻）
    "身体却很诚实", "娇喘如兰", "软成一滩水",
    # v9 情绪解说套语（星野/猫箱同题对比——旁白替读者翻译情绪 = 解说症）
    "显然是", "眼中满是", "并非真要", "夹杂着一丝", "透着一股", "语气中带着", "看得出", "分明是",
]
# "几个字"式强调（"三个字，却…"）与否定-肯定拖沓句式单独用正则查
AI_FLAVOR_REGEX = [
    (r"[一二三四五六七八九十]个字[，,]", "『N个字』式强调"),
    (r"不是[^，。]{1,12}[，,]\s*而是", "『不是A而是B』拖沓句式"),
    # v9 解说症句式：旁白在动作后接情绪归因从句
    (r"[，,]\s*(?:显然|似乎|好像)[^，。]{0,14}(?:心事|情绪|慌乱|心虚|羞恼|动摇)", "解说症（旁白翻译情绪）"),
    # v10.7 · 「一丝/一抹/带着几分」+ 心理状态词 = 解说症（裸用/接景物词如凉意暖意不计——人类描景常用）
    (r"(?:一丝|一抹|带着?几分|带着?一丝)[^，。、\s]{0,3}(?:慌乱|不安|委屈|愠怒|讥诮|嘲讽|心疼|警惕|戒备|落寞|狼狈|不甘|挣扎|了然|错愕|动摇|不耐|嫌恶|情绪)", "廉价情绪修辞（一丝/一抹/带着几分+情绪）"),
]

# ---- v10.6/v10.7 卡面文案句式病灶（SKILL §2.6）----
# 特征挖掘实证原则（内部特征挖掘实验 + gold 语料区分度实测）：
#   1. 密度而非单点：状态栏/内心 OS/单个「一丝」人类基线全过半（9/14、8/14、6/14），不是 AI 判据；
#      只有簇状高密度或点题位命中才计病灶（「半X」阈值 ≥3 即此原则）。
#   2. 结构层 regex 抓不到：当代 AI 卡把词汇层规避到位，AI 味在「细节密度均匀/零闲笔/结构完美」
#      的整体纹理里——开场白裸文本上句式 tic 密度人类/AI 都≈0，括号独白容器/破折号旁白等候选
#      对 v1.1 零区分度（会误杀自己），一律不落地。真值最终靠真人抽检，不迷信 regex 全覆盖。
# 扫描范围 = Description + Creator Notes + 开场白旁白（此前反 AI 味只扫开场白+示例对话，
# Description/作者的话完全脱检——评分 91.2 的卡被用户一眼判 AI 的直接原因）。
# 配额制：引语点题/「唯一的X」允许 1 处（梗位），第 2 处起计违规。
PROSE_TIC_QUOTA = [
    # (正则, 标签, 免费配额)
    (r"说(?:那)?是[「\"『]|被撞见就[^，。]{0,6}说|问(?:起来?)?就(?:说|是)", "引语点题（设定让角色说俏皮话盖章）", 1),
    (r"唯一的?(?:一个|一件|一样|一双|一处)?[^，。]{1,12}是", "『唯一的X是Y』模具", 1),
    (r"不[带沾][^，。]{1,8}[，,]\s*(?:全|净|都)是", "『不带X全是Y』对仗翻转", 0),
]
# 生造概念词/机制词——只许在 system_prompt/世界书活动，出现在可见文案即命中
PROSE_CONCEPT_WORDS = ["事实句", "胜利锚点", "情绪锚点", "行为道谢", "解冻进度", "的保护色", "反向指标", "进度条"]
# Creator Notes 产品腔（作者的话必须是社区碎碎念口吻；"用户"不进表——社区偶写"用户自拟"会误伤）
CREATOR_PRODUCT_WORDS = ["对标", "差异化", "玩法核心", "机制", "体系", "结构化", "转化率", "心智"]

# ---- 指令族 ----
CMD_FAMILY = {
    "剧情控制": ["暂停剧情", "暂停当前剧情", "推进剧情", "推动剧情", "禁止输出正文", "仅输出", "独立番外"],
    "社交模拟": ["朋友圈", "论坛", "线上聊天", "微博", "热搜", "社交账号", "po文", "日记", "群聊", "发消息", "发送消息", "翻看手机", "查看手机", "聊天界面", "聊天记录", "收件箱", "查看案头", "书帖", "邸报", "来信", "书信", "寄信", "信站"],
    "记忆管理": ["记忆区", "整理记忆", "总结剧情", "长期记忆", "短期记忆", "记忆序号", "整理案卷", "存档", "压成"],
    "时间线if": ["时间线", "时间推回", "世界观架空", "副本", "if线", "金手指"],
}

# ---- 作者的话七要素 ----
CREATOR_ELEMENTS = {
    "性向洁度声明": ["限左", "限右", "限女", "全性向", "女性向", "洁", "不洁", "禁4i", "主控限"],
    "图源署名": ["图源", "头像来自", "买断", "禁盗", "二传", "美化：", "美化:", "画师", "@"],
    "模型推荐": ["模型推荐", "推荐模型", "只推荐", "模型只", "建议模型", "推荐使用"],
    "玩法教学": ["指令", "悬浮窗", "括号大法", "面具", "自设", "$"],
    "更新日志": ["更新", "修改", "新增", "修正", "v2", "v1."],
    "故障自救": ["爆代码", "删除空行", "重roll", "重新生成", "格式错误", "框套框"],
    "风味文案": [],  # 由长度和口语度近似判断
}


def parse_card(path: Path) -> dict[str, Any]:
    text = path.read_text("utf-8")
    front: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            raw = text[3:end].strip()
            body = text[end + 4:]
            key = None
            for line in raw.splitlines():
                if re.match(r"^\s", line) and key:
                    front[key] += "\n" + line.strip()
                    continue
                if ":" not in line:
                    continue
                key, val = line.split(":", 1)
                key = key.strip()
                front[key] = val.strip().strip("'\"")
    sections: dict[str, str] = {}
    matches = list(SECTION_RE.finditer(body))
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections[m.group(1).strip().lower()] = body[start:end].strip()
    return {"path": str(path), "text": text, "front": front, "sections": sections}


def sec(card: dict[str, Any], *names: str) -> str:
    out = []
    for n in names:
        v = card["front"].get(n) or card["front"].get(n.lower()) or ""
        if v:
            out.append(str(v))
        v2 = card["sections"].get(n.lower())
        if v2:
            out.append(v2)
    return "\n".join(out)


def split_tags(raw: str) -> list[str]:
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    return [x.strip().strip("'\"") for x in re.split(r"[,，、|/]", raw) if x.strip()]


def strip_html(s: str) -> str:
    s = re.sub(r"<style[\s\S]*?</style>", "", s, flags=re.I)
    s = re.sub(r"<script[\s\S]*?</script>", "", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return s


def clamp(v: float, hi: float) -> float:
    return max(0.0, min(hi, v))


def ai_flavor_scan(
    first_prose: str,
    examples: str = "",
    desc: str = "",
    personality: str = "",
    scenario: str = "",
    creator: str = "",
) -> dict[str, Any]:
    """反 AI 味打分（0-5，扣分制）。抽成独立函数供 score_card 复用 + gold 回归测试吃裸开场白文本。

    - flavor（黑名单词/正则）扫叙事输出（开场白+示例对话）
    - prose_tic（v10.6 句式配额/生造词/产品腔/伪精确数字）扫全部可见文案
    裸文本模式：只传 first_prose 即可（其余留空，等价于「只有开场白」的卡）。
    """
    narrative = first_prose + "\n" + examples
    scan_text = narrative
    for legit in ("一丝不苟", "纹丝不动", "一抹布", "不易察觉——不"):
        scan_text = scan_text.replace(legit, "")
    flavor_hits = [p for p in AI_FLAVOR_PHRASES if p in scan_text]
    flavor_hits += [label for pat, label in AI_FLAVOR_REGEX if re.search(pat, scan_text)]
    tail = first_prose.rstrip()[-60:]
    if re.search(r"(等待?着?你的|他在等你|静静地?等待|期待着你)", tail):
        flavor_hits.append("『他在等你』式说明收束")
    tokens = re.findall(r"[\u4e00-\u9fff]{2,4}", first_prose)
    dup_ratio = (len(tokens) - len(set(tokens))) / max(len(tokens), 1)

    visible_prose = "\n".join([desc, personality, scenario, first_prose])
    tic_hits: list[str] = []
    for pat, label, quota in PROSE_TIC_QUOTA:
        n = len(re.findall(pat, visible_prose))
        if n > quota:
            tic_hits.append(f"{label}×{n}（配额{quota}）")
    tic_hits += [f"生造概念词『{w}』" for w in PROSE_CONCEPT_WORDS if w in visible_prose]
    tic_hits += [f"作者的话产品腔『{w}』" for w in CREATOR_PRODUCT_WORDS if w in creator]
    # 「第X天」边界：汉字数词形态（第二天/第三天）是时序连接词不是伪精确数字——只保留
    # 真伪精确形态：阿拉伯数字「第47天」恒计；汉字数词仅在后接数字/钟点（「第三天9点」）时计。
    precise_nums = re.findall(r"\d+\s*秒\s*\d+|\d{1,2}:\d{2}|第\d+天|第[一二三四五六七八九十]+天(?=的?\s*[0-9时：:])|[−-]\d+\s*天|\d+\.\d+\s*秒", visible_prose)
    if len(precise_nums) > 3:
        tic_hits.append(f"伪精确数字×{len(precise_nums)}（配额3）")
    # v10.7 · 「半X」量词模具（特征挖掘子 agent 发现的伪精确变体：停顿了半秒/退后半步/快了半拍）。
    # 人类基线 0、AI 簇状出现；单次/零散不算（人类偶用 + v1.1 已上线卡最多 2 处），
    # 密度 ≥3 处才计——抓簇状堆砌，不误伤零散使用（阈值据内部特征挖掘实验定）。
    half_units = re.findall(r"半(?:秒|拍|步|晌|寸|息)", visible_prose)
    if len(half_units) >= 3:
        tic_hits.append(f"「半X」量词模具×{len(half_units)}（配额2）")

    # v10.7 权重校准（gold 判例集实证，回归锁见 tools/tests/）：
    # 孤立套话词（「一丝」「带着几分」）人类热门卡也用——单词命中降权，句式 tic（引语点题/
    # 对仗/生造词/伪精确）才是 AI 判别力所在，保持高权重。降权前人类 avg 4.55<AI 4.90（误杀），
    # 降权后人类不再被孤立词拖下水，AI 味信号集中到句式层。
    FLAVOR_W, TIC_W = 0.6, 1.2
    score = clamp(5 - len(flavor_hits) * FLAVOR_W - len(tic_hits) * TIC_W - (dup_ratio * 10 if dup_ratio > 0.35 else 0), 5)
    return {"score": score, "ai_flavor_hits": flavor_hits, "prose_tic_hits": tic_hits,
            "dup_ratio": round(dup_ratio, 3)}


def score_card(card: dict[str, Any]) -> dict[str, Any]:
    text = card["text"]
    front = card["front"]
    tags = split_tags(str(front.get("tags", "")))
    tagset = set(tags)
    first = sec(card, "first_mes", "first message", "开场白", "greeting")
    first_prose = strip_html(first)
    desc = sec(card, "description", "简介", "描述")
    personality = sec(card, "personality", "性格")
    scenario = sec(card, "scenario", "场景")
    examples = sec(card, "mes_example", "example dialogue", "对话示例")
    system = sec(card, "system_prompt", "system prompt")
    creator = sec(card, "creator notes", "creator_notes", "作者注", "作者的话")
    image_prompt = sec(card, "image_prompt", "image prompt", "生图提示词")
    detail: dict[str, Any] = {}

    # ============ A. 字段完整度 (13) ============
    alt_greet = bool(re.search(r"^##\s+(alternate greeting|alt greeting|备选开场白|备用开场白)", card["text"], re.M | re.I))
    required = {
        "name": bool(front.get("name")),
        "desc>=120": len(desc) >= 120,
        "personality>=100": len(personality) >= 100,
        "scenario>=60": len(scenario) >= 60,
        "first_mes": len(first_prose) >= 300,
        "examples>=2轮": examples.count("{{user}}") >= 2 or examples.count("user:") >= 2,
        "system_prompt>=80": len(system) >= 80,
        "creator_notes": len(creator) >= 60,
    }
    completeness = clamp(sum(required.values()) / len(required) * 12 + (1 if alt_greet else 0), 13)
    detail["required"] = {k: bool(v) for k, v in required.items()}
    detail["required"]["alt_greeting(加分)"] = alt_greet

    # ============ B. 开场白结构 (18) ============
    # B1 长度落社区热门卡 P25-P90 区间 (800-2600 中文字符为满分带，300-800/2600-4000 半分带)
    n = len(first_prose)
    if 800 <= n <= 2600:
        len_pts = 5.0
    elif 300 <= n < 800 or 2600 < n <= 4000:
        len_pts = 3.0
    elif n > 0:
        len_pts = 1.0
    else:
        len_pts = 0.0
    # B2 四件套
    # v10.6 · 时段词（清晨/傍晚/深夜…）也算时间条——句式纪律压伪精确数字后，
    # 「傍晚 18:40」会写成「傍晚」，不能反过来逼卡面回填精确钟点（宋知夏 v1.1 实例）。
    has_timeloc = bool(re.search(r"(时间|📅|🕰|🏮|🏁|地点|📍|\d{4}[./年]|\d{1,2}:\d{2}|周[一二三四五六日]|[子丑寅卯辰巳午未申酉戌亥]时|[一二三四五六七八九十元]+年|清晨|拂晓|黎明|早晨|上午|正午|午后|黄昏|傍晚|入夜|深夜|凌晨|夜里|晚上)", first[:600]))
    has_event = bool(re.search(r"(正在|突然|此刻|刚刚|就在|响起|传来|打断|撞|摔|泼|砸|逼近|吵|炸|掀开|撕开|发抖|颤|捞|崩|停住|僵住|爆|飘来|窜|震了)", first_prose))
    has_dialogue = bool(re.search(r"[“\"「][^”\"」]{2,}[”\"」]|<message>", first))
    has_user_hook = bool(re.search(r"(你|\byou\b|{{user}})", first_prose, re.I))
    quad = [has_timeloc, has_event, has_dialogue, has_user_hook]
    quad_pts = sum(quad) * 2.0
    # B3 结构组件：状态面板/折叠/心声
    has_panel = bool(re.search(r"<details|<summary|状态栏|待载入|\[待", first, re.I))
    has_os = bool(re.search(r"(心声|内心|OS|os：|腹诽)", first))
    comp_pts = (2.0 if has_panel else 0.0) + (1.0 if has_os else 0.0) + (2.0 if len_pts >= 3 and sum(quad) >= 3 else 0.0)
    greeting = clamp(len_pts + quad_pts + comp_pts, 18)
    detail["greeting"] = {"prose_len": n, "时间地点条": has_timeloc, "进行中事件": has_event, "角色台词": has_dialogue, "user钩子": has_user_hook, "状态面板": has_panel, "心声": has_os}

    # ============ C. 活人感九写法 (24) ============
    # system_prompt 里的扮演风格/口癖声明也算活人感证据
    whole = first + "\n" + personality + "\n" + examples + "\n" + desc + "\n" + system
    w = {}
    w["微行为瑕疵"] = bool(re.search(r"(已读|不回|装死|删删|打了又删|倒扣|敷衍|翻白眼|挂断|拉黑|晾|口是心非|嘴硬|结巴|磨蹭|拖延|头也不抬|停了半拍|欲言又止|撤回|顿了一下|停了一下|停住|僵住|卡壳|愣住|别过脸|别过头|咬住|刹住)", whole))
    w["言行不一致"] = bool(re.search(r"(嘴上|表面|实际|其实|心里却|心声|口嫌|明明|却说|违心)", whole))
    w["拒绝与边界"] = bool(re.search(r"(拒绝|不行|不要|滚|别烦|适可而止|睡了|不想理|冷淡|不接|敷衍|无视|懒得|不肯|死活不|不让|不许|不准|别碰|不吃这套)", whole))
    w["私生活在场"] = bool(re.search(r"(群聊|朋友圈|聊天记录|室友|损友|白月光|前任|同事|哥们|闺蜜|家人|妈|爸|经纪人|助理|经理|老板|外甥|侄|舅|姑|师傅|师兄|师妹|同学|客户|战队|队友|家仆|侍郎|同僚|上峰|下属|幕僚|管家|秘书|家政|阿姨|老板娘|军医|队长|教练|导师|辅导员|爷爷|奶奶|老祭司|族长)", whole))
    w["语言指纹"] = bool(re.search(r"(口癖|口头禅|粤语|方言|颜文字|语气词|句式|称呼|叠词|阿|喔|啵|嘖|啧|哈|欸)", whole))
    w["物理细节锚定"] = bool(re.search(r"(\d{3,}|[A-Z][a-z]+ ?[A-Z]?[a-z]*|路|街|巷|大学|中学|医院|酒店|机场|牌|型号|款)", whole))
    w["未完成事件驱动"] = bool(re.search(r"(还没|尚未|悬而未决|等待|没发出|未读|未接|欠|债|截止|deadline|之前|待办|任务)", whole))
    # v3 新增两写法（预设精华）：
    # 认知局限与误读 —— 冥王星 EPISTEMIC_FIREWALL CASE B：角色会猜错、误读、只做表面观察
    w["认知局限与误读"] = bool(re.search(r"(猜错|误会|误读|误以为|会错意|理解错|搞错|想岔|不知道|看不出|以为你?是|信息差|读不懂|摸不透|不许透视|禁止读心|表面观察)", whole))
    # 情绪惯性 —— 双人成行：上一轮情绪残留 + 习惯动作缓冲（先摸烟盒/整理袖口再说话）
    w["情绪惯性"] = bool(re.search(r"(余怒|没消气|还在气|情绪残留|惯性|缓了|平复|先[^，。]{1,8}(再|才)(开口|说话|抬头|回答)|习惯性|下意识|旧习|积攒|翻旧账|记仇|绪没过去|说完自己|后知后觉|隔了几秒|过了一会才|气得要死)", whole))
    liveness = clamp(sum(w.values()) / 9 * 21 + (3 if len(examples) >= 200 else 0), 24)
    detail["liveness9"] = w

    # ============ D. 标签四元组与赛道 (10) ============
    has_orient = bool(tagset & ORIENTATION_TAGS)
    has_world = bool(tagset & WORLD_TAGS)
    has_mode = bool(tagset & MODE_TAGS)
    has_emotion = bool(tagset & EMOTION_TAGS)
    has_attr = bool(tagset & ATTR_TAGS)
    audience = clamp((3.5 if has_orient else 0) + (1.5 if has_world else 0) + (1.5 if has_mode else 0) + (2.5 if has_emotion else 0) + (1 if has_attr else 0), 10)
    detail["tags"] = {"性向(必)": has_orient, "世界观": has_world, "模式": has_mode, "情绪钩子": has_emotion, "属性": has_attr, "count": len(tags)}

    # ============ E. 美化分层 + 指令族 (12) ============
    l1 = bool(re.search(r"(<style|style=|gradient\(|rgba\(|blur\()", text, re.I))
    l2 = bool(re.search(r"(<details|<summary|progress|待载入|状态栏)", text, re.I))
    l3 = bool(re.search(r"(聊天记录|气泡|朋友圈|论坛|微博|弹幕|收件箱|手机|彩信|短信|居民证|案牍|当票)", first))
    fam_hits = {k: any(kw in text for kw in kws) for k, kws in CMD_FAMILY.items()}
    beautify = clamp((2 if l1 else 0) + (2.5 if l2 else 0) + (2 if l3 else 0) + sum(fam_hits.values()) * 1.4, 12)
    detail["beautify"] = {"L1排版": l1, "L2组件": l2, "L3仿真界面": l3, **{f"指令族:{k}": v for k, v in fam_hits.items()}}

    # ============ E2. 世界书 (8) ============
    # ## Lorebook 章节：### 条目名 | keys: a, b | constant | depth/order/prob/secondary/sticky/...
    lore_body = sec(card, "lorebook", "world book", "世界书")
    lore_entries = re.findall(r"^###\s+(.+?)\s*$", lore_body, re.M) if lore_body else []
    lore = 0.0
    lore_detail: dict[str, Any] = {"entries": len(lore_entries)}
    if lore_entries:
        lore += 2.0                                    # 有世界书
        lore += min(len(lore_entries), 4) * 0.5        # 条目数（≥4 满）
        headers = re.findall(r"^###\s+(.+)$", lore_body, re.M)
        has_keyed = any("keys" in h or "触发词" in h for h in headers)
        has_const = any("constant" in h or "常开" in h for h in headers)
        lore += 1.0 if has_keyed else 0                # 有触发词条（真 lore，非全 constant）
        lore += 1.0 if has_const else 0                # 有常开功能模块
        # 功能模块（预设范式）：好感度分级 / 小剧场格式包 / NPC 档案
        has_favor = bool(re.search(r"(好感度|好感区间|行为分级|阈值)", lore_body))
        has_theater = bool(re.search(r"(小剧场|剧场|输出格式|界面模拟)", lore_body))
        has_npc = bool(re.search(r"(NPC|人物档案|配角|关系网)", lore_body))
        lore += 1.0 if has_favor else 0
        lore += 0.5 if has_theater else 0
        lore += 0.5 if has_npc else 0
        # v5 加分项（各 0.5，上限仍 8）：高级 meta / 事件书五件套 / 语料条或指导条
        has_adv_meta = any(re.search(r"(prob|secondary|sticky|cooldown|group)\s*:", h) for h in headers)
        has_eventbook = bool(re.search(r"(剧情内容|玩家互动与分支|触发关键词|剧情目标)", lore_body))
        has_corpus = any(re.search(r"(语料|台词样本|口头禅|演绎手册|指导)", h) for h in headers)
        lore += 0.5 if has_adv_meta else 0
        lore += 0.5 if has_eventbook else 0
        lore += 0.5 if has_corpus else 0
        # v5 扣分：巨条目（>6000 字设定倾倒）
        entry_bodies = re.split(r"^###\s+.+$", lore_body, flags=re.M)[1:]
        huge = sum(1 for b in entry_bodies if len(b.strip()) > 6000)
        lore -= huge * 1.0
        lore_detail.update({
            "触发词条": has_keyed, "常开模块": has_const, "好感度分级": has_favor,
            "小剧场包": has_theater, "NPC档案": has_npc,
            "高级meta(加分)": has_adv_meta, "事件书五件套(加分)": has_eventbook,
            "语料/指导条(加分)": has_corpus, "巨条目扣分": huge,
        })
    lore_score = clamp(lore, 8)
    detail["lorebook"] = lore_detail

    # ============ F. 图片提示词 (10) ============
    # v10 分支感知：18 风格分支各有合法句核（styles/_index.md），命中任一即给风格分；
    # 骨架通用项（竖构图/道具叙事/书法标题+印章/构图锚）跨分支不变。
    STYLE_CORES = [
        r"半写实|semi.?real|manhwa|雾面|matte",          # hanfeng
        r"写实摄影|真实照片|照片质感|photorealistic|photograph",  # realistic (v10)
        r"厚涂|impasto|油画质感",                          # anime-impasto/guofeng/gothic/impasto-jp
        r"赛璐璐|cel.?shad|平涂",                          # anime-cel
        r"吉卜力|ghibli|水彩",                             # ghibli/inkwash 水系
        r"水墨|ink.?wash|留白",                            # inkwash
        r"盲盒|手办|blind.?box|vinyl|octane",              # blindbox
        r"像素|pixel|32.?bit",                             # pixel
        r"黑白漫画|网点|manga|墨线",                        # manga-mono/amcomic
        r"蒸汽波|y2k|全息|镭射",                            # y2k
        r"多巴胺|撞色|波普",                                # dopamine
        r"二头身|chibi|Q版",                               # chibi2d
        r"梦幻光粒|体积光|ethereal|电影感光影",              # ethereal
        r"胶片|颗粒|复古|90s|city pop",                     # retro90s
    ]
    ip = image_prompt
    img = 0.0
    if ip:
        img += 1.5
        img += 1 if re.search(r"(9:16|3:4|竖|vertical|portrait)", ip, re.I) else 0
        img += 1.5 if any(re.search(p, ip, re.I) for p in STYLE_CORES) else 0
        img += 1 if re.search(r"(特写|close.?up|半身|胸像|bust|upper body|近景|七分身|全身|脸.{0,6}(占|大|位于))", ip, re.I) else 0
        img += 1 if re.search(r"(手|持|夹|拿|抱|扶|叼|holding|hand)", ip) else 0
        img += 1 if re.search(r"(暗|低饱和|dark|muted|desaturat|黑|点缀色|强调色|电影级调色|光斑|轮廓光)", ip, re.I) else 0
        img += 1 if re.search(r"(参考图|style.?refs?|edits|视线|不看镜头|低垂|斜睨|看向镜头侧|微表情)", ip, re.I) else 0
        # v5：书法标题+印章（成品卡面完成度最大单项）与骨相/颜值锚
        img += 1.5 if re.search(r"(书法|行草|题字|标题字).{0,24}(印章|落款)|印章.{0,24}(书法|行草)", ip) else 0
        img += 0.5 if re.search(r"(骨相|眉骨|下颌线|鼻梁|凤眼|颜值|美貌|绝美|气质)", ip) else 0
        # 风格句核互斥打架才扣分（韩系雾面 × 厚涂油画同现 = 拽偏），单独选厚涂系分支合法
        if re.search(r"(半写实|雾面|matte)", ip, re.I) and re.search(r"(厚涂|油画|刮刀|impasto|oil paint)", ip, re.I):
            img -= 2
        bad = set(GENERIC_BAD) & set(re.findall(r"[\u4e00-\u9fffA-Za-z ]{2,}", ip))
        img -= len(bad) * 1.5
    image_score = clamp(img, 10)

    # ============ G. 反AI味 (5, 扣分制) ============
    scan = ai_flavor_scan(first_prose=first_prose, examples=examples,
                          desc=desc, personality=personality, scenario=scenario, creator=creator)
    anti_ai = scan["score"]
    detail["anti_ai"] = {k: scan[k] for k in ("ai_flavor_hits", "prose_tic_hits", "dup_ratio")}

    cats = {
        "字段完整度": round(completeness, 1),
        "开场白结构": round(greeting, 1),
        "活人感九写法": round(liveness, 1),
        "标签与赛道": round(audience, 1),
        "美化与指令": round(beautify, 1),
        "世界书": round(lore_score, 1),
        "图片提示词": round(image_score, 1),
        "反AI味": round(anti_ai, 1),
    }
    total = round(sum(cats.values()), 1)

    issues = []
    # v5.2 genre 路由提示：按 tags 推断分类，提示对应的专属评分表（genres/ 指南 §9，44 篇全量路由）
    GENRE_ROUTES = [
        (["年上", "禁欲", "救赎"], "genre-f-yanshang-jinyu"),
        (["年下", "奶狗", "狼狗", "学弟", "姐弟恋"], "genre-f-nianxia-naigou"),
        (["校园", "青梅竹马", "学长"], "genre-f-xiaoyuan-chunai / genre-m-qingchun-xiaohua"),
        (["古风", "权谋", "宫廷"], "genre-f-gufeng-quanmou"),
        (["仙侠", "修仙", "师徒", "道侣"], "genre-f-xianxia-shitu"),
        (["病娇", "疯批", "偏执"], "genre-f-bingjiao-fengpi / genre-m-bingjiao-nv"),
        (["病弱", "体弱", "易碎", "弱身强魂"], "genre-f-bingruo-meiren"),
        (["破镜重圆", "追妻火葬场", "前任"], "genre-f-pojing-zhuiqi"),
        (["网恋", "电竞", "游戏"], "genre-f-wanglian-dianjing"),
        (["娱乐圈", "明星", "顶流"], "genre-f-yulequan"),
        (["黑道", "黑帮", "大佬"], "genre-f-heidao-dalao"),
        (["穿书", "女配", "炮灰", "快穿", "剧透"], "genre-f-chuanshu-nvpei"),
        (["吸血鬼", "狼人", "哥特", "恶魔", "骑士"], "genre-f-xifang-chaoziran"),
        (["ABO", "信息素", "标记"], "genre-f-abo"),
        (["BL", "男男", "耽美"], "genre-f-bl"),
        (["拽姐", "毒舌", "市井"], "genre-m-zhaijie-dushe"),
        (["御姐", "人妻", "年上女", "姐系"], "genre-m-yujie-renqi"),
        (["母系", "温柔乡", "包容", "恒温"], "genre-m-muxi-baorong"),
        (["甜妹", "元气", "小太阳"], "genre-m-tianmei-yuanqi"),
        (["后宫", "多人", "多女主"], "genre-m-hougong-duoren"),
        (["NTR", "NTL", "背德"], "genre-m-ntr-beide"),
        (["GL", "百合", "女女"], "genre-m-gl-baihe"),
        (["系统", "模拟器", "养成"], "genre-u-xitong-moniqi"),
        (["世界卡", "无限流", "副本"], "genre-u-shijieka-wuxianliu"),
        (["异世界", "转生", "穿越", "西幻", "金手指"], "genre-u-yishijie-zhuansheng"),
        (["人外", "兽耳", "妖怪", "龙娘", "机娘", "非人"], "genre-u-renwai-feiren"),
        (["群像", "团队", "宿舍"], "genre-u-qunxiang"),
        (["同人", "二创"], "genre-u-tongren"),
        (["整活", "抽象", "沙雕", "喜剧", "迷因"], "genre-u-zhenghuo-xiju"),
        (["恐怖", "惊悚", "怪谈", "暗黑童话"], "genre-u-anhei-jingsong"),
        (["权力交换", "调教", "主导", "臣服", "契约关系"], "genre-u-quanli-jiaohuan"),
        (["伪骨科", "继兄妹", "义兄妹", "名义家人"], "genre-u-weiguke-jinji"),
        (["悬疑", "刑侦", "探案", "法医", "侦探"], "genre-u-xuanyi-zhentan"),
        (["民俗", "灵异", "天师", "道士", "驱邪"], "genre-u-minsu-lingyi"),
        (["赛博朋克", "赛博", "科幻", "废土", "义体", "AI"], "genre-u-saibo-kehuan"),
        (["民国", "年代", "旧上海", "乱世"], "genre-u-minguo-niandai"),
        (["武侠", "江湖", "侠客", "镖局", "客栈"], "genre-u-wuxia-jianghu"),
        (["异能", "觉醒", "超能力", "测评"], "genre-u-dushi-yineng"),
        (["重生", "二周目", "重来", "复仇"], "genre-u-chongsheng-ershiu"),
        (["恋综", "恋爱综艺", "观察室", "心动信号"], "genre-u-lianzong-jiemu"),
        (["女性视角", "扮演女性", "她视角", "coser"], "genre-s-nvxing-shijiao"),
        (["TS", "性转", "变身", "男娘", "伪娘", "假小子"], "genre-s-ts-xingzhuan"),
        (["双人", "双角色", "姐妹花", "双子"], "genre-s-shuangren-shuangjue"),
        (["即时场景", "快餐", "单场景", "速热"], "genre-s-jishi-changjing"),
        (["插图", "图文", "立绘", "CG", "图鉴"], "genre-s-chatu-tuwen"),
    ]
    matched_genres = [route for kws, route in GENRE_ROUTES if tagset & set(kws)]
    if matched_genres:
        detail["genre_hint"] = matched_genres
        issues.append(f"[分类路由] 通用分过线后还须过专属评分表: skills/character-card-author/genres/{' + '.join(matched_genres[:2])} §9")
    if completeness < 11:
        missing = [k for k, v in required.items() if not v]
        issues.append(f"字段缺失: {', '.join(missing)}")
    if greeting < 13:
        miss4 = [k for k, v in detail["greeting"].items() if v is False]
        issues.append(f"开场白弱: {', '.join(miss4)}")
    if liveness < 16:
        miss9 = [k for k, v in w.items() if not v]
        issues.append(f"活人感缺: {', '.join(miss9)}")
    if not has_orient:
        issues.append("缺性向标签（官方必选：BG/BL/GL/GB/女性向/全性向/限左/限右/不限左右）")
    if beautify < 7:
        issues.append("美化/指令不足：至少 L1+L2 + 两个指令族")
    if lore_score < 4:
        issues.append("世界书弱：## Lorebook 至少 5 条（好感度分级/功能模块 constant + 触发词条），格式 `### 名 | keys: a,b | order: N`，进阶 prob/secondary/事件书见 skill §4.5")
    if image_score < 6:
        issues.append("图片提示词不合成品卡面配方（18 风格分支句核任选其一/竖构图/构图锚/道具叙事/光色叙事/书法标题+印章/骨相颜值锚——styles/_index.md）")
    if anti_ai < 3.5:
        issues.append(f"AI味过重: {scan['ai_flavor_hits'] + scan['prose_tic_hits']}")

    return {"path": card["path"], "score": total, "categories": cats, "issues": issues, "detail": detail, "tags": tags}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cards", nargs="+")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    results = [score_card(parse_card(Path(p))) for p in args.cards]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"{r['path']}: {r['score']}/100")
            for k, v in r["categories"].items():
                print(f"  - {k}: {v}")
            for i in r["issues"]:
                print(f"  ! {i}")
    return 1 if any(r["score"] < 75 for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
