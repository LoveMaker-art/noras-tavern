"""Exercise the shared update transaction; external Hermes/runtime probes are stubbed."""
from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import first_install, nora_system
from ops.updater import update, bundle

ROOT = Path(__file__).resolve().parents[2]


class ManagedUpdateTests(unittest.TestCase):
    def transaction(self, *, failure=False, bundled=True, same_version=False, late_failure=False, rollback_failure=False, preflight_failure=False,
                    source_version="2.3.0", target_version="2.3.2", receipt_schema=1):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary).resolve() / "custom Nora directory"
            home, tavern = root / "hermes", root / "tavern"
            def write(file, content):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(content, encoding="utf-8")
            instance = {"schema": 1, "noraHome": str(root), "hermesHome": str(home),
                        "installRoot": str(tavern), "port": 18899, "releaseChannel": "beta"}
            write(home / "nora-instance.json", json.dumps(instance))
            write(tavern / "tavern-updates/installed.json", json.dumps({"schema": receipt_schema,
                  "version": source_version, "commit": "old"}))
            write(tavern / "tavern-updates/nora-system.json", '{"schema":1,"commit":"old","setupCompleted":true}')
            write(tavern / "apps/tavern-runtime/native-runtime.json", '{"old":true}')
            story = tavern / "tavern-state/native/default-user/nora-world-core/worlds/story.json"
            chat = tavern / "tavern-state/native/default-user/chats/story/chat.jsonl"
            write(story, '{"worldId":"story"}')
            write(chat, '{"message":"keep"}\n')
            write(home / ".env", "TEST_ONLY=keep")
            write(home / "SOUL.md", "custom persona")
            write(home / "AGENTS.md", "old instructions")
            write(home / "cron/jobs.json", '{"jobs":[{"id":"unrelated"}]}')
            write(home / "sessions/keep.json", '{"testOnly":true}')
            for relative in nora_system.SKILLS:
                write(home / "skills" / relative / "SKILL.md", "old skill")
            for relative in nora_system.MANAGED_FILES:
                write(home / relative, "old managed file")
            old_config = update.render_mcp(home, tavern, 18899)
            (home / "config.yaml").write_bytes(old_config)
            manifest = {"versions": {"tavern": target_version}, "commit": "new", "artifacts": {}}
            if same_version:
                manifest["versions"]["tavern"] = source_version
            before = {p: p.read_bytes() for p in home.rglob("*") if p.is_file()}
            receipts = {p: p.read_bytes() for p in (tavern / "tavern-updates").iterdir()}

            def extract(_release, source, _manifest, **_kwargs):
                write(source / "app/native-runtime.json", '{"new":true}')
                for name in ("first_install.py", "nora_system.py", "templates/SOUL.md", "templates/greeting.md"):
                    dest = source / "ops/installer" / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT / "ops/installer" / name, dest)
                for name in ("managed_context.py", "clawchat_greeting_patch.py", "clawchat-greeting-order.patch"):
                    dest = source / "ops/updater" / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT / "ops/updater" / name, dest)
                for name in update.UPDATE_CHECK_FILES:
                    write(source / "ops/scripts" / name, "new managed script")
                write(source / "ops/skills/agents-tavern.md", "# New Nora instructions\n")
                for name in ("HOOK.yaml", "handler.py", "run.sh"):
                    write(source / "ops/hooks/tavern-liveware-register" / name, "new hook")
                return {"changedModules": ["tavern-engine", "updater"]}

            def skills(_source, destination, *, local=False):
                self.assertTrue(local)
                result = {}
                for relative in nora_system.SKILLS:
                    dest = destination / relative
                    write(dest / "SKILL.md", "new skill")
                    result[relative] = dest
                return result

            def seed(*_args):
                write(home / "clawchat-skills/clawchat-core/SKILL.md", "new external skill")

            def cron(_home):
                write(home / "cron/jobs.json", '{"jobs":[{"id":"unrelated"},{"id":"new"}]}')
                return {"id": "new"}

            original_module = update.module_at
            lifecycle_calls = []
            def lifecycle(phase, *_args):
                lifecycle_calls.append(phase)
                if phase == 'preflight' and preflight_failure:
                    raise RuntimeError('injected preflight failure')
                if phase == 'verify' and late_failure:
                    raise RuntimeError('injected final service failure')
                if phase == 'rollback' and rollback_failure:
                    raise RuntimeError('old gateway cannot start')
                return {'systemReady': True, 'version': manifest['versions']['tavern']}
            stack.enter_context(patch.object(update, 'managed_lifecycle', side_effect=lifecycle, create=True))
            def module(name, file):
                if name == "update_nora_system":
                    return nora_system
                if name == "update_install_helpers":
                    return first_install
                if name == "simple_service_manager":
                    return SimpleNamespace(ManagedService=SimpleNamespace(discover=lambda *_: None))
                if name == "simple_skill_names":
                    return SimpleNamespace(RETIRED=[])
                return original_module(name, file)

            def verify(*_args):
                if failure:
                    story.unlink()
                    chat.write_text("startup damaged data")
                    raise RuntimeError("injected MCP failure")
                return {name: True for name in nora_system.PROOFS}

            stack.enter_context(patch.dict(os.environ, {"HERMES_HOME": str(home), "NORA_TAVERN_HOME": str(root)}, clear=True))
            stack.enter_context(patch.dict(sys.modules, bundle=bundle))
            stack.enter_context(patch.object(bundle, "read_bundle", return_value=manifest))
            stack.enter_context(patch.object(bundle, "extract_bundle", side_effect=extract))
            stack.enter_context(patch.object(update, "module_at", side_effect=module))
            stack.enter_context(patch.object(update, "changed_roots", return_value={"app", "ops"}))
            stack.enter_context(patch.object(update, "roots_with_unmanaged_files", return_value=set()))
            stack.enter_context(patch.object(update, "prepare_skills", side_effect=skills))
            stack.enter_context(patch.object(update, "stop_unmanaged"))
            stack.enter_context(patch.object(update, "dependency_marker", return_value={}))
            stack.enter_context(patch.object(update, "verify_worlds", return_value={"default-user": [{"worldId": "story"}]}))
            stack.enter_context(patch.object(update, "configure_update_check_job", side_effect=cron))
            stack.enter_context(patch.object(first_install, "extract_dependency_bundle", return_value={"schema": 1} if bundled else None))
            if not bundled:
                dependencies = stack.enter_context(patch.object(update, "prepare_dependencies", return_value={"tavern": "reused", "mcp": "unchanged"}))
            stop = stack.enter_context(patch.object(first_install, "stop_install_runtime"))
            stack.enter_context(patch.object(nora_system, "seed_clawchat_skills", side_effect=seed))
            stack.enter_context(patch.object(nora_system, "verify_runtime", side_effect=verify))
            no_install = stack.enter_context(patch.object(first_install, "install", side_effect=AssertionError("not a first install")))
            no_liveware = stack.enter_context(patch.object(update, "refresh_liveware", side_effect=AssertionError("launcher owns restart")))
            start = stack.enter_context(patch.object(update, "install_runtime", return_value={"health": {"ok": True}}))
            no_old_start = stack.enter_context(patch.object(update, "start_old"))
            stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
            args = SimpleNamespace(home=home, install_root=tavern, managed_home=root,
                                   release_dir=root / "payload", manifest_sha256="test")
            if preflight_failure:
                with self.assertRaisesRegex(RuntimeError, 'injected preflight failure'):
                    update.install(args)
                self.assertEqual(lifecycle_calls, ['preflight'])
                start.assert_not_called()
                stop.assert_not_called()
                self.assertFalse((tavern / 'tavern-updates/transaction.json').exists())
                for file, value in {**before, **receipts}.items():
                    self.assertEqual(file.read_bytes(), value)
                return
            if failure or late_failure:
                recovery_text = 'files-restored-start-failed' if rollback_failure else 'restored'
                with self.assertRaisesRegex(RuntimeError, "injected .*failure.*recovery=" + recovery_text):
                    update.install(args)
                for file, value in {**before, **receipts}.items():
                    self.assertEqual(file.read_bytes(), value, str(file.relative_to(root)))
                self.assertFalse((home / "clawchat-skills").exists())
                journal = json.loads((tavern / 'tavern-updates/transaction.json').read_text())
                self.assertEqual(journal['status'], 'recovery-failed' if rollback_failure else 'restored')
                self.assertTrue(Path(journal['backup']).is_dir())
                if rollback_failure:
                    with self.assertRaisesRegex(RuntimeError, '上次更新事务未完成'):
                        update.install(args)
            else:
                update.install(args)
                installed = json.loads((tavern / "tavern-updates/installed.json").read_text())
                self.assertEqual(installed["version"], manifest["versions"]["tavern"])
                self.assertEqual((home / "AGENTS.md").read_text(), "# New Nora instructions\n")
                for relative in nora_system.SKILLS:
                    self.assertEqual((home / "skills" / relative / "SKILL.md").read_text(), "new skill")
                receipt = json.loads((tavern / "tavern-updates/nora-system.json").read_text())
                self.assertEqual(receipt["commit"], "new")
                self.assertTrue(receipt["setupCompleted"])
                self.assertEqual(receipt["skills"], nora_system.inventory(home))
                self.assertTrue(nora_system.files_ready(home))
                self.assertEqual((home / "SOUL.md").read_text(), "custom persona")
                self.assertEqual((home / "nora-instance.json").read_bytes(), before[home / "nora-instance.json"])
                self.assertEqual((home / ".env").read_bytes(), before[home / ".env"])
                self.assertEqual((home / "sessions/keep.json").read_bytes(), before[home / "sessions/keep.json"])
            self.assertEqual(story.read_text(), '{"worldId":"story"}')
            self.assertEqual(chat.read_text(), '{"message":"keep"}\n')
            self.assertEqual(start.call_args.kwargs["port"], 18899)
            self.assertEqual(stop.call_count, 2 if failure or late_failure else 1)
            if late_failure:
                self.assertEqual(lifecycle_calls, ['preflight', 'stop', 'verify', 'stop', 'rollback'])
            no_install.assert_not_called()
            no_liveware.assert_not_called()
            no_old_start.assert_not_called()
            if not bundled:
                self.assertFalse(dependencies.call_args.kwargs.get("bundled", False))

    def test_managed_update_uses_shared_transaction_and_preserves_user_data(self):
        self.transaction()

    def test_historical_managed_receipts_upgrade_or_restore_without_data_loss(self):
        # Versions label representative receipt fixtures, not downloaded historical runtimes.
        for version in ("2.2.11", "2.3.0", "2.3.1", "2.3.2", "2.3.3", "2.3.4", "2.3.5", "2.3.6", "2.3.7"):
            for schema in (1, 2):
                for fail in (False, True):
                    with self.subTest(version=version, schema=schema, rollback=fail):
                        self.transaction(source_version=version, target_version="2.3.13",
                                         receipt_schema=schema, bundled=False, late_failure=fail)

    def test_invalid_lifecycle_fails_before_stopping_or_changing_installation(self):
        self.transaction(preflight_failure=True)

    def test_failed_managed_proof_restores_worlds_and_managed_configuration(self):
        self.transaction(failure=True)

    def test_component_update_without_platform_bundle_uses_shared_dependencies(self):
        self.transaction(bundled=False)

    def test_component_update_without_platform_bundle_rolls_back(self):
        self.transaction(bundled=False, failure=True)

    def test_same_version_repairs_skills_and_refreshes_receipt_without_first_install(self):
        self.transaction(bundled=False, same_version=True)

    def test_final_service_failure_restores_old_files_receipts_worlds_and_services(self):
        self.transaction(bundled=False, late_failure=True)

    def test_failed_old_service_recovery_keeps_backup_and_blocks_another_update(self):
        self.transaction(bundled=False, late_failure=True, rollback_failure=True)


if __name__ == "__main__":
    unittest.main()
