import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "app/backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import generation_service
import message_segments
import reply_format
import runtime_cast_service
import story_state_service


class RuntimeServiceRegressionTests(unittest.TestCase):
    def test_traditional_chinese_runtime_prompts(self):
        for locale in ("zh-Hant", "zh_Hant"):
            self.assertEqual(reply_format.language_code(locale), "zh-Hant")
        self.assertIn("使用繁體中文", reply_format.continue_note(response_language="zh-Hant"))
        self.assertIn(
            "所有輸出的文字值必須使用繁體中文",
            runtime_cast_service._runtime_cast_system_prompt("zh-Hant"),
        )

    def test_message_segments_detects_explicit_and_inferred_speakers(self):
        cards = [
            {"id": "c1", "name": "周婉"},
            {"id": "c2", "name": "陈雅琳"},
        ]
        text = "周婉低下头，指尖停在杯沿。\n\n「我知道了。」\n\n陈雅琳：「别急。」"
        result = message_segments.parse_actor_segments(text, cards)

        self.assertEqual(result["version"], 1)
        self.assertIn("周婉", result["speakers"])
        self.assertIn("陈雅琳", result["speakers"])
        inferred = [b for b in result["dialogue_blocks"] if b.get("inferred")]
        self.assertEqual(inferred[0]["speaker"], "周婉")
        self.assertEqual(inferred[0]["source"], "previous-single-character-narration")

    def test_reply_format_normalizes_dialogue_and_wraps_pure_narration(self):
        result = reply_format.normalize_actor_reply('周婉:"来了。"\n\n她推开门。')

        self.assertIn("周婉：「来了。」", result)
        self.assertIn("*她推开门。*", result)

    def test_generation_retry_reuses_loaded_context_without_planner(self):
        class FakeActor:
            def __init__(self):
                self.calls = []

            def perform(self, cards, worldbooks, persona, story, note, **kwargs):
                self.calls.append(kwargs)
                return "周婉：「收到。」"

        actor = FakeActor()
        production = {"story": [{"role": "user", "text": "继续"}], "response_language": "zh"}

        result = generation_service.ensure_actor_reply(
            production,
            [{"id": "c1", "name": "周婉"}],
            [],
            {},
            "",
            "",
            actor_module=actor,
            active_model=lambda: {"model": "fake"},
            effective_story_state=lambda p: {"turns": 0},
            ensure_world_language=lambda p: "zh",
            normalize_actor_reply=reply_format.normalize_actor_reply,
        )

        self.assertIn("周婉：「收到。」", result)
        self.assertEqual(len(actor.calls), 1)
        self.assertNotIn("turn_plan", actor.calls[0])

    def test_generation_failures_retry_the_same_model_five_times(self):
        class FakeActor:
            def __init__(self):
                self.models = []

            def perform(self, _cards, _worldbooks, _persona, _story, _note, **kwargs):
                self.models.append(kwargs.get("model"))
                raise TimeoutError("temporary failure")

        actor = FakeActor()
        original_sleep = generation_service.time.sleep
        generation_service.time.sleep = lambda _seconds: None
        try:
            with self.assertRaises(TimeoutError):
                generation_service.perform_loaded(
                    [], [], {}, [], "",
                    actor_module=actor,
                    model={"model": "one-active-model"},
                    story_state={},
                    response_language="zh",
                )
        finally:
            generation_service.time.sleep = original_sleep

        self.assertEqual(len(actor.models), 6)
        self.assertEqual(actor.models, [{"model": "one-active-model"}] * 6)

    def test_story_state_service_turn_boundaries_and_normalization(self):
        story = [
            {"role": "user", "text": "第一轮"},
            {"role": "char", "text": "回应一"},
            {"role": "user", "text": "第二轮"},
        ]
        self.assertEqual(story_state_service.world_turns(story), 2)
        self.assertEqual(story_state_service.compressible_story_turns(story), 1)

        p = {"story": story}
        rendered = story_state_service.story_lines_for_turns(p, 1, 1, "zh")
        self.assertIn("[第 1 轮 · 用户]", rendered)
        self.assertIn("[第 1 轮 · 故事回复]", rendered)

        raw = {
            "timeline": ["两人在大厅相遇"],
            "facts": [{"id": "fact1", "content": "周婉知道钥匙存在", "known_by": ["c1"]}],
            "open_threads": [],
            "objects": [{"id": "key", "name": "钥匙", "status": "完好", "holder": "c1", "location": ""}],
            "secrets": [],
            "scene": {"time": "", "place": "大厅", "participants": []},
            "style_notes": [],
        }
        self.assertFalse(story_state_service.story_state_shape_error(raw))
        self.assertFalse(story_state_service.story_state_reference_error(raw, {"c1", "__user__"}))
        normalized = story_state_service.normalize_story_state(raw, 1, 20, {"c1", "__user__"})
        self.assertEqual(normalized["turns"], 1)
        self.assertEqual(normalized["objects"][0]["holder"], "c1")

    def test_runtime_cast_service_validates_and_applies_durable_changes(self):
        raw = {
            "reviewed_character_ids": ["c1"],
            "user_reviewed": True,
            "field_audit": {
                "c1": {
                    "name": "keep",
                    "description": "update",
                    "age": "keep",
                    "occupation": "update",
                    "affiliations": "keep",
                    "story_role": "keep",
                    "life_status": "keep",
                    "physical_condition": "keep",
                },
                "__user__": {
                    "name": "keep",
                    "description": "keep",
                    "age": "keep",
                    "occupation": "keep",
                    "affiliations": "keep",
                    "story_role": "keep",
                    "life_status": "keep",
                    "physical_condition": "keep",
                },
            },
            "unresolved_conflicts": [],
            "character_changes": {
                "c1": {
                    "profile": {"identity": {"occupation": "医生", "description": "一名医生"}},
                    "evidence": [{
                        "turn": 1,
                        "fact": "第1轮确认她是医生",
                        "fields": ["profile.identity.occupation", "profile.identity.description"],
                    }],
                },
            },
            "user_changes": {},
            "relationship_changes": [],
        }
        roster = [{"id": "c1", "name": "周婉"}]
        previous = {
            "revision": 1,
            "applied_turn": 0,
            "characters": [{
                "id": "c1",
                "name": "周婉",
                "profile": {
                    "identity": {"name": "周婉", "description": "旧描述"},
                    "appearance": {},
                    "personality": {},
                    "expression": {},
                    "capabilities": {},
                },
                "persistent_status": {},
            }],
            "relationships": [],
        }

        self.assertFalse(runtime_cast_service._runtime_cast_review_error(raw, roster, 1, 1))
        self.assertFalse(runtime_cast_service._runtime_cast_shape_error(raw, roster, 1, 1))
        self.assertFalse(runtime_cast_service._runtime_cast_noop_error(raw, previous, {}))
        result = runtime_cast_service._normalize_runtime_cast_result(raw, previous, 1, 1, {})

        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["applied_turn"], 1)
        self.assertEqual(result["characters"][0]["profile"]["identity"]["occupation"], "医生")


if __name__ == "__main__":
    unittest.main(verbosity=2)
