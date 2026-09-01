"""Bounded retirement of the former owner-confirmation bridge, not gateway control."""
import json
from pathlib import Path

PLUGIN = 'tavern-update-activation'
# Official rc.2 entry files; earlier owned versions also require installed hashes.
OFFICIAL = {'__init__.py': 'd3b582bdac4d698ef8a4b4ba9a48422c96871e30298d6e5fb052b0f18b67f832',
            'plugin.yaml': '3d5032b36fc30d06c184333d125f01e602f67f5a424112d6c75abcb421167abc'}


def review(home):
    from update import safe, sha
    root = safe(home / 'tavern-updates-v2')
    baseline = json.loads((root / 'installed.json').read_text()) if (root / 'installed.json').exists() else {}
    directory = safe(home / 'plugins' / PLUGIN)
    files = {}
    for file in directory.rglob('*') if directory.exists() else []:
        safe(file)
        if '__pycache__' in file.parts or file.is_dir():
            continue
        name = str(file.relative_to(directory))
        managed = 'home/plugins/' + PLUGIN + '/' + name
        if name not in OFFICIAL or sha(file) not in (OFFICIAL[name], baseline.get('files', {}).get(managed)):
            raise ValueError('Modified activation plugin; preserve and review: ' + name)
        files[managed] = sha(file)
    import yaml
    config = yaml.safe_load((home / 'config.yaml').read_text()) or {}
    plugins = config.get('plugins', {})
    enabled = plugins.get('enabled', [])
    if not isinstance(enabled, list):
        raise ValueError('Hermes plugin configuration requires review')
    owned = bool(files) or any(k.startswith('home/plugins/' + PLUGIN + '/') for k in baseline.get('files', {}))
    if PLUGIN in enabled and not owned:
        raise ValueError('Activation bridge is enabled without ownership evidence; review required')
    for path in root.glob('review-*/activation.json'):
        safe(path)
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            # Old activation files are immutable audit artifacts. A damaged
            # historical record cannot authorize a gateway mutation and is
            # preserved byte-for-byte instead of blocking bridge retirement.
            continue
        if record.get('resetReviewRequired') or record.get('status') in ('activating', 'resetting', 'interrupted-review-required'):
            raise ValueError('Interrupted activation requires owner review before bridge retirement')
    # Historical owner requests are audit records, not live configuration.
    # Retiring the bridge removes its owned code/config only and leaves records
    # immutable even if their informational status changes after review.
    return {'owned': owned, 'files': files}


def status(home):
    from update import safe
    root = safe(Path(home).absolute() / 'tavern-updates-v2')
    result = []
    for path in root.glob('review-*/activation.json'):
        value = json.loads(safe(path).read_text())
        result.append({'transaction': path.parent.name, 'status': value.get('status'),
                       'resetReviewRequired': bool(value.get('resetReviewRequired'))})
    return {'readOnly': True, 'bridge': 'retired', 'records': result,
            'next_step': 'Successful installations use the owner ClawChat /restart command.'}
