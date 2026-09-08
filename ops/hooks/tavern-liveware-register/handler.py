import os
import subprocess
import sys
from pathlib import Path

HERMES_HOME = Path(
    os.environ.get('HERMES_HOME') or Path(__file__).resolve().parents[2]
).expanduser().resolve()
RUNNER = HERMES_HOME / 'scripts/nora-instance.py'
LOG = HERMES_HOME / 'logs/tavern-liveware-register-hook.log'


def handle(event_type, context):
    if event_type != 'gateway:startup':
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a', encoding='utf-8') as log:
        log.write('gateway:startup received; spawning tavern liveware ensure\n')
        subprocess.Popen(
            [sys.executable, '-B', str(RUNNER), 'recover-existing'],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
