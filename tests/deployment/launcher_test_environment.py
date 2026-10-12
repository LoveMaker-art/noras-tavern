"""Select the actual Node used by launcher tests without accepting a shim."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


class NodeTestFixtureError(RuntimeError):
    code = 'LAUNCHER_TEST_NODE_INVALID'

    def __init__(self, message, command=None):
        super().__init__(f'{self.code}: {message}')
        self.context = {'node': command, 'pythonExecutable': sys.executable,
                        'pythonPrefix': sys.prefix, 'pythonBasePrefix': sys.base_prefix}


def resolve_node(*, required=False, env=None):
    environment = os.environ if env is None else env
    explicit = environment.get('NORA_TEST_NODE')
    if 'NORA_TEST_NODE' in environment and not explicit:
        raise NodeTestFixtureError('NORA_TEST_NODE is explicitly empty.')
    command = explicit or shutil.which('node', path=environment.get('PATH', os.defpath))
    if not command:
        if required:
            raise NodeTestFixtureError('Set NORA_TEST_NODE to a real Node executable.')
        return None
    try:
        result = subprocess.run([command, '-p',
            'JSON.stringify({executable:process.execPath,node:process.versions.node,bun:process.versions.bun})'],
            env=environment, text=True, capture_output=True, check=True, timeout=10)
        identity = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise NodeTestFixtureError(f'Cannot inspect Node test fixture {command!r}: {error}', command) from error
    if not isinstance(identity, dict) or not identity.get('node') or identity.get('bun'):
        raise NodeTestFixtureError(f'Test fixture must be real Node, not a compatibility shim: {command!r}', command)
    actual = identity.get('executable')
    expected = shutil.which(command, path=environment.get('PATH', os.defpath))
    try:
        matched = bool(actual and expected and Path(actual).samefile(expected))
    except (OSError, TypeError, ValueError):
        matched = False
    if not matched:
        raise NodeTestFixtureError(f'Node fixture executed another interpreter: {command!r} -> {actual!r}', command)
    return str(Path(actual).resolve())
