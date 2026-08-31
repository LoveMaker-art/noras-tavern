"""Read the original Python built-in model without importing its server or actor.

Only the explicitly selected home is read. Never inspect the operator's other
Hermes home, start a process, validate a key over the network or print secrets.
"""
import os
from pathlib import Path
import yaml


def load_python_model(home, environment=None):
    environment = os.environ if environment is None else environment
    home = Path(home)
    config = home / 'config.yaml'
    value = yaml.safe_load(config.read_text()) if config.exists() else {}
    value = value or {}
    provider = (value.get('providers') or {}).get('clawling') or {}
    model = value.get('model') or {}
    base = environment.get('TAVERN_MODEL_BASE') or provider.get('api') or model.get('base_url') or ''
    key = environment.get('TAVERN_MODEL_KEY') or environment.get('DEEPSEEK_API_KEY') or provider.get('api_key') or model.get('api_key') or ''
    env_file = home / '.hermes-tavern/.env'
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            name, separator, text = line.strip().partition('=')
            if separator and name in ('TAVERN_MODEL_KEY', 'DEEPSEEK_API_KEY') and text:
                key = text.strip().strip('"').strip("'")
                break
    if not str(base).strip() or not str(key).strip():
        return None
    return {'provider': 'Python builtin', 'base_url': str(base).strip().rstrip('/'),
            'api_key': str(key).strip(), 'model': environment.get('TAVERN_MODEL') or 'deepseek-v4-flash',
            'context': 200000, 'max_tokens': int(environment.get('TAVERN_ACTOR_MAX_TOKENS') or 10000)}
