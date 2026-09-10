import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BOOTSTRAP = load("target_bootstrap", "ops/updater/bootstrap.py")
UPDATER = load("target_updater", "ops/updater/update.py")
BUNDLE = load("target_bundle", "ops/updater/bundle.py")


class UpdateTargetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "hermes"
        (self.home / "skills").mkdir(parents=True)
        self.environment = patch.dict(os.environ, {"HOME": str(self.home / "home"),
                                                   "HERMES_HOME": str(self.home)}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def installation(self, root):
        for relative in ["apps/tavern-runtime/native-runtime.json",
                         "apps/tavern-runtime/engine/sillytavern/server.js",
                         "apps/tavern-ops/updater/update.py", "apps/nora-mcp/dist/server.js"]:
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("{}")
        (root / "tavern-state/native/default-user").mkdir(parents=True)
        receipt = root / "tavern-updates/installed.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(json.dumps({"version": "2.2.9", "commit": "same-commit"}))

    def bind(self, root):
        (self.home / "config.yaml").write_bytes(UPDATER.render_mcp(self.home, root))

    def bootstrap(self, extra=()):
        with patch.object(sys, "argv", ["bootstrap.py", "--apply", "--confirm",
                                        "--target-commit", "same-commit", *extra]), \
                patch.object(BOOTSTRAP, "download", side_effect=AssertionError("unexpected download")), \
                patch("sys.stdout", new_callable=io.StringIO):
            BOOTSTRAP.main()

    def test_old_deployment_without_arguments_keeps_existing_world_directory(self):
        self.installation(self.home)
        self.bind(self.home)
        marker = self.home / "tavern-state/native/default-user/world-evidence.json"
        marker.write_text("preserve")
        before = (self.home / "config.yaml").read_bytes()
        self.bootstrap()
        self.assertEqual(marker.read_text(), "preserve")
        self.assertEqual((self.home / "config.yaml").read_bytes(), before)
        self.assertFalse((self.home / "home").exists())

    def test_separate_existing_tavern_is_found_from_mcp(self):
        tavern = self.root / "separate tavern"
        self.installation(tavern)
        self.bind(tavern)
        self.bootstrap()
        self.assertEqual(BOOTSTRAP.resolve_update_target(), (self.home, tavern))

    def test_legacy_installation_without_mcp_uses_its_existing_receipt(self):
        self.installation(self.home)
        self.bootstrap()

    def test_old_data_root_argument_still_selects_colocated_hermes(self):
        self.installation(self.home)
        with patch.dict(os.environ, {"HOME": str(self.root / "unrelated")}, clear=True):
            self.bootstrap(["--data-root", str(self.home)])

    def test_empty_directory_skeleton_is_not_an_installation(self):
        (self.home / "apps/tavern-runtime").mkdir(parents=True)
        (self.home / "tavern-state").mkdir()
        with self.assertRaisesRegex(RuntimeError, "完整"):
            self.bootstrap()

    def test_symlink_alias_of_installation_resolves_to_the_same_root(self):
        self.installation(self.home)
        self.bind(self.home)
        alias = self.root / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        self.bootstrap(["--install-root", str(alias)])

    def test_unknown_installation_refuses_before_creating_directories(self):
        with self.assertRaisesRegex(RuntimeError, "安装"):
            self.bootstrap()
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["skills"])

    def test_candidate_mode_requires_an_explicit_local_bundle(self):
        with self.assertRaisesRegex(RuntimeError, "release-dir"):
            self.bootstrap(["--allow-candidate"])
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["skills"])

    def test_candidate_mode_never_disables_manifest_checksum_validation(self):
        bundle = self.root / "release"
        bundle.mkdir()
        manifest = bundle / "release-manifest.json"
        manifest.write_text(json.dumps({"schema": "tavern-release/v2", "candidate": True}))
        (bundle / "SHA256SUMS").write_text(BOOTSTRAP.sha(manifest) + "  release-manifest.json\n")
        with self.assertRaisesRegex(RuntimeError, "正式"):
            BOOTSTRAP.verify_metadata(bundle)
        self.assertTrue(BOOTSTRAP.verify_metadata(bundle, allow_candidate=True)[0]["candidate"])
        manifest.write_text(manifest.read_text() + " ")
        with self.assertRaisesRegex(RuntimeError, "校验失败"):
            BOOTSTRAP.verify_metadata(bundle, allow_candidate=True)

    def test_explicit_empty_root_cannot_replace_existing_binding(self):
        self.installation(self.home)
        self.bind(self.home)
        empty = self.root / "empty"
        with self.assertRaisesRegex(RuntimeError, "冲突"):
            self.bootstrap(["--install-root", str(empty)])
        self.assertFalse(empty.exists())

    def test_stale_environment_cannot_replace_existing_binding(self):
        self.installation(self.home)
        self.bind(self.home)
        empty = self.root / "empty"
        with patch.dict(os.environ, TAVERN_DATA_ROOT=str(empty)):
            with self.assertRaisesRegex(RuntimeError, "冲突"):
                self.bootstrap()
        self.assertFalse(empty.exists())

    def test_conflicting_mcp_fields_refuse_update(self):
        self.installation(self.home)
        self.bind(self.home)
        cfg = self.home / "config.yaml"
        value = yaml.safe_load(cfg.read_text())
        value["mcp_servers"]["nora"]["env"]["NORA_MCP_USER_DATA_ROOT"] = str(self.root / "empty/tavern-state/native/default-user")
        cfg.write_text(yaml.safe_dump(value))
        with self.assertRaisesRegex(RuntimeError, "冲突"):
            self.bootstrap()

    def test_two_existing_installations_require_repair_not_silent_selection(self):
        self.installation(self.home)
        other = self.root / "other"
        self.installation(other)
        self.bind(other)
        with self.assertRaisesRegex(RuntimeError, "冲突"):
            self.bootstrap()

    def test_managed_launcher_is_rejected_even_at_same_version(self):
        self.installation(self.home)
        (self.home / "nora-instance.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "启动器"):
            self.bootstrap(["--hermes-home", str(self.home)])

    def managed_installation(self):
        tavern = self.root / "tavern"
        self.installation(tavern)
        (self.home / "config.yaml").write_bytes(UPDATER.render_mcp(self.home, tavern, 18899))
        (self.home / "nora-instance.json").write_text(json.dumps({
            "schema": 1, "noraHome": str(self.root), "hermesHome": str(self.home),
            "installRoot": str(tavern), "port": 18899,
        }))
        (tavern / "tavern-updates/nora-system.json").write_text(json.dumps({"schema": 1}))
        journal = self.root / "installer/system-update/journal.json"
        journal.parent.mkdir(parents=True)
        journal.write_text(json.dumps({"schema": 1, "phase": "applying"}))
        return tavern

    def test_managed_update_requires_matching_instance_and_active_transaction(self):
        tavern = self.managed_installation()
        self.assertEqual(BOOTSTRAP.resolve_update_target(
            self.home, tavern, managed_home=self.root), (self.home, tavern))
        journal = self.root / "installer/system-update/journal.json"
        journal.unlink()
        with self.assertRaisesRegex(RuntimeError, "事务"):
            BOOTSTRAP.resolve_update_target(self.home, tavern, managed_home=self.root)

    def test_managed_update_rejects_stale_mcp_binding(self):
        tavern = self.managed_installation()
        (self.home / "config.yaml").write_bytes(UPDATER.render_mcp(self.home, self.root / "wrong-tavern", 18899))
        with self.assertRaisesRegex(RuntimeError, "冲突"):
            BOOTSTRAP.resolve_update_target(self.home, tavern, managed_home=self.root)

    def test_managed_update_rejects_a_different_mcp_port(self):
        tavern = self.managed_installation()
        self.bind(tavern)
        with self.assertRaisesRegex(RuntimeError, "配置"):
            BOOTSTRAP.resolve_update_target(self.home, tavern, managed_home=self.root)

    def test_managed_update_cannot_authorize_a_different_installation(self):
        tavern = self.managed_installation()
        with self.assertRaisesRegex(RuntimeError, "实例"):
            BOOTSTRAP.resolve_update_target(self.home, tavern, managed_home=self.root / "other")

    def test_malformed_configuration_is_not_treated_as_missing(self):
        self.installation(self.home)
        (self.home / "config.yaml").write_text("mcp_servers: [broken")
        with self.assertRaisesRegex(RuntimeError, "配置"):
            self.bootstrap()

    def test_both_entrypoints_use_one_resolver(self):
        self.assertEqual(UPDATER.resolve_update_target.__code__.co_code,
                         BOOTSTRAP.resolve_update_target.__code__.co_code)

    def transaction(self, *, corrupt=False, unreadable=False, receipt_failure=False):
        self.installation(self.home)
        self.bind(self.home)
        config_before = (self.home / "config.yaml").read_bytes()
        (self.home / "AGENTS.md").write_text("old instructions")
        state = self.home / "tavern-state"
        story = state / "native/default-user/nora-world-core/worlds/fixture.json"
        chat = state / "native/default-user/chats/fixture/session.jsonl"
        for file, content in [(story, '{"fixture":true}'), (chat, '{"message":"keep"}\n')]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        manifest = {"versions": {"tavern": "2.3.0"}, "commit": "updated", "artifacts": {}}
        worlds = {"default-user": [{"worldId": "fixture", "sessions": ["session"]}]}
        started = False

        def extract(_release, source, _manifest, **_kwargs):
            agents = source / "ops/skills/agents-tavern.md"
            agents.parent.mkdir(parents=True)
            agents.write_text("# new instructions")
            (source / "app").mkdir()
            (source / "app/native-runtime.json").write_text('{"new":true}')
            return {"changedModules": ["tavern-engine"]}

        def start(*_args, **_kwargs):
            nonlocal started
            started = True
            if corrupt:
                quarantine = story.parent.parent / "quarantine/worlds"
                quarantine.mkdir(parents=True)
                story.rename(quarantine / "fixture.invalid")
                chat.write_text("wrong data")
            return {"health": {"ok": True}, "native_pid": 123}

        def read_worlds(*_args):
            return {} if started and unreadable else worlds

        write_json = UPDATER.json_write

        def write_receipt(path, value):
            if receipt_failure and path.name == "installed-manifest.json":
                raise OSError("receipt write failed")
            return write_json(path, value)

        modules = SimpleNamespace(RETIRED=[], ManagedService=SimpleNamespace(discover=lambda *_: None),
                                  prepare=lambda *_: ([], {"status": "not-installed"}),
                                  prepare_greeting=lambda *_: ([], {"status": "managed"}))
        replacements = {
            "python_layout": None, "changed_roots": {"app"}, "roots_with_unmanaged_files": set(),
            "prepare_dependencies": {}, "prepare_skills": {}, "module_at": modules,
            "prepare_host_hook_swap": None, "dependency_marker": {}, "stop_unmanaged": [],
            "refresh_liveware": {"status": "unchanged"},
        }
        with ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, bundle=BUNDLE))
            stack.enter_context(patch.object(BUNDLE, "read_bundle", return_value=manifest))
            stack.enter_context(patch.object(BUNDLE, "extract_bundle", side_effect=extract))
            for name, result in replacements.items():
                stack.enter_context(patch.object(UPDATER, name, return_value=result))
            stack.enter_context(patch.object(UPDATER, "install_runtime", side_effect=start))
            stack.enter_context(patch.object(UPDATER, "verify_worlds", side_effect=read_worlds))
            stack.enter_context(patch.object(UPDATER, "json_write", side_effect=write_receipt))
            restart = stack.enter_context(patch.object(UPDATER, "start_old"))
            output = stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
            args = SimpleNamespace(home=None, install_root=None, release_dir=self.root / "release", manifest_sha256=None)
            if corrupt or unreadable or receipt_failure:
                with self.assertRaisesRegex(RuntimeError, "(更新验收失败|receipt write failed).*recovery=restored"):
                    UPDATER.install(args)
                restart.assert_called_once()
                self.assertEqual((self.home / "AGENTS.md").read_text(), "old instructions")
                self.assertEqual((self.home / "config.yaml").read_bytes(), config_before)
                self.assertEqual(json.loads((self.home / "tavern-updates/installed.json").read_text())["version"], "2.2.9")
                self.assertEqual((self.home / "apps/tavern-runtime/native-runtime.json").read_text(), "{}")
            else:
                UPDATER.install(args)
                result = json.loads(output.getvalue())
                self.assertEqual(result["worldVerification"], {"status": "verified", "worlds": 1, "files": 2})
                self.assertEqual((Path(result["backup"]) / "state/native/default-user/chats/fixture/session.jsonl").read_text(), '{"message":"keep"}\n')
            self.assertEqual(story.read_text(), '{"fixture":true}')
            self.assertEqual(chat.read_text(), '{"message":"keep"}\n')
            self.assertFalse((self.home / "home").exists())

    def test_transaction_preserves_existing_worlds_and_stores_verification(self):
        self.transaction()

    def test_healthy_server_with_quarantined_world_rolls_back_data_and_program(self):
        self.transaction(corrupt=True)

    def test_healthy_server_with_missing_worlds_fails_even_when_files_remain(self):
        self.transaction(unreadable=True)

    def test_failed_receipt_commit_does_not_leave_new_version_on_rolled_back_program(self):
        self.transaction(receipt_failure=True)


if __name__ == "__main__":
    unittest.main()
