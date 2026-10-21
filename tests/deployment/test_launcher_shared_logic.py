"""Contracts between the desktop adapter and the shared Tavern business code."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/updater"))
import liveware_integration as integration
import liveware_notice as notice
import clawchat_greeting_patch as greeting
from ops.installer import launcher_bridge as bridge, first_install
from ops.installer import launcher_services as services
from ops.updater import update


class SharedLogicTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home, self.tavern = self.root / "hermes", self.root / "tavern"
        self.home.mkdir()

    def current_install_fixture(self):
        updates = self.tavern / 'tavern-updates'
        updates.mkdir(parents=True)
        manifest = {'schema': 'tavern-release/v2', 'versions': {'tavern': '2.5.2'}, 'commit': 'a' * 40}
        raw = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        (updates / 'installed-manifest.json').write_bytes(raw)
        (updates / 'installed.json').write_text(json.dumps({'schema': 2, 'version': '2.5.2', 'commit': 'a' * 40}))
        return updates, hashlib.sha256(raw).hexdigest()

    def test_current_install_query_is_readonly_and_exactly_bound_without_an_operation(self):
        updates, digest = self.current_install_fixture()
        state = {'systemReady': True, 'version': '2.5.2', 'commit': 'a' * 40,
                 'running': False, 'gatewayRunning': False}
        before = {str(p): p.read_bytes() for p in updates.iterdir()}
        arguments = ['launcher_bridge.py', '--nora-home', str(self.root), '--hermes-home', str(self.home),
                     '--install-root', str(self.tavern), 'inspect-current-update', '--version', '2.5.2',
                     '--commit', 'a' * 40, '--manifest-sha256', digest]
        with patch.object(sys, 'argv', arguments), \
             patch.object(bridge.operation_control, 'require_operation', side_effect=AssertionError('query requires no writer')), \
             patch.dict(sys.modules, {'operation_cli': SimpleNamespace(ensure_operation=Mock(side_effect=AssertionError('no task admission')))}), \
             patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
             patch.object(bridge, 'status_payload', return_value=state), patch.object(bridge, 'emit') as emit:
            bridge.main()
        result = next(call.kwargs for call in emit.call_args_list if call.args == ('result',))
        self.assertIs(result['updateVerified'], True)
        self.assertEqual(result['verificationScope'], 'read-only-current-install')
        self.assertEqual({str(p): p.read_bytes() for p in updates.iterdir()}, before)

    def test_current_install_query_rejects_wrong_identity_unhealthy_or_changed_records(self):
        updates, digest = self.current_install_fixture()
        state = {'systemReady': True, 'version': '2.5.2', 'commit': 'a' * 40,
                 'running': False, 'gatewayRunning': False}
        args = SimpleNamespace(nora_home=self.root, hermes_home=self.home, install_root=self.tavern,
                               port=8799, version='2.5.2', commit='a' * 40, manifest_sha256=digest)
        for change in ({'version': '2.5.1'}, {'commit': 'b' * 40}, {'manifest_sha256': 'b' * 64}):
            with self.subTest(change=change), patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
                 patch.object(bridge, 'status_payload', return_value=state), patch.object(bridge, 'emit') as emit:
                with self.assertRaises(RuntimeError):
                    bridge.command_inspect_current_update(SimpleNamespace(**(vars(args) | change)))
                emit.assert_not_called()
        for bad_state in (state | {'commit': 'b' * 40}, state | {'gatewayRunning': None}, state | {'systemReady': False}):
            with self.subTest(state=bad_state), patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
                 patch.object(bridge, 'status_payload', return_value=bad_state), patch.object(bridge, 'emit') as emit:
                with self.assertRaises(RuntimeError):
                    bridge.command_inspect_current_update(args)
                emit.assert_not_called()
        def drift(*_):
            (updates / 'installed.json').write_text('{}')
            return state
        with patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
             patch.object(bridge, 'status_payload', side_effect=drift), patch.object(bridge, 'emit') as emit:
            with self.assertRaises(RuntimeError):
                bridge.command_inspect_current_update(args)
            emit.assert_not_called()

    def test_existing_current_update_verification_still_requires_the_owned_operation(self):
        with patch.object(bridge.operation_control, 'require_operation', side_effect=RuntimeError('writer required')), \
             patch.object(bridge.nora_system, 'inspect') as inspect:
            with self.assertRaisesRegex(RuntimeError, 'writer required'):
                bridge.command_verify_current_update(SimpleNamespace())
        inspect.assert_not_called()

    def test_gateway_import_does_not_mutate_the_sealed_hook_directory(self):
        hook = self.home / 'hooks/tavern-liveware-register'
        shutil.copytree(ROOT / 'ops/hooks/tavern-liveware-register', hook)
        before = first_install._recovery.digest(hook)
        # The gateway is a new Python process. Its caller's -B switch does not
        # propagate to it; exercise the same file-loader import in that child.
        code = ('import importlib.util,sys;'
                's=importlib.util.spec_from_file_location("owned_hook",sys.argv[1]);'
                'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                'assert callable(m.handle)')
        with patch.dict(os.environ, {'PYTHONDONTWRITEBYTECODE': '0'}):
            result = subprocess.run([sys.executable, '-c', code, str(hook / 'handler.py')],
                                    env=bridge.env_for(self.root, self.home, self.tavern),
                                    capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assertEqual(first_install._recovery.digest(hook), before,
                         'Normal gateway import must preserve first-install program evidence')
        self.assertFalse((hook / '__pycache__').exists())

    def test_proof_is_written_to_tavern_without_greeting_dependency(self):
        database = self.home / "clawchat/clawchat.sqlite"
        database.parent.mkdir()
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE activations(platform, account_id, user_id, conversation_id, bootstrap_sent)")
            db.execute("INSERT INTO activations VALUES('hermes','default','owner','chat',0)")
        owner = {"user_id": "owner", "instance_id": "instance"}
        with patch.object(integration, "runtime_asset_release", return_value="a" * 16), \
             patch.object(integration, "authenticate", return_value=owner) as auth, \
             patch.object(integration, "_reconcile", return_value={"status": "updated", "assetRelease": "a" * 16}) as reconcile:
            result = integration.initialize(self.tavern, 18899, hermes_home=self.home)
        self.assertEqual(result["status"], "updated")
        auth.assert_called_once_with(self.tavern, hermes_home=self.home)
        self.assertEqual(reconcile.call_args.kwargs["hermes_home"], self.home)
        proof = json.loads((self.tavern / "tavern-state/liveware-ready.json").read_text())
        self.assertEqual(proof["port"], 18899)
        self.assertEqual(proof["owner"], owner)
        self.assertFalse((self.home / "tavern-state").exists())

    def test_stopped_tavern_never_logs_in_or_restarts_liveware(self):
        with patch.object(integration, "runtime_asset_release", side_effect=OSError("stopped")), \
             patch.object(integration, "authenticate") as login:
            result = integration.initialize(self.tavern, 18899, hermes_home=self.home)
        self.assertEqual(result["status"], "local-installed-liveware-pending")
        login.assert_not_called()

    def test_managed_worker_does_not_start_a_stopped_tavern(self):
        with patch.object(integration, "runtime_running", return_value=False), \
             patch.object(integration, "start_runtime") as start, \
             patch.object(integration, "ensure") as register:
            self.assertEqual(integration.startup(self.tavern, 18899, hermes_home=self.home,
                                               start_local=False)["status"], "tavern-stopped")
        start.assert_not_called()
        register.assert_not_called()

    def test_managed_worker_cancels_when_tavern_stops_before_registration(self):
        with patch.object(integration, "runtime_running", side_effect=[True, False]), \
             patch.object(integration, "start_runtime") as start, \
             patch.object(integration, "repair") as register:
            result = integration.startup(self.tavern, 18899, hermes_home=self.home, start_local=False)
        self.assertEqual(result["status"], "tavern-stopped")
        start.assert_not_called()
        register.assert_not_called()

    def test_managed_registration_retry_does_not_restart_tavern(self):
        with patch.object(integration, "RETRY_DELAYS", (0, 0)), \
             patch.object(integration, "runtime_running", side_effect=[True, False]), \
             patch.object(integration, "repair", return_value={"status": "pending"}) as repair, \
             patch.object(integration, "start_runtime") as start:
            result = integration.ensure(self.tavern, 18899, hermes_home=self.home, start_local=False)
        self.assertEqual(result["status"], "tavern-stopped")
        start.assert_not_called()
        repair.assert_called_once_with(self.tavern, 18899, hermes_home=self.home)

    def test_desktop_starts_gateway_before_scheduling_shared_hook(self):
        args = SimpleNamespace(nora_home=self.root, hermes_home=self.home,
                               install_root=self.tavern, port=18899, service="all")
        order = []
        def run(command, **kwargs):
            order.append("hook" if command[-1].endswith("handler.py") else "tavern")
        def start_gateway(nora_home, hermes_home, command, env, *, require_connection):
            self.assertIs(require_connection, True)
            order.append("gateway")
        with patch.object(bridge, "installed", return_value=True), \
             patch.object(bridge.nora_system, "installation_state", return_value={"ready": True, "setupCompleted": False}), \
             patch.object(bridge, "read_verified_model", return_value={"model": "test"}), \
             patch.object(bridge, "clawchat_paired", return_value=True), \
             patch.object(bridge, "sync_nora_profile"), \
             patch.object(bridge, "python_command", return_value=sys.executable), \
             patch.object(bridge, "run_stream", side_effect=run), \
             patch.object(bridge, "start_gateway", autospec=True, side_effect=start_gateway) as gateway, \
             patch.object(bridge, "require_bundled_clawchat"), \
             patch.object(bridge, "status_payload", return_value={"running": True, "clawchatConnected": True}), \
             patch.object(bridge.nora_system, "verify_runtime"), \
             patch.object(bridge.nora_system, "mark_setup_complete"), \
             patch.object(bridge, "run_json") as login, patch.object(bridge, "emit"):
            bridge.command_start(args)
        self.assertEqual(order, ["tavern", "gateway", "hook"])
        gateway.assert_called_once()
        login.assert_not_called()

    def test_prepatched_bundle_is_verified_without_git(self):
        shutil.copytree(ROOT / "ops/tests/fixtures/clawchat-greeting-before", self.home / "plugins/clawchat")
        swaps, report = greeting.prepare(self.home, self.root / "stage")
        self.assertEqual(report["status"], "already-patched")
        for _, source, target in swaps:
            shutil.copy2(source, target)
        files = {"plugins/clawchat/" + name: hashlib.sha256(
            (self.home / "plugins/clawchat" / name).read_bytes()).hexdigest() for name in greeting.FILES}
        metadata = {"files": files, "clawchat": {"greetingPatchSha256": hashlib.sha256(
            (ROOT / "ops/updater/clawchat-greeting-order.patch").read_bytes()).hexdigest()}}
        (self.home / "nora-components.json").write_text(json.dumps(metadata))
        with patch.object(greeting.subprocess, "run", side_effect=AssertionError("Git must not run")):
            self.assertEqual(greeting.prepare(self.home, self.root / "second"), ([], {"status": "already-patched"}))
        (self.home / "plugins/clawchat" / greeting.FILES[0]).write_text("tampered")
        self.assertFalse(greeting.bundled_patch_ready(self.home))

    def test_mcp_first_install_delegates_to_shared_writer(self):
        config = self.home / "config.yaml"
        config.write_text("user_setting: keep\nmcp_servers:\n  unrelated:\n    command: keep\n")
        expected = update.render_mcp(self.home, self.tavern, 18899)
        import yaml
        initial = yaml.safe_load(first_install.render_mcp(self.home, self.tavern, 18899))
        self.assertEqual(initial.pop('approvals'), {'destructive_slash_confirm': False})
        self.assertEqual(initial, yaml.safe_load(expected))
        self.assertIn(b"http://127.0.0.1:18899", expected)
        self.assertIn(b"user_setting: keep", expected)

    def test_first_install_preserves_explicit_confirmation_and_command_policy(self):
        import yaml
        (self.home / 'config.yaml').write_text('approvals:\n  destructive_slash_confirm: true\n  mode: manual\n')
        result = yaml.safe_load(first_install.render_mcp(self.home, self.tavern))
        self.assertEqual(result['approvals'], {'destructive_slash_confirm': True, 'mode': 'manual'})

    def test_user_memory_default_increases_once_and_preserves_custom_settings(self):
        import yaml
        target = self.home / 'config.yaml'
        for previous, expected in ((None, 2000), (1375, 2000), (1875, 2000),
                                   (2000, 2000), (1000, 1000), (1999, 1999), (3000, 3000)):
            original = {'model': {'default': 'test-model'}, 'memory': {'memory_char_limit': 2200}}
            if previous is not None:
                original['memory']['user_char_limit'] = previous
            target.write_text(yaml.safe_dump(original), encoding='utf-8')
            for writer in (update.render_mcp, first_install.render_mcp):
                rendered = writer(self.home, self.tavern, 18899)
                value = yaml.safe_load(rendered)
                self.assertEqual(value['memory'], {'memory_char_limit': 2200, 'user_char_limit': expected})
                self.assertEqual(value['model'], original['model'])
                target.write_bytes(rendered)

    def test_invalid_user_memory_settings_do_not_get_replaced(self):
        target = self.home / 'config.yaml'
        for content in ('memory: false\n', 'memory:\n  user_char_limit: false\n',
                        'memory:\n  user_char_limit: 0\n', 'memory:\n  user_char_limit: null\n'):
            target.write_text(content, encoding='utf-8')
            with self.assertRaises(RuntimeError):
                update.render_mcp(self.home, self.tavern)
            self.assertEqual(target.read_text(), content)

    def test_shared_defaults_do_not_assume_a_desktop_install(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=True):
            self.assertEqual(update.default_hermes_home(), self.home)
            self.assertEqual(update.default_install_root(), self.home)

    def test_desktop_update_uses_verified_target_updater_not_first_installer(self):
        payload = self.root / "payload"
        payload.mkdir()
        bootstrap = payload / "tavern-updater-bootstrap.py"
        bootstrap.write_bytes(b"# pinned target updater\n")
        (payload / "release-manifest.json").write_text(json.dumps({
            "bootstrap": {"sha256": hashlib.sha256(bootstrap.read_bytes()).hexdigest(), "managedLifecycle": 1}}))
        record = self.tavern / "tavern-updates/nora-system.json"
        record.parent.mkdir(parents=True)
        record.write_text('{"schema":1}')
        (self.home / "nora-instance.json").write_text('{"port":18899}')
        args = SimpleNamespace(nora_home=self.root, hermes_home=self.home, install_root=self.tavern,
                               port=18899, release_dir=str(payload), tag=None)
        before = {'version': '2.3.7', 'systemReady': False, 'running': True, 'gatewayRunning': False,
                  'clawchatConnected': False,
                  'systemProblems': ['技能文件缺失：skills/creative/tavern/SKILL.md']}
        with patch.object(bridge, "installed", return_value=True), \
             patch.object(bridge, "python_command", return_value=sys.executable), \
             patch.object(bridge, "gateway_status", return_value={"running": False}), \
             patch.object(bridge, "status_payload", return_value=before), \
             patch.object(bridge, "emit"), patch.object(bridge, "run_stream", return_value={'updateVerified': True}) as run:
            bridge.command_update(args)
        command = run.call_args.args[0]
        self.assertEqual(command[3], str(bootstrap))
        self.assertEqual(command[command.index("--managed-home") + 1], str(self.root))
        self.assertEqual(command[command.index("--release-dir") + 1], str(payload))
        self.assertNotIn("--force-first-install", command)
        plan = json.loads(run.call_args.kwargs['env']['NORA_UPDATE_LIFECYCLE'])
        self.assertEqual(plan['port'], 18899)
        self.assertEqual(plan['installRoot'], str(self.tavern))
        self.assertEqual(plan['before'], before)
        bootstrap.write_bytes(b"changed")
        with patch.object(bridge, "installed", return_value=True), patch.object(bridge, "run_stream") as run:
            with self.assertRaises(SystemExit):
                bridge.command_update(args)
            run.assert_not_called()

    def test_shared_hermes_instructions_use_full_project_ownership(self):
        (self.home / "AGENTS.md").write_text("My unrelated instructions\n")
        merged = update.merged_agents(self.home, b"# Nora\n")
        self.assertEqual(merged, b"# Nora\n")
        self.assertEqual(merged.count(b"# Nora"), 1)

    def test_shared_hook_uses_common_startup_without_desktop_runner(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home), "TAVERN_DATA_ROOT": str(self.tavern)}):
            spec = importlib.util.spec_from_file_location("shared_hook_test", ROOT / "ops/hooks/tavern-liveware-register/handler.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with patch.object(module.subprocess, "Popen") as spawn:
                module.handle("gateway:startup", {})
        command = spawn.call_args.args[0]
        self.assertEqual(command[-1], "startup")
        self.assertIn(str(self.tavern / "apps/tavern-ops/updater/liveware_integration.py"), command)
        self.assertNotIn("recover-existing", command)

    def test_stopping_nora_does_not_kill_its_liveware_descendant(self):
        import psutil
        gateway, worker, daemon = Mock(), Mock(), Mock()
        gateway.pid = 12345
        worker.exe.return_value = sys.executable
        daemon.exe.return_value = str(self.home / "clawchat/liveware" /
                                      ("liveware.exe" if os.name == "nt" else "liveware"))
        daemon.cmdline.return_value = [daemon.exe.return_value, "agent", "run"]
        gateway.children.return_value = [worker, daemon]
        with patch.object(services, "owned_gateway", side_effect=[gateway, None]), \
             patch.object(psutil, "wait_procs", return_value=([], [])):
            services.stop_gateway(self.root, preserve_liveware_home=self.home)
        gateway.terminate.assert_called_once()
        worker.terminate.assert_called_once()
        daemon.terminate.assert_not_called()
        daemon.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
