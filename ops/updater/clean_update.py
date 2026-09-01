"""Release installation with separate legacy-migration and native-update paths.

Python adoption owns a full copied-state transaction. Once Tavern is native,
ordinary releases replace managed code/configuration only; Worlds, chats,
models and Story Profile data are not review inputs or switch entries.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from bundle import PARTS
from completion import installation_guidance
from update_status import receipt_result, data_import_result
from feedback import phase, step, public_reason
from update import ReleaseReview, NativeLifecycle, atomic, content, json_write, module_at, plan_digest, safe, sha
from python_model import load_python_model
from python_installation import python_installation
from service_manager import ManagedService
import tree_transaction as trees

MARKER = ".tavern-isolated-update.json"


def require_isolation(home):
    home = safe(home)
    roots = {Path(tempfile.gettempdir()).resolve(), Path('/tmp').resolve()}
    if not any(root in home.parents for root in roots):
        raise ValueError("Test ports require a temporary isolated copy")
    marker = json.loads((home / MARKER).read_text()) if (home / MARKER).is_file() else {}
    if marker != {"schema": 1, "home": str(home), "purpose": "isolated-update-test"}:
        raise ValueError("Explicit isolated-copy marker is required")


class CleanUpdater(ReleaseReview):
    def __init__(self, home, *, lifecycle=None, port=None):
        super().__init__(home, lifecycle=lifecycle)
        self.test_mode = port is not None
        if self.test_mode:
            require_isolation(self.home)
        self.isolated_port = port or 8799
        self.lifecycle = lifecycle or CleanLifecycle(self, port=self.isolated_port)
        from liveware_integration import Integration
        self.integration = Integration(self.home, port=self.isolated_port, isolated=self.test_mode)

    def _python_source(self):
        return python_installation(self.targets['app']) is not None

    def _configured_paths(self):
        if not self._python_source():
            return super()._configured_paths()
        expected = {'TAVERN_DATA_ROOT': self.home, 'TAVERN_APP_DIR': self.targets['app'], 'TAVERN_STATE_DIR': self.state}
        for key, target in expected.items():
            if os.environ.get(key) and Path(os.environ[key]).resolve() != target:
                raise ValueError('Custom Python installation path requires explicit mapping: ' + key)
        self._check_data_layout()

    def _check_data_layout(self):
        if self.test_mode:
            require_isolation(self.home)
        if self._python_source() and not (self.state / 'productions').is_dir():
            raise ValueError('Python productions directory is required')
        if self._python_source():
            # Legacy adoption reads and converts state, so it must reject unsafe
            # links before taking the complete snapshot.
            trees.inventory(self.state, state=True)
            return
        # Native releases never parse, copy or switch user state. Keep only the
        # installation-root safety check and let Tavern own its data schemas.
        safe(self.state)

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
        python_source = self._python_source()
        groups = []
        installer = module_at('isolated_release_installer', transaction / 'source/ops/scripts/install-hermes-skills.py')
        for name, target in self._groups(installer):
            # Native code is explicitly replaceable. Inventory it only after
            # the runtime is stopped so transient runtime output cannot
            # invalidate the review. Legacy adoption still inventories the
            # exact old tree because it converts that installation.
            # The live Tavern app is the runtime-written tree. Other managed
            # code still receives a read-only safety inventory during review
            # so unsafe symlinks/special files fail before maintenance, while
            # its content snapshot remains deferred to the stopped runtime.
            old = (trees.inventory(target) or {}) if python_source or name != 'app' else {}
            extras = [rel for rel, item in old.items() if 'sha256' in item and name + '/' + rel not in plan['files']
                      and 'node_modules' not in Path(rel).parts]
            # User-installed server plugins are a supported extension location,
            # not unowned application files. Preserve them as an explicit overlay.
            plugins = [rel for rel in extras if name == 'app' and rel.startswith('engine/sillytavern/plugins/')]
            groups.append({'name': name, 'target': str(target),
                           'before': trees.fingerprint(target) if python_source else None,
                           'hadOld': target.exists(), 'preservedPluginFiles': plugins,
                           'inactiveFiles': [rel for rel in extras if rel not in plugins]})
        extension_retirements = []
        if python_source:
            native = self.state / 'native'
            for user in native.iterdir() if native.exists() else []:
                if not user.is_dir() or user.name.startswith('_'):
                    continue
                for extension in (transaction / 'source/app/native-extensions').iterdir():
                    old = trees.inventory(user / 'extensions' / extension.name, state=True) or {}
                    new = trees.inventory(extension) or {}
                    extension_retirements.extend(str((user / 'extensions' / extension.name / rel).relative_to(self.state))
                                                 for rel, item in old.items() if 'sha256' in item and rel not in new)
        plan.update(cleanTransaction=True, testMode=self.test_mode, port=self.isolated_port, groups=groups, extensionRetirements=extension_retirements,
                    liveware=(self.integration.review() if self._python_source()
                              else {'status': 'preserved-existing-registration'}),
                    sourceRuntime='python' if python_source else 'node',
                    pythonSource=python_installation(self.targets['app']))
        if isinstance(self.lifecycle, CleanLifecycle):
            self.lifecycle.module_path = transaction / 'source/app/native_lifecycle.py'
            service = ManagedService.discover(self.home, self.targets['app'])
            plan['service'] = service.descriptor if service else None
        json_write(transaction / 'plan.json', plan)
        result.update(planDigest=plan_digest(plan),
                      mode='legacy-data-migration' if plan['sourceRuntime'] == 'python' else 'native-code-replacement',
                      liveware={'status': plan['liveware']['status'],
                                'externalEntryVerified': False,
                                'recoveryLimitation': ('Original tunnel target is not exposed by the installed CLI; a changed binding may require owner recovery'
                                                       if plan['sourceRuntime'] == 'python' else
                                                       'Existing App identities and bindings are preserved without platform mutation')},
                      inactiveCode={g['name']: g['inactiveFiles'] for g in groups if g['inactiveFiles']},
                      preservedPlugins={g['name']: g['preservedPluginFiles'] for g in groups if g['preservedPluginFiles']},
                      pluginPreservation=('Server plugins are inventoried and overlaid after the runtime stops'
                                          if plan['sourceRuntime'] == 'node' else
                                          'Legacy server plugins are listed from the reviewed Python source'),
                      inactiveExtensionFiles=extension_retirements,
                      migration=('Python productions -> Node Worlds on copied state'
                                 if plan['sourceRuntime'] == 'python' else
                                 'None; native Worlds, chats, models and Story Profile data are untouched'),
                      activation=('Isolated rehearsal; do not restart the live gateway' if self.test_mode else
                                  'After successful installation, send /restart in ClawChat and wait for the Hermes restart notification'),
                      maintenance='Pause chats before apply; active Python background work blocks maintenance')
        return result

    def _preconditions(self, transaction, plan):
        if not plan.get('cleanTransaction') or plan.get('testMode') != self.test_mode or plan.get('port') != self.isolated_port:
            raise ValueError('Clean transaction mode/port differs from review')
        replaceable = ([group['name'] for group in plan['groups']]
                       if plan.get('sourceRuntime') == 'node' else [])
        super()._preconditions(transaction, plan, replaceable_roots=replaceable)
        if plan.get('sourceRuntime') == 'python' and 'liveware' in plan:
            self.integration.check(plan['liveware'])
        from activation_retirement import review as retirement_review
        if plan.get('activationRetirement') != retirement_review(self.home):
            raise ValueError('Activation state changed since review')
        if plan.get('pythonSource') != python_installation(self.targets['app']):
            raise ValueError('Python source layout changed since review')
        if isinstance(self.lifecycle, CleanLifecycle) and 'service' in plan:
            service = ManagedService.discover(self.home, self.targets['app'])
            if (service.descriptor if service else None) != plan['service']:
                raise ValueError('Service ownership/configuration changed since review')
        for group in plan['groups']:
            if plan.get('sourceRuntime') == 'python' and trees.fingerprint(safe(group['target'])) != group['before']:
                raise ValueError('Target changed since review: ' + group['name'])

    def _space(self, transaction, *, prepared=False):
        # Legacy adoption needs a full state snapshot. Native updates budget
        # only replaceable code/configuration; user data is never copied.
        need = sum(trees.size(p) for p in self.targets.values())
        if self._python_source():
            need += trees.size(self.state)
            need += sum(trees.size(self.home / 'memories' / name) for name in ('USER.md', 'MEMORY.md'))
        need += trees.size(transaction / 'source')
        need += 64 * 1024 ** 2 if prepared or not self._python_source() else 1024 ** 3
        if shutil.disk_usage(self.root).free < need:
            raise ValueError(f'Insufficient disk space for complete transaction: need {need} bytes')
        checked_targets = [self.home / 'skills', *self.targets.values()]
        if self._python_source():
            checked_targets += [self.state, self.home / 'memories']
        for target in checked_targets:
            parent = target
            while not parent.exists():
                parent = parent.parent
            if parent.stat().st_dev != self.root.stat().st_dev:
                raise ValueError('Clean directory switch requires one filesystem')

    def _prepare_code(self, transaction, plan, prepared):
        """Prepare exact managed code trees after the runtime is offline."""
        entries = []
        for i, group in enumerate(plan['groups']):
            source = prepared / str(i)
            name = group['name']
            if name in PARTS:
                shutil.copytree(transaction / 'source' / name, source, symlinks=True)
                preserved_plugins = set(group['preservedPluginFiles'])
                if name == 'app':
                    # Review is not the ownership boundary for user plugins.
                    # Re-inventory the stopped runtime so a plugin added while
                    # dependencies were prepared is preserved as user data.
                    old = trees.inventory(Path(group['target'])) or {}
                    preserved_plugins.update(
                        rel for rel, item in old.items()
                        if 'sha256' in item and rel.startswith('engine/sillytavern/plugins/')
                        and name + '/' + rel not in plan['files'])
                for rel in sorted(preserved_plugins):
                    target = source / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(Path(group['target']) / rel, target)
            else:
                for change in plan['changes']:
                    if change['name'].startswith(name + '/') and change['source']:
                        atomic(source / change['name'][len(name) + 1:], content(transaction / change['source']), change['mode'])
            before = (trees.fingerprint(Path(group['target']))
                      if plan.get('sourceRuntime') == 'node' else group['before'])
            entries.append({**group, 'before': before, 'source': str(source),
                            'backup': str(transaction / 'backup/trees' / str(i)),
                            'after': trees.fingerprint(source), 'state': False,
                            'replaceable': True})
        return entries

    def _prepare_host_entries(self, transaction, plan, prepared, entries, excluded_prefixes):
        """Add managed host files that do not belong to a replaced directory."""
        for change in plan['changes']:
            if any(change['name'].startswith(prefix) for prefix in excluded_prefixes):
                continue
            target = self._target(change['name'])
            source = prepared / ('host-' + str(len(entries)))
            if change['source']:
                atomic(source, content(transaction / change['source']), change['mode'])
            entries.append({'name': change['name'], 'target': str(target), 'source': str(source),
                            'backup': str(transaction / 'backup/host' / str(len(entries))), 'hadOld': target.exists(),
                            'before': trees.fingerprint(target), 'after': trees.fingerprint(source), 'state': False})
    def _prepare_native(self, transaction, plan):
        """Prepare code only; never copy, parse or switch native user data."""
        prepared = transaction / 'prepared'
        prepared.mkdir()
        entries = self._prepare_code(transaction, plan, prepared)
        extension_root = transaction / 'source/app/native-extensions'
        native = self.state / 'native'
        users = [p for p in native.iterdir() if p.is_dir() and not p.name.startswith('_')] if native.exists() else []
        if not users:
            users = [native / 'default-user']
        extension_prefixes = []
        for user in users:
            for extension in extension_root.iterdir():
                target = user / 'extensions' / extension.name
                source = prepared / ('extension-' + str(len(entries)))
                shutil.copytree(extension, source)
                name = 'home/' + str(target.relative_to(self.home))
                extension_prefixes.append(name + '/')
                entries.append({'name': name, 'target': str(target), 'source': str(source),
                                'backup': str(transaction / 'backup/extensions' / str(len(entries))),
                                'hadOld': target.exists(), 'before': trees.fingerprint(target),
                                'after': trees.fingerprint(source), 'state': False,
                                'replaceable': True})
        group_names = [g['name'] + '/' for g in plan['groups']]
        self._prepare_host_entries(transaction, plan, prepared, entries, group_names + extension_prefixes)
        json_write(transaction / 'migration.json', {'pythonMigration': False, 'status': 'not-run',
                   'reason': 'Native code update preserves state without inspection or copying'})
        return entries

    def _prepare(self, transaction, plan):
        if plan.get('sourceRuntime') == 'node':
            return self._prepare_native(transaction, plan)
        prepared = transaction / 'prepared'
        prepared.mkdir()
        entries = self._prepare_code(transaction, plan, prepared)
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
        self._prepare_host_entries(transaction, plan, prepared, entries, group_names)
        return entries

    def _phase(self, transaction, receipt, name, message):
        def record(event):
            receipt['progress'] = {**event, 'observedAt': time.time()}
            try:
                json_write(transaction / 'receipt.json', receipt)
            except OSError:
                # Persist the intent before a new operation. An ENOSPC during
                # recovery/reporting must not suppress the recovery itself.
                if event['status'] == 'started' and name != 'recovery':
                    raise
        return phase(name, message, record=record)

    def _step(self, transaction, receipt, name, message, operation, *args, **kwargs):
        with self._phase(transaction, receipt, name, message):
            return operation(*args, **kwargs)

    def apply(self, transaction, expected):
        with self.lock():
            if self.test_mode:
                require_isolation(self.home)
            transaction, plan = self._load_plan(transaction, expected)
            if (transaction / 'receipt.json').exists():
                raise ValueError('Transaction already attempted')
            for receipt in self.root.glob('review-*/receipt.json'):
                if json.loads(receipt.read_text()).get('status') not in ('rolled-back', 'installed-awaiting-hermes-reload', 'refused-before-maintenance', 'already-installed'):
                    self._close_pre_switch_recovery(receipt)
            receipt = {'status': 'inspecting', 'planDigest': expected, 'entries': [], 'applied': [], 'restored': [],
                       'versions': plan['versions'], 'commit': plan['commit'], 'cleanTransaction': True,
                       'engineSha256': plan.get('engine', {}).get('sha256'), 'startedAt': time.time()}
            json_write(transaction / 'receipt.json', receipt)
            def run(name, message, operation, *args, **kwargs):
                return self._step(transaction, receipt, name, message, operation, *args, **kwargs)
            try:
                run('preflight', '检查更新条件', self._preconditions, transaction, plan)
                self.lifecycle.source_runtime = plan.get('sourceRuntime', 'node')
                run('space-budget', '检查完整备份和依赖所需空间', self._space, transaction)
                baseline = json.loads((self.root / 'installed.json').read_text()) if (self.root / 'installed.json').exists() else {}
                if (baseline.get('manifestSha256') == plan['manifestSha256']
                        and all(c['before'] == c['after'] for c in plan['changes'])
                        and not any(g['inactiveFiles'] for g in plan['groups'])
                        and not plan.get('extensionRetirements')):
                    receipt['status'] = 'already-installed'
                    receipt.update(installation_guidance(receipt, isolated=self.test_mode))
                    json_write(transaction / 'receipt.json', receipt)
                    return receipt_result(receipt)
                run('dependencies', '准备新版依赖，旧版暂不停止', self.lifecycle.prepare, transaction)
                run('recheck', '准备依赖后复核安装与平台状态', self._preconditions, transaction, plan)
                run('space-budget', '复核切换所需空间', self._space, transaction, prepared=True)
                atomic(transaction / 'backup/baseline.json', content(self.root / 'installed.json'))
            except BaseException as error:
                receipt.update(status='refused-before-maintenance', failure={
                    'phase': getattr(error, 'update_phase', 'preflight'), 'reason': public_reason(error)})
                json_write(transaction / 'receipt.json', receipt)
                raise
            receipt['status'] = 'preparing'
            json_write(transaction / 'receipt.json', receipt)
            try:
                run('stop-runtime', '核验并停止旧版酒馆', self.lifecycle.pause, transaction)
                self.lifecycle.require_offline()
                phase_name = 'prepare-state' if plan.get('sourceRuntime') == 'python' else 'prepare-code'
                phase_message = ('备份并准备数据副本，转换 Python 数据' if plan.get('sourceRuntime') == 'python'
                                 else '备份并准备受管代码；用户数据保持原位')
                entries = run(phase_name, phase_message, self._prepare, transaction, plan)
                if plan.get('sourceRuntime') == 'python':
                    receipt['dataImport'] = data_import_result(
                        json.loads((transaction / 'migration.json').read_text()), transaction, self.state)
                run('recheck', '切换前复核文件与平台状态', self._preconditions, transaction, plan)
                self.lifecycle.require_offline()
                if (plan.get('sourceRuntime') == 'python'
                        and trees.fingerprint(self.state, state=True) != entries[len(plan['groups'])]['before']):
                    raise ValueError('State changed after snapshot')
                receipt.update(status='applying', entries=entries)
                json_write(transaction / 'receipt.json', receipt)
                switch_message = ('切换经过校验的程序、数据和受管配置'
                                  if plan.get('sourceRuntime') == 'python'
                                  else '切换经过校验的受管代码；用户数据保持原位')
                with self._phase(transaction, receipt, 'switch', switch_message):
                    for i, entry in enumerate(entries):
                        if trees.fingerprint(Path(entry['target']), state=entry['state']) != entry['before']:
                            raise ValueError('Concurrent modification before switch: ' + entry['name'])
                        receipt['applied'].append(i)  # Journal BEFORE either rename.
                        json_write(transaction / 'receipt.json', receipt)
                        trees.switch(entry)
                # Check immutable release bytes while the runtime is offline.
                # Startup may legitimately create or update runtime output in
                # managed trees; that must not undo a healthy installation.
                for name, expected_hash in plan['files'].items():
                    if sha(self._target(name)) != expected_hash:
                        raise ValueError('Installed file mismatch: ' + name)
                # The stopped-runtime switch result is the accepted release
                # state. Do not inventory live code after startup: generated
                # files can appear or vanish while Tavern is healthy.
                receipt['accepted'] = {str(i): entry['after'] for i, entry in enumerate(entries)}
                json_write(transaction / 'receipt.json', receipt)
                run('start-runtime', '启动新版酒馆', self.lifecycle.activate, transaction)
                verification = run('verify', '检查酒馆、故事档案和新 MCP 进程', self.lifecycle.verify, transaction)
                receipt['livewareJournal'] = {}
                if plan.get('sourceRuntime') == 'python':
                    receipt['liveware'] = run('reconcile-liveware', '对齐既有 Tavern / Story Profile 入口',
                        self.integration.apply, plan.get('liveware', {'status': 'not-configured'}),
                        receipt['livewareJournal'], lambda: json_write(transaction / 'receipt.json', receipt), refresh=True)
                else:
                    receipt['liveware'] = {'status': 'preserved-existing-registration',
                                           'externalEntryVerified': False}
                json_write(self.root / 'installed.json', {'transaction': transaction.name, 'manifestSha256': plan['manifestSha256'],
                           'commit': plan['commit'], 'files': plan['files'], 'planDigest': expected,
                           'testPort': self.isolated_port if self.test_mode else None})
                receipt.update(status='installed-awaiting-hermes-reload', verification=verification,
                               hermesReloadRequired=True, contextActivation='owner-restart-unverified')
                receipt.update(installation_guidance(receipt, isolated=self.test_mode))
                json_write(transaction / 'receipt.json', receipt)
                return {**{k: v for k, v in receipt.items() if k not in ('entries', 'applied', 'restored', 'accepted')},
                        **receipt_result(receipt)}
            except BaseException as error:
                receipt['failure'] = {'phase': getattr(error, 'update_phase', 'apply'), 'reason': public_reason(error)}
                try:
                    json_write(transaction / 'receipt.json', receipt)
                except OSError:
                    pass
                # A failed receipt write (e.g. ENOSPC) must not skip recovery.
                try:
                    recovery_message = ('更新失败，恢复原版本和迁移前数据'
                                        if plan.get('sourceRuntime') == 'python'
                                        else '更新失败，恢复原版本代码；用户数据保持原位')
                    run('recovery', recovery_message, self._recover, transaction, receipt, automatic=True)
                except BaseException as recovery_error:
                    self._record_recovery_failure(transaction, receipt, recovery_error)
                    raise
                raise

    def _close_pre_switch_recovery(self, receipt_path):
        """Close an interrupted receipt that has no unrecovered active effect.

        Prepared files are transaction-private and do not affect the active
        installation. Only unrestored rename intents or external writes need
        explicit recovery before another update.
        """
        from update_status import has_unrecovered_effects
        receipt = json.loads(receipt_path.read_text())
        if (receipt.get('status') not in ('inspecting', 'preparing', 'files-restored')
                or not receipt.get('cleanTransaction')
                or has_unrecovered_effects(receipt)):
            raise ValueError('Unfinished update requires recovery first')
        receipt.update(status='rolled-back', recoveryResolution='no-unrecovered-active-effects')
        json_write(receipt_path, receipt)

    def _record_recovery_failure(self, transaction, receipt, error):
        receipt['recoveryFailure'] = {'phase': getattr(error, 'update_phase', 'recovery'), 'reason': public_reason(error)}
        try:
            json_write(transaction / 'receipt.json', receipt)
        except OSError:
            pass  # Keep the existing durable intents; terminal output remains explicit.

    def _recover(self, transaction, receipt, *, automatic=False):
        if isinstance(self.lifecycle, CleanLifecycle):
            self.lifecycle.module_path = transaction / 'source/app/native_lifecycle.py'
        def preflight():
            for i in reversed(receipt['applied']):
                if i not in receipt['restored']:
                    trees.recovery_check(receipt['entries'][i], allow_state_change=automatic,
                                         allow_replaceable_change=automatic,
                                         accepted=receipt.get('accepted', {}).get(str(i)))
        preflight()
        if any(i not in receipt['restored'] for i in receipt['applied']):
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
        if (receipt.get('livewareJournal', {}).get('actions')
                and not self.integration.recover(receipt.get('livewareJournal', {}),
                                                 lambda: json_write(transaction / 'receipt.json', receipt))):
            receipt['status'] = 'integration-pending'
            receipt['liveware'] = {'status': 'integration-pending', 'externalEntryVerified': False,
                                  'reason': 'Local release restored; original tunnel target is not queryable. Owner must review binding.'}
            json_write(transaction / 'receipt.json', receipt)
            raise ValueError('Local recovery finished; original Liveware binding cannot be automatically verified or restored')
        receipt['status'] = 'rolled-back'
        json_write(transaction / 'receipt.json', receipt)
        return {**receipt_result(receipt), 'cleanTransaction': True}

    def rollback(self, transaction, expected):
        with self.lock():
            if self.test_mode:
                require_isolation(self.home)
            transaction, plan = self._load_plan(transaction, expected)
            receipt = json.loads((transaction / 'receipt.json').read_text())
            if plan.get('testMode') != self.test_mode or plan.get('port') != self.isolated_port:
                raise ValueError('Recovery mode/port differs from review')
            self.lifecycle.source_runtime = plan.get('sourceRuntime', 'node')
            if not receipt.get('cleanTransaction'):
                raise ValueError('Use original updater for legacy transaction recovery')
            if receipt['status'] in ('inspecting', 'refused-before-maintenance', 'already-installed'):
                if receipt['applied'] or receipt['entries']:
                    raise ValueError('Pre-maintenance receipt unexpectedly contains switch intents')
                if receipt['status'] == 'inspecting':
                    receipt.update(status='refused-before-maintenance', failure={
                        'phase': receipt.get('progress', {}).get('phase', 'preflight'),
                        'reason': 'Preparation was interrupted; no maintenance or directory switch was entered'})
                    json_write(transaction / 'receipt.json', receipt)
                return receipt_result(receipt)
            if receipt['status'] == 'rolled-back':
                return {**receipt_result(receipt), 'cleanTransaction': True}
            baseline = self.root / 'installed.json'
            if receipt['status'] == 'installed-awaiting-hermes-reload' and (not baseline.exists()
                    or json.loads(baseline.read_text()).get('transaction') != transaction.name):
                raise ValueError('A newer transaction is installed; stale rollback refused')
            if receipt['status'] == 'integration-pending' and content(baseline) != content(transaction / 'backup/baseline.json'):
                raise ValueError('Local baseline changed after partial external recovery; stale rollback refused')
            try:
                self._step(transaction, receipt, 'recovery', '恢复已审查事务', self._recover,
                           transaction, receipt, automatic=receipt['status'] != 'installed-awaiting-hermes-reload')
                return {**receipt_result(json.loads((transaction / 'receipt.json').read_text())), 'cleanTransaction': True}
            except BaseException as error:
                self._record_recovery_failure(transaction, receipt, error)
                raise


class CleanLifecycle(NativeLifecycle):
    def __init__(self, updater, *, port):
        if not isinstance(port, int) or not 1024 <= port <= 65535 or (updater.test_mode and port in (8799, 8809)):
            raise ValueError('A separate isolated test port is required')
        super().__init__(updater, port=port)

    def require_offline(self):
        import socket
        if Path(os.environ.get('HERMES_HOME', '')).resolve() != self.u.home:
            raise ValueError('HERMES_HOME must point to the reviewed installation')
        for key in ('TAVERN_PERSONALITY_FILE', 'TAVERN_HERMES_MEMORIES_DIR', 'TAVERN_HERMES_STATE_DB'):
            if os.environ.get(key):
                value = Path(os.environ[key]).resolve()
                if self.u.home not in value.parents:
                    raise ValueError('External Hermes path requires explicit mapping: ' + key)
        if not self.u._python_source():
            status = self.runtime().status()
            if status.get('inspection_error'):
                raise ValueError('Cannot verify the runtime is offline: ' + status['inspection_error'])
            if any(status['processes'].values()):
                raise ValueError('Tavern restarted during maintenance; no directory was switched')
        if self.u._python_source():
            from maintenance import python_processes
            if python_processes(self.u.targets['app']):
                raise ValueError('Python server is still running during maintenance')
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', self.port)) == 0:
                raise ValueError('Tavern port is occupied during maintenance')

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
        profile_normalization = None
        if (state / 'productions').is_dir():
            from python_profile import normalize_empty_placeholder
            profile_normalization = normalize_empty_placeholder(state)
            model_module = module_at('python_migration_model', transaction / 'source/app/native_model_config.py')
            try:
                model = model_module.load_model_config(self.u.home / 'config.yaml')
            except (model_module.NativeModelConfigError, FileNotFoundError):
                model = None
            plan = json.loads((transaction / 'plan.json').read_text())
            if plan.get('pythonSource') != python_installation(self.u.targets['app']):
                raise ValueError('Python source layout changed before migration')
            json_write(transaction / 'prepared/model-input.json', {'hermesModel': model, 'legacyModel': load_python_model(self.u.home),
                                                                  'legacyApp': str(self.u.targets['app']),
                                                                  'legacyWeb': plan['pythonSource']['web']})
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
        report = json.loads(result.stdout)
        if profile_normalization:
            report['profileNormalization'] = profile_normalization
        return report

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
        journal = transaction / 'maintenance.json'
        record = json.loads(journal.read_text())
        if record.get('service'):
            saved = record['service']
            module = runtime.service_module()
            service = module.ManagedService(saved['descriptor'])
            text = service.node_text(runtime.node_command(self.port, runtime.native_data_root), runtime.engine_root)
            record['nodeServiceHash'] = module.digest(text.encode())
            json_write(journal, record)  # Persist restoration authority before config mutation.
            service.install_text(text, accepted_hash=saved['descriptor']['sha256'], mode=saved['mode'])
        runtime.start(port=self.port, assets_prepared=True)

    def pause(self, transaction):
        from maintenance import pause
        pause(self, transaction)

    def stop(self):
        self.runtime().stop_run('production')

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
        from maintenance import resume
        if getattr(self, 'source_runtime', 'node') == 'python':
            if not self.u._python_source() or not (self.u.state / 'productions').is_dir():
                raise ValueError('Original Python installation was not restored')
        resume(self, transaction)
