"""Read-only views of durable transaction evidence and separately sampled runtime.

No recovery decisions, process control, platform writes or activation occur here.
Historical receipts are not a substitute for present-tense health observations.
"""
import json
from pathlib import Path
import time
import urllib.request


TERMINAL_RECEIPT_STATUSES = frozenset({
    'rolled-back', 'installed-awaiting-hermes-reload', 'already-installed',
    'refused-before-maintenance',
})


def has_unrecovered_effects(receipt):
    """Return whether a nonterminal receipt still owns an active mutation.

    Preparing directories and recording a planned entry do not modify the live
    installation. A journaled switch that has not been restored, or an external
    Liveware action that has not been restored, does.
    """
    applied = receipt.get('applied') or []
    restored = receipt.get('restored') or []
    if not isinstance(applied, list) or not isinstance(restored, list):
        return True
    try:
        pending_switches = set(applied) - set(restored)
    except TypeError:
        return True
    if pending_switches:
        return True
    actions = receipt.get('livewareJournal', {}).get('actions') or []
    if not isinstance(actions, list):
        return True
    return any(not isinstance(action, dict) or action.get('status') != 'restored'
               for action in actions)


def data_import_result(report, transaction, state):
    """Data compatibility is separate from successful program installation."""
    if not report.get('pythonMigration'):
        return {'status': 'unchanged', 'migration': False}
    return {'status': report['status'], 'migration': True,
            'worldsImported': len(report['worlds']), 'cardsImported': report['cards'],
            'worldbooksImported': report['worldbooks'], 'profile': report.get('profile'),
            'deferredCount': len(report.get('deferred', [])), 'warnings': report.get('warnings', []),
            'archivedAuxiliaryCount': len(report.get('archived', [])),
            'reportPath': str(transaction / 'migration.json'),
            'archivePath': str(state / 'python-source'),
            'backupPath': str(transaction / 'backup/state')}


def receipt_result(receipt):
    """Shared by CLI failure output and status; preserve legacy receipt statuses."""
    receipt = receipt or {}
    status = receipt.get('status', 'unconfirmed')
    outcome = {'installed-awaiting-hermes-reload': 'installed-awaiting-owner-restart',
               'rolled-back': 'failed-rolled-back' if receipt.get('failure') else 'rolled-back',
               'reviewed': 'reviewed', 'already-installed': 'already-installed',
               'integration-pending': 'integration-pending',
               'refused-before-maintenance': 'refused-before-maintenance'}.get(status, 'recovery-required' if receipt else 'unconfirmed')
    result = {'status': status, 'outcome': outcome,
              'switchIntents': len(receipt.get('applied', [])),
              'restoredEntries': len(receipt.get('restored', [])),
              'installation': {'status': status, 'historical': True},
              'runtime': {'status': 'not-checked'},
              'liveware': {'status': 'not-verified'},
              'hermes': {'status': 'not-verified'}}
    if receipt.get('versions'):
        result.update(versions=receipt['versions'], commit=receipt.get('commit'))
    if receipt.get('next_step') and status in ('installed-awaiting-hermes-reload', 'already-installed'):
        result['next_step'] = receipt['next_step']
    elif status == 'rolled-back':
        result['next_step'] = '已恢复原版本；本次没有安装成功。需要再次更新或排查时请另行授权。'
    if receipt.get('liveware'):
        result['liveware'] = {**receipt['liveware'], 'historical': True}
    if receipt.get('dataImport'):
        result['dataImport'] = {**receipt['dataImport'], 'historical': True,
                              'active': status == 'installed-awaiting-hermes-reload'}
    # A new MCP subprocess is not the gateway's current process. Likewise a
    # local Story Profile route is not proof of its external Liveware binding.
    verification = receipt.get('verification', {})
    if verification:
        result['installation']['runtimeVerifiedAtInstall'] = verification.get('tavernHealth') is True
        result['installation']['newMcpProbed'] = bool(verification.get('newMcpProcess'))
    if status == 'installed-awaiting-hermes-reload':
        result['hermes']['status'] = 'awaiting-owner-restart'
    if receipt.get('failure'):
        result['failure'] = dict(receipt['failure'])
    if receipt.get('recoveryFailure'):
        result['recoveryFailure'] = dict(receipt['recoveryFailure'])
    if receipt.get('progress'):
        result['lastProgress'] = dict(receipt['progress'])
    return result


def observe_runtime(home, port=None):
    from update import safe
    from python_installation import python_installation
    from runtime_process import find_processes, port_open, require_listener
    from feedback import public_reason
    result = {'status': 'unknown', 'observedAt': time.time()}
    try:
        app = safe(home / 'apps/tavern-runtime')
        legacy = python_installation(app)
        script = safe(app / legacy['entry'] if legacy else app / 'engine/sillytavern/server.js')
        if not script.is_file():
            return {**result, 'reason': 'Runtime entry is missing'}
        metadata = safe(home / 'tavern-state/native-runtime/runs/production/run.json')
        if port is None and not legacy and metadata.is_file():
            port = json.loads(metadata.read_text()).get('port', 8799)
        port = port or 8799
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError('Invalid runtime port')
        result.update(sourceRuntime='python' if legacy else 'node', port=port)
        processes = find_processes(script)
        if len(processes) > 1:
            return {**result, 'reason': 'Multiple matching processes; ownership is ambiguous'}
        if not processes:
            return {**result, 'status': 'port-occupied' if port_open(port) else 'offline'}
        process = processes[0]
        result['pid'] = process['pid']
        require_listener(process, script, port)
        route, field = ('/api/health', 'ok') if legacy else ('/csrf-token', 'token')
        request = urllib.request.Request(f'http://127.0.0.1:{port}' + route)
        # Local diagnostics must not use an operator's HTTP proxy or follow a
        # redirect to an unrelated service. Read at most 64 KiB, for two seconds.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=2) as response:
            healthy = response.status == 200 and bool(json.loads(response.read(65537)).get(field))
        require_listener(process, script, port)
        return {**result, 'status': 'serving' if healthy else 'unhealthy',
                'healthEndpointReady': healthy,
                'scope': 'Owned process and local health endpoint only; no model request'}
    except (OSError, ValueError, TypeError, KeyError) as error:
        return {**result, 'reason': public_reason(error)}


def inspect(updater, transaction=None):
    from update import safe, plan_digest
    root = safe(updater.root)
    baseline_path = safe(root / 'installed.json')
    baseline = json.loads(baseline_path.read_text()) if baseline_path.is_file() else None
    if transaction is None:
        candidates = [p for p in root.glob('review-*') if safe(p).is_dir() and safe(p / 'plan.json').is_file()]
        if candidates:
            # Latest attempted/reviewed transaction, not only the last success.
            transaction = max(candidates, key=lambda p: max((p / 'plan.json').stat().st_mtime_ns,
                (p / 'receipt.json').stat().st_mtime_ns if safe(p / 'receipt.json').is_file() else 0))
    receipt, plan = None, None
    if transaction is not None:
        transaction = safe(Path(transaction).absolute())
        if transaction.parent != root or not transaction.name.startswith('review-'):
            raise ValueError('Status transaction belongs to another installation')
        plan = json.loads(safe(transaction / 'plan.json').read_text())
        updater._load_plan(transaction, plan_digest(plan))  # Layout checks, not approval for writes.
        receipt_path = safe(transaction / 'receipt.json')
        receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {'status': 'reviewed'}
        if receipt.get('planDigest') and receipt['planDigest'] != plan_digest(plan):
            raise ValueError('Receipt and plan identity differ')
    result = receipt_result(receipt)
    result.update(readOnly=True, observedAt=time.time(), transaction=str(transaction) if transaction else None,
                  installed={'transaction': baseline.get('transaction'), 'commit': baseline.get('commit')} if baseline else None)
    if plan:
        result['review'] = {'commit': plan.get('commit'), 'versions': plan.get('versions'),
                            'engineSha256': plan.get('engine', {}).get('sha256')}
    # A reviewed target port must not silently override the current runtime's
    # metadata. Only an explicitly marked isolated invocation overrides it.
    result['runtime'] = observe_runtime(updater.home, updater.isolated_port if updater.test_mode else None)
    return result
