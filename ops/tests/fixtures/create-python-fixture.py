"""Generate a sanitized fixture with the explicitly selected original Python code.

Usage: python create-python-fixture.py /path/to/reviewed/legacy/app/backend
Prints test records, never loads a user's state, starts a server or calls models.
"""
import copy
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import card_import
from continuity_model import ensure_runtime_cast
from story_state_service import normalize_story_state
from story_ledger import story_prefix_signature, validated_story_state

cards = [card_import.normalize_card({"name": name, "description": description, "personality": "坚定",
          "scenario": "港口", "first_mes": "你终于来了。", "mes_example": "你好。"})
         for name, description in [("阿岚", "航海者"), ("清夏", "医生")]]
by_id = {card['id']: card for card in cards}
production = {"id": "prod_fixture", "name": "迁移故事", "created_at": 1785542400,
              "status": "active", "card_ids": list(by_id), "worldbook_ids": ["wb_fixture"],
              "persona": {"name": "玩家", "description": "船长"}, "response_language": "en",
              "author_note": "保持因果一致", "story": []}
with patch('time.time', return_value=1785542400):
    cast = ensure_runtime_cast(production, lambda key: by_id.get(key), lambda p: p['card_ids'])
cast['characters'][0]['profile']['identity']['occupation'] = '已晋升的大副'
cast['characters'][0]['persistent_status']['physical_condition'] = '左臂受伤'
cast['relationships'] = [{"id": "rel_fixture", "participants": [cards[0]['id'], cards[1]['id']], "description": "互相信任"}]
production.pop('cards', None)
for turn in range(1, 17):
    for role in ('user', 'char'):
        text = f"第{turn}轮{'输入' if role == 'user' else '回复'}"
        production['story'].append({"id": f"msg_{turn}_{role}", "role": role, "text": text,
                                    "ts": 1785542400 + turn, "alts": [text, "备选回复"], "active_alt": 0})
raw = {"timeline": ["抵达港口"], "facts": [{"id": "fact_1", "content": "清夏知道航线", "known_by": [cards[1]['id']]}],
       "objects": [{"id": "obj_1", "name": "罗盘", "holder": cards[0]['id'], "status": "完好", "location": "船上"}],
       "open_threads": ["寻找失踪船只"], "secrets": [], "style_notes": [],
       "scene": {"time": "夜晚", "place": "港口", "participants": [{"character_id": cards[0]['id'], "location": "码头", "activity": "等待", "condition": "受伤"}]}}
with patch('time.time', return_value=1785542416):
    ledger = normalize_story_state(raw, 15, 1000, valid_ids={'__user__', *by_id})
ledger['covered_signature'] = story_prefix_signature(production['story'], 15)
production['story_state'] = ledger
assert validated_story_state(ledger, production['story'])
empty = copy.deepcopy(production)
empty.update(id='prod_empty', name='空世界', card_ids=[], worldbook_ids=[], story=[], story_state={})
empty['runtime_cast']['characters'] = []
empty['runtime_cast']['relationships'] = []
print(json.dumps({'cards': cards, 'productions': [production, empty], 'worldbooks': [
    {'id': 'wb_fixture', 'name': '港口设定', 'entries': [{'id': 0, 'keys': ['港口'], 'content': '禁止夜航', 'constant': True}]}]}, ensure_ascii=False, indent=2))
