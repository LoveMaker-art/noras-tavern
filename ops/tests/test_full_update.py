"""Full-release transaction tests using real archives/files and an isolated service adapter."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / "updater"))
from bundle import PARTS, digest, extract_bundle, read_bundle
from update import Updater, plan_digest
from legacy_recovery import LegacyRecovery


class Service:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def prepare(self, _transaction):
        self.calls.append("prepare")

    def stop(self):
        self.calls.append("stop")

    def pause(self, _transaction):
        self.stop()

    def require_offline(self):
        pass  # Fixture services never bind a port.

    def migrate(self, _transaction, _state):
        return {'fixtureAdapter': True}

    def activate(self, _transaction):
        self.calls.append("activate")
        if self.fail:
            raise RuntimeError("simulated new process health failure")

    def verify(self, _transaction):
        self.calls.append("verify")
        return {"gatewayMcpReloaded": False, "newMcpProcess": True}

    def restore(self, _transaction):
        self.calls.append("restore")


class FullUpdateTests(unittest.TestCase):
    def test_explicit_existing_hermes_installation_can_be_account_home(self):
        with patch.object(Path, 'home', return_value=self.home), \
             patch.dict('os.environ', {'HERMES_HOME': str(self.home)}):
            self.assertEqual(Updater(self.home).home, self.home)
        with patch.object(Path, 'home', return_value=self.root), \
             patch.dict('os.environ', {'HERMES_HOME': str(self.root)}):
            with self.assertRaisesRegex(ValueError, 'exact Hermes'):
                Updater(self.root)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nora-full-update-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "hermes"
        self.home.mkdir()
        self.write("apps/tavern-runtime/native-runtime.json", '{"schema":2}')
        self.write("apps/tavern-runtime/hello.js", "old-app")
        self.write("apps/nora-mcp/dist/server.js", "old-mcp")
        self.write("tavern-state/native/default-user/chats/story.jsonl", "real user chat")
        self.write("tavern-state/native-runtime/config.yaml", "preserve: engine settings\n")
        self.write("config.yaml", 'model: {api_key: user-private-key}\nmcp_servers: {other: {command: keep}}\n')
        self.write("AGENTS.md", "# Personal\nKeep my instructions.\n")
        self.write("skills/custom/SKILL.md", "---\nname: custom\n---\nKeep")
        self.write("apps/tavern-runtime/custom-plugin.js", "user plugin")
        self.write("apps/tavern-runtime/engine/sillytavern/plugins/custom.js", "supported plugin")
        self.initial = self.snapshot()
        self.service = Service()
        self.u = Updater(self.home, lifecycle=self.service)
        self.release, self.manifest = self.bundle("release")

    def write(self, name, text):
        p = self.home / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def snapshot(self):
        return {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob("*")
                if p.is_file() and "tavern-updates-v2" not in p.parts}

    def bundle(self, name, extra=None):
        files = {
            "app/native-runtime.json": b'{"schema":2}', "app/hello.js": b"new-app",
            "app/story_profile_runtime/manifest.json": b'{"sourceRevision":"profile-fixture"}',
            "app/native-extensions/nora-ui/index.js": b"new-ui",
            "nora-mcp/dist/server.js": b"new-mcp", "nora-mcp/npm-shrinkwrap.json": b"{}",
        }
        for p in OPS.rglob("*"):
            if p.is_file() and p.parts[-1] != ".DS_Store" and not any(s in ("node_modules", "__pycache__", "tests") for s in p.relative_to(OPS).parts):
                files["ops/" + str(p.relative_to(OPS))] = p.read_bytes()
        files.update(extra or {})
        directory = self.root / name
        directory.mkdir()
        manifest = {"schema": "tavern-release/v2", "candidate": False, "commit": "a" * 40,
                    "sourceDigest": "b" * 64, "versions": {"tavern": "fixture", "mcp": "fixture"},
                    "artifacts": {name: digest(data) for name, data in files.items()}, "archives": {}}
        for part in PARTS:
            filename = f"nora-tavern-{part}.tar.gz"
            with tarfile.open(directory / filename, "w:gz") as tar:
                for name, data in files.items():
                    if not name.startswith(part + "/"):
                        continue
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = 0o644
                    tar.addfile(info, io.BytesIO(data))
            manifest["archives"][part] = {"name": filename, "sha256": digest((directory / filename).read_bytes())}
        (directory / "release-manifest.json").write_text(json.dumps(manifest))
        return directory, manifest

    def review(self, release=None):
        release = release or self.release
        return self.u.review(release, digest((release / "release-manifest.json").read_bytes()))

    def apply(self, review):
        return self.u.apply(review["transaction"], review["planDigest"])

    def test_full_install_then_rollback_preserves_user_data_and_private_context(self):
        review = self.review()
        self.assertEqual(self.snapshot(), self.initial, "review may stage but cannot alter live files")
        result = self.apply(review)
        self.assertEqual(result["status"], "installed-awaiting-hermes-reload")
        self.assertNotIn("dataImport", result)
        self.assertEqual(result["liveware"]["status"], "preserved-existing-registration")
        self.assertFalse(result["verification"]["gatewayMcpReloaded"])
        self.assertEqual((self.home / "apps/tavern-runtime/hello.js").read_text(), "new-app")
        self.assertEqual((self.home / "apps/nora-mcp/dist/server.js").read_text(), "new-mcp")
        self.assertTrue((self.home / "apps/tavern-ops/updater/update.py").is_file())
        self.assertTrue((self.home / "skills/creative/nora-cardforge/src/cli/main.js").is_file())
        self.assertIn("Keep my instructions", (self.home / "AGENTS.md").read_text())
        import yaml
        config = yaml.safe_load((self.home / "config.yaml").read_text())
        self.assertEqual(config["model"]["api_key"], "user-private-key")
        self.assertEqual(config["mcp_servers"]["other"], {"command": "keep"})
        self.assertEqual(config["mcp_servers"]["nora"]["env"]["NORA_MCP_MODE"], "read-only")
        self.assertEqual(self.service.calls, ["prepare", "stop", "activate", "verify"])
        self.u.rollback(review["transaction"], review["planDigest"])
        self.assertEqual(self.snapshot(), self.initial)

    def test_new_server_failure_restores_every_changed_file(self):
        self.service.fail = True
        review = self.review()
        with self.assertRaisesRegex(RuntimeError, "health failure"):
            self.apply(review)
        self.assertEqual(self.snapshot(), self.initial)
        receipt = json.loads((Path(review["transaction"]) / "receipt.json").read_text())
        self.assertEqual(receipt["status"], "rolled-back")

    def test_target_change_prevents_shutdown(self):
        review = self.review()
        self.write("apps/tavern-runtime/hello.js", "new local edit")
        with self.assertRaisesRegex(ValueError, "Target changed"):
            self.apply(review)
        self.assertEqual(self.service.calls, [])

    def test_source_change_prevents_shutdown(self):
        review = self.review()
        (Path(review["transaction"]) / "source/app/hello.js").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "Staged source changed"):
            self.apply(review)
        self.assertEqual(self.service.calls, [])

    def test_rollback_preserves_concurrent_code_change(self):
        review = self.review()
        self.apply(review)
        self.write("apps/tavern-runtime/hello.js", "user hotfix")
        with self.assertRaisesRegex(ValueError, "concurrent modification"):
            self.u.rollback(review["transaction"], review["planDigest"])
        self.assertEqual((self.home / "apps/tavern-runtime/hello.js").read_text(), "user hotfix")

    def test_replaces_code_tree_and_preserves_supported_plugins(self):
        release, _ = self.bundle("first", {"app/obsolete.js": b"managed old file"})
        self.apply(self.review(release))
        review = self.review()
        self.apply(review)
        self.assertFalse((self.home / "apps/tavern-runtime/obsolete.js").exists())
        self.assertFalse((self.home / "apps/tavern-runtime/custom-plugin.js").exists())
        self.assertEqual((self.home / "apps/tavern-runtime/engine/sillytavern/plugins/custom.js").read_text(), "supported plugin")
        self.assertEqual((Path(review['transaction']) / 'backup/trees/0/obsolete.js').read_text(), 'managed old file')

    def test_repeated_updates_preserve_complete_agents_not_only_changed_block(self):
        first = self.review()
        self.apply(first)
        agents = self.home / "AGENTS.md"
        expected = agents.read_bytes()
        for _ in range(2):
            review = self.review()
            plan = json.loads((Path(review["transaction"]) / "plan.json").read_text())
            change = next(c for c in plan["changes"] if c["name"] == "home/AGENTS.md")
            self.assertIsNotNone(change["after"], "Unchanged AGENTS must remain in the complete desired inventory")
            self.apply(review)
            self.assertEqual(agents.read_bytes(), expected)
            self.assertIn(b"Keep my instructions", agents.read_bytes())

    def test_native_update_preserves_unrecognized_legacy_namespace_without_parsing_it(self):
        self.write("tavern-state/productions/old-world.json", '{"id":"old-world","story":[]}')
        before = (self.home / "tavern-state/productions/old-world.json").read_bytes()
        review = self.review()
        self.assertEqual(review["mode"], "native-code-replacement")
        self.apply(review)
        self.assertEqual((self.home / "tavern-state/productions/old-world.json").read_bytes(), before)

    def test_native_update_does_not_parse_world_v1_records(self):
        self.write("tavern-state/native/default-user/nora-worlds/old.json", '{"schema":"nora-world/v1"}')
        review = self.review()
        self.apply(review)
        self.assertEqual((self.home / "tavern-state/native/default-user/nora-worlds/old.json").read_text(),
                         '{"schema":"nora-world/v1"}')

    def test_native_review_does_not_parse_corrupt_world_records(self):
        file = self.write("tavern-state/native/default-user/nora-world-core/worlds/new.json", '{"schema_version":3}')
        for data in ('{"schema_version":3}', '{broken', '[]'):
            file.write_text(data)
            review = self.review()
            self.assertEqual(review["mode"], "native-code-replacement")
            self.assertEqual(file.read_text(), data)

    def test_state_changes_after_review_do_not_block_native_apply(self):
        review = self.review()
        state = self.write("tavern-state/productions/old.json", '{"id":"old"}')
        transient = self.write("tavern-state/native/default-user/settings.json.1778046006", 'temporary')
        transient.unlink()
        self.apply(review)
        self.assertEqual(state.read_text(), '{"id":"old"}')

    def test_native_update_never_queries_or_mutates_liveware(self):
        self.u.integration.review = lambda: (_ for _ in ()).throw(AssertionError('reviewed Liveware'))
        self.u.integration.check = lambda _review: (_ for _ in ()).throw(AssertionError('checked Liveware'))
        self.u.integration.apply = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('mutated Liveware'))
        result = self.apply(self.review())
        self.assertEqual(result['liveware']['status'], 'preserved-existing-registration')

    def test_old_buggy_plan_cannot_be_applied_by_the_fixed_updater(self):
        review = self.review()
        file = Path(review["transaction"]) / "plan.json"
        plan = json.loads(file.read_text())
        del plan["files"]["home/AGENTS.md"]
        change = next(c for c in plan["changes"] if c["name"] == "home/AGENTS.md")
        change.update(after=None, source=None)
        file.write_text(json.dumps(plan))
        with self.assertRaisesRegex(ValueError, "Unsafe legacy plan"):
            self.u.apply(review["transaction"], plan_digest(plan))
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.snapshot(), self.initial)

    def test_already_affected_legacy_transaction_can_still_restore_agents(self):
        review = self.review()
        transaction = Path(review["transaction"])
        file = transaction / "plan.json"
        plan = json.loads(file.read_text())
        # This fixture represents a receipt created BEFORE directory updates.
        for key in ('cleanTransaction', 'testMode', 'port', 'groups', 'engine'):
            plan.pop(key, None)
        del plan["files"]["home/AGENTS.md"]
        change = next(c for c in plan["changes"] if c["name"] == "home/AGENTS.md")
        change.update(after=None, source=None)
        file.write_text(json.dumps(plan))
        # Reproduce the previous updater's deletion only in this private fixture.
        backup = transaction / "backup"
        backup.mkdir()
        agents = self.home / "AGENTS.md"
        (backup / "0").write_bytes(agents.read_bytes())
        agents.unlink()
        (transaction / "receipt.json").write_text(json.dumps({
            "status": "applying", "actual": [change], "applied": [0], "planDigest": plan_digest(plan),
        }))
        result = LegacyRecovery(self.home, lifecycle=self.service).rollback(transaction, plan_digest(plan))
        self.assertEqual(result["status"], "rolled-back")
        self.assertEqual(self.snapshot(), self.initial)

    def test_legacy_adapter_cannot_create_or_apply_new_transactions(self):
        adapter = LegacyRecovery(self.home, lifecycle=self.service)
        with self.assertRaisesRegex(ValueError, 'recovery receipts only'):
            adapter.review(self.release, 'unused')
        with self.assertRaisesRegex(ValueError, 'retired'):
            adapter.apply('unused', 'unused')
        self.assertEqual(self.service.calls, [])

    def test_disk_shortage_blocks_before_prepare_or_stop(self):
        review = self.review()
        usage = shutil.disk_usage(self.home)
        with patch("update.shutil.disk_usage", return_value=type(usage)(usage.total, usage.used, 0)):
            with self.assertRaisesRegex(ValueError, "Insufficient disk"):
                self.apply(review)
        self.assertEqual(self.service.calls, [])
        self.assertEqual(self.snapshot(), self.initial)

    def test_modified_retired_file_is_not_deleted(self):
        release, _ = self.bundle("first", {"app/obsolete.js": b"managed old file"})
        self.apply(self.review(release))
        self.write("apps/tavern-runtime/obsolete.js", "customized")
        with self.assertRaisesRegex(ValueError, "modified retired"):
            self.review()

    def test_pinned_manifest_and_candidate_gate(self):
        with self.assertRaisesRegex(ValueError, "digest"):
            self.u.review(self.release, "0" * 64)
        self.manifest["candidate"] = True
        (self.release / "release-manifest.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "Candidate"):
            self.review()

    def test_corrupt_archive_rejected_before_live_changes(self):
        with (self.release / "nora-tavern-app.tar.gz").open("ab") as stream:
            stream.write(b"corruption")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.review()
        self.assertEqual(self.snapshot(), self.initial)

    def test_archive_path_and_symlink_rejected(self):
        for name, symbolic in (("app/../../outside", False), ("app/link", True)):
            archive = self.release / "nora-tavern-app.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo(name)
                if symbolic:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                tar.addfile(member)
            self.manifest["archives"]["app"]["sha256"] = digest(archive.read_bytes())
            with self.assertRaises(ValueError):
                extract_bundle(self.release, self.root / ("extract-" + str(symbolic)), self.manifest)
        self.assertFalse((self.root / "outside").exists())

    def test_custom_instance_refused(self):
        with patch.dict("os.environ", {"TAVERN_STATE_DIR": "/different/instance"}):
            with self.assertRaisesRegex(ValueError, "Custom"):
                self.review()

    def test_stale_rollback_after_a_new_release_is_rejected(self):
        first = self.review()
        self.apply(first)
        release, _ = self.bundle('newer-release', {'app/hello.js': b'newer-app'})
        self.apply(self.review(release))
        with self.assertRaisesRegex(ValueError, "newer transaction"):
            self.u.rollback(first["transaction"], first["planDigest"])

    def test_same_release_is_noop_without_invalidating_last_recovery(self):
        first = self.review()
        self.apply(first)
        calls = list(self.service.calls)
        second = self.review()
        self.assertEqual(self.apply(second)['status'], 'already-installed')
        self.assertEqual(self.service.calls, calls)
        installed = json.loads((self.u.root / 'installed.json').read_text())
        self.assertEqual(installed['transaction'], Path(first['transaction']).name)
        self.u.rollback(first['transaction'], first['planDigest'])
        self.assertEqual(self.snapshot(), self.initial)

    def test_missing_archive_blocks_full_update(self):
        del self.manifest["archives"]["nora-mcp"]
        (self.release / "release-manifest.json").write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "Full release"):
            self.review()

    def test_interrupted_update_blocks_a_second_apply(self):
        review = self.review()
        receipt = Path(review["transaction"]) / "receipt.json"
        receipt.write_text('{"status":"applying"}')
        with self.assertRaisesRegex(ValueError, "Unfinished update"):
            self.apply(self.review())
        self.assertEqual(self.service.calls, [])

    def test_corrupt_backup_does_not_begin_partial_rollback(self):
        review = self.review()
        self.apply(review)
        installed = self.snapshot()
        transaction = Path(review["transaction"])
        receipt = json.loads((transaction / "receipt.json").read_text())
        app_entry = next(e for e in receipt['entries'] if e['name'] == 'app')
        (Path(app_entry['backup']) / 'hello.js').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, "backup checksum"):
            self.u.rollback(review["transaction"], review["planDigest"])
        self.assertEqual(self.snapshot(), installed)

    def test_existing_operator_and_tool_allowlist_preserved(self):
        self.write("config.yaml", 'mcp_servers:\n  nora:\n    env: {NORA_MCP_MODE: operator}\n    tools: {include: [nora.status]}\n')
        self.apply(self.review())
        import yaml
        config = yaml.safe_load((self.home / "config.yaml").read_text())["mcp_servers"]["nora"]
        self.assertEqual(config["env"]["NORA_MCP_MODE"], "operator")
        self.assertEqual(config["tools"]["include"], ["nora.status"])

    def test_managed_tavern_skills_are_removed_from_disabled_config(self):
        before = 'skills:\n  disabled: [nora-cardforge, tavern, tavern-ops, unrelated-skill]\nmcp_servers: {other: {command: keep}}\n'
        self.write("config.yaml", before)
        review = self.review()
        self.apply(review)
        import yaml
        config = yaml.safe_load((self.home / "config.yaml").read_text())
        self.assertEqual(config["skills"]["disabled"], ["unrelated-skill"])
        self.assertEqual(config["mcp_servers"]["other"], {"command": "keep"})
        self.u.rollback(review["transaction"], review["planDigest"])
        self.assertEqual((self.home / "config.yaml").read_text(), before)

    def test_lifecycle_sync_preserves_existing_operator_config(self):
        spec = importlib.util.spec_from_file_location("test_native_lifecycle", OPS.parent / "app/native_lifecycle.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        contract = module.RuntimeContract("https://github.com/SillyTavern/SillyTavern.git", "1.18.0", "a" * 40, 20, "engine/sillytavern")
        runtime = module.NativeRuntime(self.home, self.home / "apps/tavern-runtime", self.home / "tavern-state", contract)
        for name in module.MANAGED_EXTENSIONS:
            (runtime.app_root / "native-extensions" / name).mkdir(parents=True, exist_ok=True)
        with patch.object(runtime, "verify_source", return_value={"ok": True}):
            runtime.sync_assets()
        self.assertEqual(runtime.config_path.read_text(), "preserve: engine settings\n")


if __name__ == "__main__":
    unittest.main()
