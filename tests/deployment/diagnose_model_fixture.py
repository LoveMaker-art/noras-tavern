"""Diagnostic only: compare isolated fixture bootstrap conditions, never qualify a release."""
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ops.tests.test_model_provider_skill import LocalModelSkillTests, LEGACY_IPC_GUARD
import psutil

out = Path(os.environ['RUNNER_TEMP']) / 'model-fixture-diagnostics'
out.mkdir(exist_ok=True)
results = []

def safe(text):
    return text.replace('test-only-not-valid', '<synthetic-key>').replace('old-key', '<synthetic-old-key>')

for variant in ('baseline', 'system-root', 'preload-asyncio', 'windows-environment'):
    case = LocalModelSkillTests('test_real_custom_save_updates_launcher_not_tavern_and_creates_no_backups')
    record = {'variant': variant, 'diagnosticOnly': True}
    try:
        case.setUp()
        env = dict(case.env)
        env['PYTHONVERBOSE'] = '1'
        if variant in ('system-root', 'windows-environment'):
            for key in (('SystemRoot',) if variant == 'system-root' else ('SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT')):
                if key in os.environ:
                    env[key] = os.environ[key]
        if variant == 'preload-asyncio':
            case.guard_file.write_text('import asyncio\n' + LEGACY_IPC_GUARD, encoding='utf-8')
        p = subprocess.run([sys.executable, '-B', str(case.entry)], input=json.dumps(case.request),
                           env=env, capture_output=True, text=True, timeout=30)
        (out / (variant + '.stdout.log')).write_text(safe(p.stdout), encoding='utf-8')
        (out / (variant + '.stderr.log')).write_text(safe(p.stderr), encoding='utf-8')
        record['exitCode'] = p.returncode
        try:
            reply = json.loads(p.stdout.splitlines()[-1])
            record['reply'] = {key: reply.get(key) for key in ('ok', 'error', 'activation', 'validation')}
        except (ValueError, IndexError):
            record['reply'] = None
        record['networkGuardTriggered'] = case.network_attempts.exists()
        if case.network_attempts.exists():
            (out / (variant + '.network.log')).write_text(safe(case.network_attempts.read_text()), encoding='utf-8')
    except Exception as error:
        record['exception'] = {'type': type(error).__name__, 'message': safe(str(error))}
        (out / (variant + '.exception.log')).write_text(safe(traceback.format_exc()), encoding='utf-8')
    finally:
        if hasattr(case, 'root'):
            prefix = str(case.root).casefold()
            owned = []
            for process in psutil.process_iter(['cmdline', 'cwd']):
                try:
                    values = [process.info.get('cwd') or '', *(process.info.get('cmdline') or [])]
                    if process.pid != os.getpid() and any(str(value).casefold().startswith(prefix) for value in values):
                        owned.append(process.pid)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            record['remainingOwnedPids'] = owned
            if owned:
                case.fixture.closed = False
        try:
            case.doCleanups()
        except Exception as error:
            record['cleanup'] = type(error).__name__
        results.append(record)
        (out / 'summary.json').write_text(json.dumps({'diagnosticOnly': True, 'results': results}, indent=2), encoding='utf-8')
        print(json.dumps(record), flush=True)
