"""Normalize an identified empty Python-era profile placeholder on copied state.

The historical loader checked only schema_version, so an empty installer seed
could survive despite using noncanonical field names. Populated unknown formats
remain rejected: this adapter never guesses the meaning of user content.
"""
import json
from pathlib import Path
from update import atomic, json_write


def normalize_empty_placeholder(state):
    state = Path(state)
    if state.name != 'state' or state.parent.name != 'prepared':
        raise ValueError('Profile normalization requires a prepared state copy')
    file = state / 'story_profile.json'
    if not file.exists():
        return None
    raw = file.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('schema_version') != 1:
        return None
    fields = ('preferences', 'recent_timeline', 'shared_story_memory')
    if all(isinstance(value.get(key), list) for key in fields):
        return None
    # This exact empty seed contains no preferences/events/facts to reinterpret.
    if any(key in value for key in ('recent_timeline', 'taste_profile', 'shared_story_memory')):
        return None
    if not all(key in value and value[key] == empty for key, empty in (
            ('preferences', {}), ('recent', []), ('taste', {}), ('shared_facts', []))):
        return None
    eras = state / 'profile_eras.json'
    events = state / 'profile_events.jsonl'
    if (eras.exists() and json.loads(eras.read_text()) != []) or (events.exists() and events.read_text().strip()):
        return None
    archive = state / 'python-source-profile/story_profile.json'
    if archive.exists():
        raise ValueError('Original placeholder archive already exists')
    atomic(archive, raw)
    canonical = {**value, 'preferences': [], 'recent_timeline': [], 'taste_profile': {}, 'shared_story_memory': [],
                 'stats': {**value.get('stats', {}), 'event_count': 0, 'era_count': 0}}
    json_write(file, canonical)
    return {'source': 'empty-python-placeholder', 'original': str(archive.relative_to(state)),
            'contentDiscarded': False}
