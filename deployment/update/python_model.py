"""Read an explicitly selected old provider from the target installation only.

Only the explicitly selected home is read. Never inspect the operator's other
Hermes home, start a process, validate a key over the network or print secrets.
"""
import json
from pathlib import Path
import yaml


def load_python_model(home):
    home = Path(home)
    choices = home / 'tavern-state/model_configs.json'
    try:
        choices_value = json.loads(choices.read_text()) if choices.exists() else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None  # Copied-state importer preserves and reports the bad record.
    selected = choices_value.get('active', 'builtin') if isinstance(choices_value, dict) else 'builtin'
    # "builtin" now means the target Hermes primary model. Do not manufacture
    # a Python builtin or inherit an operator/developer process's environment.
    if not isinstance(selected, str) or not selected.startswith('clawling:'):
        return None
    model_name = selected[len('clawling:'):].strip()
    config = home / 'config.yaml'
    value = yaml.safe_load(config.read_text()) if config.exists() else {}
    value = value or {}
    provider = (value.get('providers') or {}).get('clawling') or {}
    base = provider.get('api') or provider.get('base_url') or ''
    key = provider.get('api_key') or ''
    if not model_name or not str(base).strip() or not str(key).strip():
        return None
    return {'provider': 'clawling', 'base_url': str(base).strip().rstrip('/'),
            'api_key': str(key).strip(), 'model': model_name,
            'context': 200000, 'max_tokens': 10000}
