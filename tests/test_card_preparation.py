import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

import card_preparation


ROOT = Path(__file__).resolve().parents[1]


def mixed_card():
    return {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": "苏玉鸾",
            "description": "",
            "personality": "",
            "scenario": "春日的旧书院。",
            "first_mes": "苏玉鸾合上书，抬眼看向来客。",
            "character_book": {
                "name": "旧书院",
                "entries": [
                    {
                        "name": "苏玉鸾",
                        "keys": ["苏玉鸾"],
                        "content": "苏玉鸾是书院先生，二十七岁，克制而敏锐，说话简洁。",
                    },
                    {
                        "name": "沈砚",
                        "keys": ["沈砚"],
                        "content": "沈砚是负责送信的青年，谨慎、守诺。",
                    },
                    {
                        "name": "书院规矩",
                        "keys": ["书院", "禁书库"],
                        "content": "旧书院的禁书库只在月圆之夜开放。",
                    },
                ],
            },
        },
    }


def model_result():
    return {
        "main_character": {
            "source_refs": ["entry-0"],
            "profile": {
                "identity": {
                    "name": "苏玉鸾", "aliases": [],
                    "description": "旧书院先生。", "gender": "", "age": "27",
                    "species": "", "occupation": "书院先生",
                    "affiliations": ["旧书院"], "story_role": "核心角色",
                },
                "appearance": {"summary": "", "features": [], "attire": []},
                "personality": {
                    "summary": "", "traits": ["克制", "敏锐"], "values": [],
                    "motivation": "", "fears": [], "boundaries": [],
                },
                "expression": {"speech_style": "简洁", "habits": [], "mannerisms": []},
                "capabilities": {"skills": [], "powers": [], "limitations": []},
                "background": {"summary": "", "key_history": []},
            },
        },
        "supporting_characters": [{
            "name": "沈砚",
            "source_refs": ["entry-1"],
            "profile": {
                "identity": {"name": "沈砚", "description": "负责送信的青年。", "occupation": "信使"},
                "personality": {"traits": ["谨慎", "守诺"]},
            },
        }],
        "worldbook_entries": [{
            "source_refs": ["entry-2"],
            "name": "书院规矩",
            "content": "旧书院的禁书库只在月圆之夜开放。",
            "keys": ["书院", "禁书库"],
            "constant": False,
            "priority": 6,
            "category": "rule",
        }],
        "unresolved_source_refs": [],
        "warnings": [],
    }


def bundled_card():
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "顾临川",
            "description": (
                "顾临川是归潮港的调查员，冷静寡言。林夏是与他长期合作的记者，"
                "敏锐而大胆。归潮港每逢月蚀会封闭旧码头。"
            ),
            "personality": "顾临川谨慎、有责任感。",
            "scenario": "两人在旧码头调查失踪案。",
            "first_mes": "顾临川合上记录本：\"先从目击者开始。\"",
            "mes_example": "<START>\n{{user}}: 有发现吗？\n{{char}}: 还差一份证词。",
            "system_prompt": "Remain in character as 顾临川.",
        },
    }


def bundled_result():
    result = model_result()
    result["main_character"] = {
        "source_refs": ["field-description", "field-personality"],
        "profile": {
            "identity": {
                "name": "顾临川", "description": "归潮港调查员。",
                "occupation": "调查员", "affiliations": ["归潮港"],
            },
            "personality": {"traits": ["冷静", "寡言", "谨慎", "有责任感"]},
        },
    }
    result["supporting_characters"] = [{
        "name": "林夏",
        "source_refs": ["field-description"],
        "profile": {
            "identity": {"name": "林夏", "description": "与顾临川长期合作的记者。", "occupation": "记者"},
            "personality": {"traits": ["敏锐", "大胆"]},
        },
    }]
    result["worldbook_entries"] = [{
        "source_refs": ["field-description"],
        "name": "归潮港旧码头",
        "content": "归潮港每逢月蚀会封闭旧码头。",
        "keys": ["归潮港", "月蚀", "旧码头"],
        "constant": False,
        "priority": 5,
        "category": "rule",
    }]
    return result


class CardPreparationTests(unittest.TestCase):
    def test_mixed_embedded_lore_is_split_without_blank_main_profile(self):
        calls = []

        def chat(messages, **kwargs):
            calls.append((messages, kwargs))
            return json.dumps(model_result(), ensure_ascii=False)

        plan = card_preparation.prepare_card(mixed_card(), chat)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["request_options"], {"thinking_mode": False})
        self.assertEqual(plan["card"]["profile"]["identity"]["name"], "苏玉鸾")
        self.assertEqual(plan["card"]["profile"]["identity"]["occupation"], "书院先生")
        self.assertIn("<身份>", plan["card"]["description"])
        self.assertEqual(plan["card"]["first_mes"], "苏玉鸾合上书，抬眼看向来客。")
        self.assertEqual([card["name"] for card in plan["supporting_cards"]], ["沈砚"])
        entries = plan["card"]["character_book"]["entries"]
        self.assertEqual(len(entries), 1)
        self.assertIn("禁书库", entries[0]["content"])
        self.assertNotIn("苏玉鸾是", entries[0]["content"])
        self.assertNotIn("沈砚是", entries[0]["content"])
        self.assertEqual(plan["summary"]["main_character_entries"], 1)
        self.assertEqual(plan["summary"]["worldbook_entries"], 1)
        self.assertEqual(plan["summary"]["supporting_characters"], ["沈砚"])
        self.assertTrue(plan["plan_id"].startswith("prep_"))
        card_preparation.validate_plan(plan)

    def test_invalid_first_response_retries_same_model_once(self):
        responses = [
            json.dumps({**model_result(), "worldbook_entries": []}, ensure_ascii=False),
            json.dumps(model_result(), ensure_ascii=False),
        ]

        calls = []

        def chat(messages, **kwargs):
            calls.append(copy.deepcopy(messages))
            return responses.pop(0)

        plan = card_preparation.prepare_card(mixed_card(), chat)

        self.assertFalse(responses)
        self.assertEqual(plan["summary"]["worldbook_entries"], 1)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("assistant", [message["role"] for message in calls[1]])

    def test_upstream_timeout_retries_only_the_configured_model(self):
        calls = []

        def chat(_messages, **kwargs):
            model_name = (kwargs.get("model") or {}).get("model")
            calls.append(model_name)
            if len(calls) < 3:
                raise TimeoutError("upstream timed out")
            return json.dumps(model_result(), ensure_ascii=False)

        plan = card_preparation.prepare_card(
            mixed_card(),
            chat,
            model={"base": "https://api.example/v1", "model": "deepseek-v4-flash"},
        )

        self.assertEqual(calls, [
            "deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash",
        ])
        self.assertTrue(plan["summary"]["profile_ready"])

    def test_bundled_description_splits_supporting_character_and_world_lore(self):
        plan = card_preparation.prepare_card(
            bundled_card(),
            lambda *_args, **_kwargs: json.dumps(bundled_result(), ensure_ascii=False),
        )

        self.assertEqual(plan["card"]["name"], "顾临川")
        self.assertEqual([item["name"] for item in plan["supporting_cards"]], ["林夏"])
        self.assertEqual(plan["card"]["character_book"]["entries"][0]["name"], "归潮港旧码头")
        self.assertNotIn("林夏", plan["card"]["description"])
        self.assertNotIn("月蚀", plan["card"]["description"])
        self.assertEqual(plan["card"]["first_mes"], "顾临川合上记录本：\"先从目击者开始。\"")
        self.assertEqual(plan["card"]["system_prompt"], "Remain in character as 顾临川.")

    def test_character_biography_cannot_be_duplicated_into_worldbook(self):
        invalid = bundled_result()
        invalid["worldbook_entries"][0]["content"] = "林夏是记者，生活在归潮港。"
        responses = [invalid, bundled_result()]

        plan = card_preparation.prepare_card(
            bundled_card(),
            lambda *_args, **_kwargs: json.dumps(responses.pop(0), ensure_ascii=False),
        )

        self.assertFalse(responses)
        self.assertEqual(
            plan["card"]["character_book"]["entries"][0]["content"],
            "归潮港每逢月蚀会封闭旧码头。",
        )

    def test_empty_profile_is_rejected_without_fallback_card(self):
        result = model_result()
        result["main_character"]["profile"] = {"identity": {"name": "苏玉鸾"}}

        with self.assertRaisesRegex(ValueError, "主角色资料"):
            card_preparation.prepare_card(
                mixed_card(), lambda *_args, **_kwargs: json.dumps(result, ensure_ascii=False))

    def test_oversized_embedded_worldbook_is_rejected_without_truncation(self):
        source = mixed_card()
        entry = source["data"]["character_book"]["entries"][0]
        source["data"]["character_book"]["entries"] = [
            {**entry, "name": f"条目 {index}"}
            for index in range(card_preparation.MAX_WORLD_ENTRIES + 1)
        ]

        with self.assertRaisesRegex(ValueError, "不会截断"):
            card_preparation.prepare_card(
                source,
                lambda *_args, **_kwargs: json.dumps(model_result(), ensure_ascii=False),
            )

    def test_complex_card_is_batched_without_dropping_entries(self):
        source = bundled_card()
        source["data"]["character_book"] = {
            "name": "归潮港档案",
            "entries": [
                {
                    "name": f"档案 {index}",
                    "keys": [f"线索{index}"],
                    "content": (f"归潮港第 {index} 号公共记录。" * 35),
                }
                for index in range(18)
            ],
        }
        calls = []

        def chat(messages, **_kwargs):
            payload = json.loads(messages[1]["content"].split("Source card:\n", 1)[1])
            calls.append([item["source_ref"] for item in payload["sources"]])
            main_refs = []
            world_entries = []
            for item in payload["sources"]:
                source_ref = item["source_ref"]
                if source_ref.startswith("field-"):
                    main_refs.append(source_ref)
                else:
                    world_entries.append({
                        "source_refs": [source_ref],
                        "name": item["name"],
                        "content": item["content"],
                        "keys": item["keys"],
                        "constant": False,
                        "priority": 5,
                        "category": "setting",
                    })
            return json.dumps({
                "main_character": {
                    "source_refs": main_refs,
                    "profile": {
                        "identity": {"name": "顾临川", "description": "归潮港调查员。"},
                        "personality": {"traits": ["冷静", "谨慎"]},
                    },
                },
                "supporting_characters": [],
                "worldbook_entries": world_entries,
                "unresolved_source_refs": [],
                "warnings": [],
            }, ensure_ascii=False)

        plan = card_preparation.prepare_card(source, chat)

        self.assertGreater(len(calls), 1)
        entries = plan["card"]["character_book"]["entries"]
        self.assertEqual(len(entries), 18)
        self.assertEqual(
            {entry["name"] for entry in entries},
            {f"档案 {index}" for index in range(18)},
        )
        self.assertEqual(plan["summary"]["source_items"], 20)
        self.assertEqual(plan["summary"]["batches"], len(calls))

    def test_modified_plan_is_rejected(self):
        plan = card_preparation.prepare_card(
            mixed_card(), lambda *_args, **_kwargs: json.dumps(model_result(), ensure_ascii=False))
        changed = copy.deepcopy(plan)
        changed["card"]["name"] = "被修改"

        with self.assertRaisesRegex(ValueError, "已被修改"):
            card_preparation.validate_plan(changed)

    def test_server_preview_is_read_only_and_confirmed_apply_is_idempotent(self):
        source = json.dumps(mixed_card(), ensure_ascii=False)
        response = json.dumps(model_result(), ensure_ascii=False)
        script = textwrap.dedent(
            f"""
            import json
            import sys
            sys.path.insert(0, {str(ROOT / 'skill')!r})
            import server

            server.actor.chat = lambda *args, **kwargs: {response!r}
            source = json.loads({source!r})
            before = {{
                "cards": len(server.STATE_STORE.list("cards")),
                "worldbooks": len(server.STATE_STORE.list("worldbooks")),
            }}
            plan = server.ev_prepare_card({{"card": source, "source": "file"}})["preparation"]
            preview = {{
                "cards": len(server.STATE_STORE.list("cards")),
                "worldbooks": len(server.STATE_STORE.list("worldbooks")),
            }}
            first = server.ev_apply_card_preparation({{
                "preparation": plan,
                "confirm": True,
            }})
            second = server.ev_apply_card_preparation({{
                "preparation": plan,
                "confirm": True,
            }})
            after = {{
                "cards": len(server.STATE_STORE.list("cards")),
                "worldbooks": len(server.STATE_STORE.list("worldbooks")),
            }}
            print(json.dumps({{
                "before": before,
                "preview": preview,
                "after": after,
                "main_profile": first["card"]["profile"],
                "supporting": [item["name"] for item in first["supporting_cards"]],
                "reused": second["reused"],
            }}, ensure_ascii=False))
            """
        )
        with tempfile.TemporaryDirectory() as state:
            env = dict(os.environ)
            env["TAVERN_STATE_DIR"] = state
            env["TAVERN_MODEL_KEY"] = ""
            result = subprocess.run(
                [sys.executable, "-c", script],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=30,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["before"], {"cards": 0, "worldbooks": 0})
        self.assertEqual(payload["preview"], payload["before"])
        self.assertEqual(payload["after"], {"cards": 2, "worldbooks": 1})
        self.assertEqual(payload["supporting"], ["沈砚"])
        self.assertEqual(payload["main_profile"]["identity"]["occupation"], "书院先生")
        self.assertTrue(payload["reused"])


if __name__ == "__main__":
    unittest.main()
