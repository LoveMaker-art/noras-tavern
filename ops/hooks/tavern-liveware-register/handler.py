import os
import subprocess
import sys
from pathlib import Path

HERMES_HOME = Path(
    os.environ.get('HERMES_HOME') or Path(__file__).resolve().parents[2]
).expanduser().resolve()
DATA_ROOT = Path(os.environ.get('TAVERN_DATA_ROOT') or HERMES_HOME)
LOG = HERMES_HOME / 'logs/tavern-liveware-register-hook.log'


def handle(event_type, context):
    if event_type != 'gateway:startup':
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a', encoding='utf-8') as log:
        log.write('gateway:startup received; spawning tavern liveware ensure\n')
        dedicated = (HERMES_HOME / 'nora-instance.json').is_file()
        command = ([str(HERMES_HOME / 'scripts/nora-instance.py'), 'recover-existing'] if dedicated else
                   [str(DATA_ROOT / 'apps/tavern-ops/updater/liveware_integration.py'),
                    '--home', str(DATA_ROOT), '--hermes-home', str(HERMES_HOME), 'startup'])
        subprocess.Popen(
            [sys.executable, '-B', *command],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )


if __name__ == '__main__':
    handle('gateway:startup', {})
