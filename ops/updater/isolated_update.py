"""Clean-release transactions, restricted to explicitly marked temporary test homes.

The public release updater remains unchanged until this path has target-host
acceptance. This adapter reuses its pinned bundle/skill/config review contract.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from bundle import PARTS
from update import Updater, NativeLifecycle, atomic, content, json_write, module_at, plan_digest, safe, sha
from python_model import load_python_model
import tree_transaction as trees

MARKER = ".tavern-isolated-update.json"


def require_isolation(home):
    home = safe(home)
    roots = {Path(tempfile.gettempdir()).resolve(), Path('/tmp').resolve()}
    if not any(root in home.parents for root in roots):
        raise ValueError("Clean transactions are restricted to temporary isolated copies; production is not enabled")
    marker = json.loads((home / MARKER).read_text()) if (home / MARKER).is_file() else {}
    if marker != {"schema": 1, "home": str(home), "purpose": "isolated-update-test"}:
        raise ValueError("Explicit isolated-copy marker is required")


class IsolatedUpdater(Updater):
    def __init__(self, home, *, lifecycle=None, port=None):
        super().__init__(home, lifecycle=lifecycle)
        require_isolation(self.home)
        self.isolated_port = port or 8799  # The default is used only by injected file-test adapters.
        self.lifecycle = lifecycle or IsolatedLifecycle(self, port=port)

    def _python_source(self):
        return (self.targets['app'] / 'backend/server.py').is_file() and not (self.targets['app'] / 'native-runtime.json').exists()

    def _configured_paths(self):
        if not self._python_source():
            return super()._configured_paths()
        expected = {'TAVERN_DATA_ROOT': self.home, 'TAVERN_APP_DIR': self.targets['app'], 'TAVERN_STATE_DIR': self.state}
        for key, target in expected.items():
            if os.environ.get(key) and Path(os.environ[key]).resolve() != target:
                raise ValueError('Custom Python installation path requires explicit mapping: ' + key)
        self._check_data_layout()

    def _check_data_layout(self):
        require_isolation(self.home)
        if self._python_source() and not (self.state / 'productions').is_dir():
            raise ValueError('Python productions directory is required')
        trees.inventory(self.state, state=True)  # Refuse unsafe state links before copying.

    def _groups(self, installer):
        result = [(part, self.targets[part]) for part in PARTS]
        result += [("home/skills/" + rel, self.home / "skills" / rel) for rel in installer.SKILLS]
        result += [("home/skills/creative/" + name, self.home / "skills/creative" / name)
                   for name in installer.RETIRED if (self.home / "skills/creative" / name).exists()]
        return result

    def review(self, directory, expected, *, candidate=False):
        result = super().review(directory, expected, candidate=candidate)
        transaction = Path(result['transaction'])
        plan = json.loads((transaction / 'plan.json').read_text())
        groups = []
        installer = module_at('isolated_release_installer', transaction / 'source/ops/scripts/install-hermes-skills.py')
        for name, target in self._groups(installer):
            old = trees.inventory(target) or {}
            extras = [rel for rel, item in old.items() if 'sha256' in item and name + '/' + rel not in plan['files']
                      and 'node_modules' not in Path(rel).parts]
            # User-installed server plugins are a supported extension location,
            # not unowned application files. Preserve them as an explicit overlay.
            plugins = [rel for rel in extras if name == 'app' and rel.startswith('engine/sillytavern/plugins/')]
            groups.append({'name': name, 'target': str(target), 'before': trees.fingerprint(target),
                           'hadOld': target.exists(), 'preservedPluginFiles': plugins,
                           'inactiveFiles': [rel for rel in extras if rel not in plugins]})
        extension_retirements = []
        native = self.state / 'native'
        for user in native.iterdir() if native.exists() else []:
            if not user.is_dir() or user.name.startswith('_'):
                continue
            for extension in (transaction / 'source/app/native-extensions').iterdir():
                old = trees.inventory(user / 'extensions' / extension.name, state=True) or {}
                new = trees.inventory(extension) or {}
                extension_retirements.extend(str((user / 'extensions' / extension.name / rel).relative_to(self.state))
                                             for rel, item in old.items() if 'sha256' in item and rel not in new)
        plan.update(isolatedClean=True, groups=groups, extensionRetirements=extension_retirements,
                    sourceRuntime='python' if self._python_source() else 'node')
        json_write(transaction / 'plan.json', plan)
        result.update(planDigest=plan_digest(plan), mode='isolated-clean',
                      inactiveCode={g['name']: g['inactiveFiles'] for g in groups if g['inactiveFiles']},
                      preservedPlugins={g['name']: g['preservedPluginFiles'] for g in groups if g['preservedPluginFiles']},
                      inactiveExtensionFiles=extension_retirements,
                      migration='Python productions -> Node Worlds on copied state; current Node state is only validated, never migrated',
                      activation='Isolated process only; no Liveware binding or Hermes gateway reload')
        return result

    def _preconditions(self, transaction, plan):
        if not plan.get('isolatedClean'):
            raise ValueError('This is not an isolated clean plan')
        super()._preconditions(transaction, plan)
        for group in plan['groups']:
            if trees.fingerprint(safe(group['target'])) != group['before']:
                raise ValueError('Target changed since review: ' + group['name'])

    def _space(self, transaction, *, prepared=False):
        # Full state is copied, not silently excluded from the space budget.
        need = sum(trees.size(p) for p in self.targets.values()) + trees.size(self.state)
        need += sum(trees.size(self.home / 'memories' / name) for name in ('USER.md', 'MEMORY.md'))
        need += trees.size(transaction / 'source')
        need += 64 * 1024 ** 2 if prepared else 1024 ** 3
        if shutil.disk_usage(self.root).free < need:
            raise ValueError(f'Insufficient disk space for complete isolated transaction: need {need} bytes')
        for target in [self.state, self.home / 'skills', self.home / 'memories', *self.targets.values()]:
            parent = target
            while not parent.exists():
                parent = parent.parent
            if parent.stat().st_dev != self.root.stat().st_dev:
                raise ValueError('Clean directory switch requires one filesystem')

    def _prepare(self, transaction, plan):
        prepared = transaction / 'prepared'
        prepared.mkdir()
        entries = []
        for i, group in enumerate(plan['groups']):
            source = prepared / str(i)
            name = group['name']
            if name in PARTS:
                shutil.copytree(transaction / 'source' / name, source, symlinks=True)
                for rel in group['preservedPluginFiles']:
                    target = source / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(Path(group['target']) / rel, target)
            else:
                for change in plan['changes']:
                    if change['name'].startswith(name + '/') and change['source']:
                        atomic(source / change['name'][len(name) + 1:], content(transaction / change['source']), change['mode'])
            entries.append({**group, 'source': str(source), 'backup': str(transaction / 'backup/trees' / str(i)),
                            'after': trees.fingerprint(source), 'state': False})
        state_copy = prepared / 'state'
        before = trees.fingerprint(self.state, state=True)
        shutil.copytree(self.state, state_copy)
        if trees.fingerprint(self.state, state=True) != before or trees.fingerprint(state_copy, state=True) != before:
            raise ValueError('State changed during snapshot; stop every writer and retry')
        extension_root = transaction / 'source/app/native-extensions'
        native = state_copy / 'native'
        users = [p for p in native.iterdir() if p.is_dir() and not p.name.startswith('_')] if native.exists() else []
        if not users:
            users = [native / 'default-user']
        for user in users:
            for extension in extension_root.iterdir():
                target = user / 'extensions' / extension.name
                if target.exists():
                    # Only prepared copied state; originals remain in the old tree.
                    shutil.rmtree(target)
                shutil.copytree(extension, target)
        migration = self.lifecycle.migrate(transaction, state_copy)
        json_write(transaction / 'migration.json', migration)
        entries.append({'name': 'state', 'target': str(self.state), 'source': str(state_copy),
                        'backup': str(transaction / 'backup/state'), 'hadOld': True,
                        'before': before, 'after': trees.fingerprint(state_copy, state=True), 'state': True})
        # Story Profile projections live outside tavern-state. Include exactly
        # its two shared Markdown destinations, not the entire Hermes home.
        for name in ('USER.md', 'MEMORY.md'):
            target = safe(self.home / 'memories' / name)
            source = prepared / ('projection-' + name)
            old_hash = trees.fingerprint(target, state=True)
            if target.exists():
                shutil.copy2(target, source)
            if trees.fingerprint(source, state=True) != old_hash:
                raise ValueError('Projection changed during snapshot: ' + name)
            entries.append({'name': 'projection:' + name, 'target': str(target), 'source': str(source),
                            'backup': str(transaction / 'backup/projections' / name), 'hadOld': target.exists(),
                            'before': old_hash, 'after': old_hash, 'state': True})
        group_names = [g['name'] + '/' for g in plan['groups']] + ['home/tavern-state/']
        # Host-wide context/config and legacy entries outside replaced trees
        # still use exact reviewed bytes, but share this same transaction journal.
        for change in plan['changes']:
            if any(change['name'].startswith(prefix) for prefix in group_names):
                continue
            target = self._target(change['name'])
            source = prepared / ('host-' + str(len(entries)))
            if change['source']:
                atomic(source, content(transaction / change['source']), change['mode'])
            entries.append({'name': change['name'], 'target': str(target), 'source': str(source),
                            'backup': str(transaction / 'backup/host' / str(len(entries))), 'hadOld': target.exists(),
                            'before': trees.fingerprint(target), 'after': trees.fingerprint(source), 'state': False})
        return entries

    def apply(self, transaction, expected):
        with self.lock():
            require_isolation(self.home)
            for receipt in self.root.glob('review-*/receipt.json'):
                if json.loads(receipt.read_text()).get('status') not in ('rolled-back', 'isolated-installed'):
                    raise ValueError('Unfinished update requires recovery first')
            transaction, plan = self._load_plan(transaction, expected)
            if (transaction / 'receipt.json').exists():
                raise ValueError('Transaction already attempted')
            self._preconditions(transaction, plan)
            self.lifecycle.source_runtime = plan.get('sourceRuntime', 'node')
            self.lifecycle.require_offline()
            self._space(transaction)
            self.lifecycle.prepare(transaction)
            self._preconditions(transaction, plan)
            self._space(transaction, prepared=True)
            entries = self._prepare(transaction, plan)
            self._preconditions(transaction, plan)
            self.lifecycle.require_offline()
            if trees.fingerprint(self.state, state=True) != entries[len(plan['groups'])]['before']:
                raise ValueError('State changed after snapshot')
            atomic(transaction / 'backup/baseline.json', content(self.root / 'installed.json'))
            receipt = {'status': 'applying', 'planDigest': expected, 'entries': entries, 'applied': [], 'restored': [],
                       'versions': plan['versions'], 'commit': plan['commit'], 'isolatedClean': True}
            json_write(transaction / 'receipt.json', receipt)
            try:
                for i, entry in enumerate(entries):
                    if trees.fingerprint(Path(entry['target']), state=entry['state']) != entry['before']:
                        raise ValueError('Concurrent modification before switch: ' + entry['name'])
                    receipt['applied'].append(i)  # Journal BEFORE either rename.
                    json_write(transaction / 'receipt.json', receipt)
                    trees.switch(entry)
                self.lifecycle.activate(transaction)
                verification = self.lifecycle.verify(transaction)
                for name, expected_hash in plan['files'].items():
                    if sha(self._target(name)) != expected_hash:
                        raise ValueError('Installed file mismatch: ' + name)
                receipt['accepted'] = {str(i): trees.fingerprint(Path(e['target']), state=e['state']) for i, e in enumerate(entries)}
                json_write(self.root / 'installed.json', {'transaction': transaction.name, 'manifestSha256': plan['manifestSha256'],
                           'commit': plan['commit'], 'files': plan['files']})
                receipt.update(status='isolated-installed', verification=verification)
                json_write(transaction / 'receipt.json', receipt)
                return {k: v for k, v in receipt.items() if k not in ('entries', 'applied', 'restored', 'accepted')}
            except BaseException:
                # A failed receipt write (e.g. ENOSPC) must not skip recovery.
                self._recover(transaction, receipt, automatic=True)
                raise

    def _recover(self, transaction, receipt, *, automatic=False):
        if isinstance(self.lifecycle, IsolatedLifecycle):
            self.lifecycle.module_path = transaction / 'source/app/native_lifecycle.py'
        def preflight():
            for i in reversed(receipt['applied']):
                if i not in receipt['restored']:
                    trees.recovery_check(receipt['entries'][i], allow_state_change=automatic,
                                         accepted=receipt.get('accepted', {}).get(str(i)))
        preflight()
        self.lifecycle.stop()
        preflight()
        for i in reversed(receipt['applied']):
            if i in receipt['restored']:
                continue
            trees.restore(receipt['entries'][i])
            receipt['restored'].append(i)
            try:
                json_write(transaction / 'receipt.json', receipt)
            except OSError:
                # Continue restoring existing directories even if a full disk
                # prevents journal writes. Never restart until it is durable.
                pass
        atomic(self.root / 'installed.json', content(transaction / 'backup/baseline.json'))
        receipt['status'] = 'files-restored'
        json_write(transaction / 'receipt.json', receipt)
        self.lifecycle.restore(transaction)
        receipt['status'] = 'rolled-back'
        json_write(transaction / 'receipt.json', receipt)
        return {'status': receipt['status'], 'isolatedClean': True}

    def rollback(self, transaction, expected):
        with self.lock():
            require_isolation(self.home)
            transaction, plan = self._load_plan(transaction, expected)
            receipt = json.loads((transaction / 'receipt.json').read_text())
            self.lifecycle.source_runtime = plan.get('sourceRuntime', 'node')
            if not receipt.get('isolatedClean'):
                raise ValueError('Use original updater for legacy transaction recovery')
            if receipt['status'] == 'rolled-back':
                return {'status': 'rolled-back', 'isolatedClean': True}
            baseline = self.root / 'installed.json'
            if receipt['status'] == 'isolated-installed' and (not baseline.exists()
                    or json.loads(baseline.read_text()).get('transaction') != transaction.name):
                raise ValueError('A newer transaction is installed; stale rollback refused')
            return self._recover(transaction, receipt, automatic=receipt['status'] != 'isolated-installed')


class IsolatedLifecycle(NativeLifecycle):
    def __init__(self, updater, *, port):
        if not isinstance(port, int) or not 1024 <= port <= 65535 or port in (8799, 8809):
            raise ValueError('A separate isolated test port is required')
        super().__init__(updater, port=port)

    def require_offline(self):
        import socket
        if Path(os.environ.get('HERMES_HOME', '')).resolve() != self.u.home:
            raise ValueError('HERMES_HOME must point to the marked isolated copy')
        for key in ('TAVERN_PERSONALITY_FILE', 'TAVERN_HERMES_MEMORIES_DIR', 'TAVERN_HERMES_STATE_DB'):
            if os.environ.get(key):
                value = Path(os.environ[key]).resolve()
                if self.u.home not in value.parents:
                    raise ValueError('External Hermes path is not allowed in an isolated rehearsal: ' + key)
        if not self.u._python_source() and any(self.runtime().status()['processes'].values()):
            raise ValueError('Stop the isolated Tavern and all its writers before migration')
        if self.u._python_source():
            commands = subprocess.check_output(['ps', '-axo', 'command='], text=True)
            if any(str(self.u.targets['app'] / 'backend/server.py') in line for line in commands.splitlines()):
                raise ValueError('Stop the isolated Python server before migration; no process was stopped')
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', self.port)) == 0:
                raise ValueError('Isolated port is occupied; no process was stopped')

    def runtime(self):
        from update import module_at
        app = self.u.targets['app']
        module_path = getattr(self, 'module_path', app / 'native_lifecycle.py')
        module = module_at('isolated_native_runtime', module_path)
        marker = app / 'native-runtime.json'
        if not marker.exists():
            marker = Path(module_path).parent / 'native-runtime.json'
        contract = module.RuntimeContract.from_dict(json.loads(marker.read_text()))
        return module.NativeRuntime(self.u.home, app, self.u.state, contract)

    def migrate(self, transaction, state):
        if (state / 'productions').is_dir():
            model_module = module_at('python_migration_model', transaction / 'source/app/native_model_config.py')
            try:
                model = model_module.load_model_config(self.u.home / 'config.yaml')
            except (model_module.NativeModelConfigError, FileNotFoundError):
                model = None
            json_write(transaction / 'prepared/model-input.json', {'hermesModel': model, 'legacyModel': load_python_model(self.u.home)})
        result = subprocess.run(['node', str(transaction / 'source/ops/updater/prepare-state.mjs'),
                                 str(state), str(transaction / 'source/app')],
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise ValueError('Copied-state migration refused: ' + result.stderr[-4000:])
        if getattr(self, 'source_runtime', 'node') == 'python':
            module = module_at('python_migration_native', transaction / 'source/app/native_lifecycle.py')
            app = transaction / 'source/app'
            contract = module.RuntimeContract.from_dict(json.loads((app / 'native-runtime.json').read_text()))
            module.NativeRuntime(self.u.home, app, state, contract).sync_assets()
        return json.loads(result.stdout)

    def prepare(self, transaction):
        if getattr(self, 'source_runtime', 'node') != 'python':
            super().prepare(transaction)
        else:
            self.module_path = transaction / 'source/app/native_lifecycle.py'
            for part, relative in (('app', 'engine/sillytavern'), ('nora-mcp', '.')):
                subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                               cwd=transaction / 'source' / part / relative, check=True)
            if self.runtime().node_major() < 20:
                raise ValueError('Node.js 20+ required')
        # ST creates these empty public directories at startup. Materialize the
        # exact reviewed contract before tree fingerprints, not after activation.
        # Otherwise an empty backups/ directory falsely looks like a concurrent
        # code edit and prevents automatic recovery of a failed first startup.
        subprocess.run(['node', '--input-type=module', '-e', """
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIRECTORIES } from './src/constants.js';
for (const name of Object.values(PUBLIC_DIRECTORIES)) {
    const resolved = path.resolve(name);
    if (!resolved.startsWith(process.cwd() + path.sep)) throw new Error('Unsafe startup directory');
    fs.mkdirSync(resolved, { recursive: true });
}
"""], cwd=transaction / 'source/app/engine/sillytavern', check=True)

    def activate(self, transaction):
        runtime = self.runtime()
        json_write(runtime.dependencies_marker, {'schema': 1, 'node_major': runtime.node_major(), 'lock_sha256': runtime.lock_digest()})
        runtime.start(port=self.port, assets_prepared=True)

    def verify(self, transaction):
        import http.cookiejar
        import urllib.parse
        import urllib.request
        result = super().verify(transaction)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def get(route):
            with opener.open(f'http://127.0.0.1:{self.port}' + route, timeout=20) as response:
                return json.load(response)
        get('/csrf-token')
        migration = json.loads((transaction / 'migration.json').read_text())
        default = next((u for u in migration['users'] if u['user'] == 'default-user'), None)
        verified = []
        if default:
            worlds = get('/api/nora-worlds-v2/worlds')['worlds']
            ids = {world['world_id'] for world in worlds}
            if ids != set(default['active']):
                raise ValueError('Running World list does not match migration reconciliation')
            for world_id in sorted(ids):
                snapshot = get('/api/nora-worlds-v2/worlds/' + urllib.parse.quote(world_id, safe='') + '/snapshot')['snapshot']
                if snapshot['plan']['world_id'] != world_id or not snapshot['character']:
                    raise ValueError('Migrated World cannot produce an activation snapshot')
                verified.append(world_id)
        result['httpWorldSnapshots'] = verified
        if migration.get('profile'):
            profile = get('/api/nora-story-profile/card')
            stored = json.loads((self.u.state / 'story_profile.json').read_text())
            if profile['profile_revision'] != stored['revision']:
                raise ValueError('Running Story Profile does not read the preserved revision')
            result['profileRevision'] = profile['profile_revision']
        return result

    def restore(self, transaction):
        if getattr(self, 'source_runtime', 'node') == 'python':
            # The required source state was OFFLINE. Preserve that state; starting
            # the Python main() would schedule billable backlog work implicitly.
            if not self.u._python_source() or not (self.u.state / 'productions').is_dir():
                raise ValueError('Original Python installation was not restored')
            return
        self.runtime().start(port=self.port, assets_prepared=True)
