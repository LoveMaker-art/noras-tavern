import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import os
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "ops/installer/first_install.py"
SPEC = importlib.util.spec_from_file_location("nora_first_install", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FirstInstallSnapshotTests(unittest.TestCase):
    def test_windows_architecture_works_without_processor_environment_variables(self):
        with patch.object(MODULE.os, "name", "nt"), \
             patch.object(MODULE.platform, "machine", return_value=""), \
             patch("sysconfig.get_platform", return_value="win-amd64"):
            self.assertEqual(MODULE.runtime_platform(), ("win32", "x64"))

    def test_failed_cron_registration_is_not_downgraded_to_pending(self):
        from unittest.mock import Mock
        update = SimpleNamespace(install_update_check=Mock(side_effect=RuntimeError("cron registration failed")))
        with patch.object(MODULE, "module_at", return_value=update):
            with self.assertRaisesRegex(RuntimeError, "cron registration failed"):
                MODULE.install_update_check(Path("/unused"), Path("/unused/ops"))

    def test_snapshot_rejects_paths_pointing_outside_isolated_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home, outside = root / "home", root / "outside"
            home.mkdir()
            outside.mkdir()
            (home / "scripts").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "越过安装目录"):
                MODULE.snapshot_targets(home, [home / "scripts/reminder.py"], root / "backup")

    def test_failed_nora_probe_restores_config_and_never_marks_setup_done(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, home, tavern = root / "source", root / "hermes", root / "tavern"
            home.mkdir()
            (home / "config.yaml").write_text("user_setting: preserved\n")
            (home / "SOUL.md").write_text("custom Nora")
            (home / ".env").write_text("TEST_ONLY_SENTINEL=preserve\n")
            (home / "cron").mkdir()
            original_jobs = '{"jobs": [{"id": "personal"}]}'
            (home / "cron/jobs.json").write_text(original_jobs)
            for folder in ("app", "nora-mcp", "ops/skills", "ops/installer/templates"):
                (source / folder).mkdir(parents=True)
            (source / "ops/skills/agents-tavern.md").write_text("<!-- BEGIN TAVERN SKILLS -->\nNora\n<!-- END TAVERN SKILLS -->")
            (source / "ops/installer/templates/SOUL.md").write_text("Nora template")
            skill = root / "prepared"
            skill.mkdir()
            (skill / "SKILL.md").write_text("Nora skill")
            args = SimpleNamespace(apply=True, confirm=True, nora_home=str(root), hermes_home=str(home),
                install_root=str(tavern), port=18899, dedicated_nora=True, force_first_install=False,
                replace_soul=False, skip_liveware=True)
            from ops.installer import nora_system
            def install_reminder(*_args):
                (home / "cron/jobs.json").write_text('{"jobs": [{"id": "nora"}]}')
                (home / "scripts").mkdir(exist_ok=True)
                (home / "scripts/nora-tavern-update-check.py").write_text("new script")
                return {"status": "installed"}
            with patch.dict(os.environ), \
                 patch.object(MODULE, "validate_hermes", return_value={}), \
                 patch.object(MODULE, "source_from_release", return_value=(source, {"versions": {"tavern": "2.2.8"}})), \
                 patch.object(MODULE, "prepare_skills", return_value={"creative/tavern": skill}), \
                 patch.object(MODULE, "install_host_hook", return_value="hook"), \
                 patch.object(MODULE, "start_tavern", return_value={"health": {"ok": True}}), \
                 patch.object(MODULE, "install_update_check", side_effect=install_reminder), \
                 patch.object(nora_system, "configure_managed"), \
                 patch.object(MODULE, "module_at", return_value=nora_system), \
                 patch.object(nora_system, "verify_runtime", side_effect=RuntimeError("probe failed")), \
                 patch.object(MODULE, "stop_install_runtime") as stop, \
                 patch.object(MODULE, "event") as event:
                with self.assertRaisesRegex(RuntimeError, "probe failed"):
                    MODULE.install(args)
                stop.assert_called_once_with(tavern.resolve())
            self.assertEqual((home / "config.yaml").read_text(), "user_setting: preserved\n")
            self.assertEqual((home / "SOUL.md").read_text(), "custom Nora")
            self.assertEqual((home / ".env").read_text(), "TEST_ONLY_SENTINEL=preserve\n")
            self.assertEqual((home / "cron/jobs.json").read_text(), original_jobs)
            self.assertFalse((home / "scripts/nora-tavern-update-check.py").exists())
            self.assertFalse((tavern / "tavern-updates/installed.json").exists())
            self.assertFalse((tavern / "apps/tavern-runtime").exists())
            self.assertFalse(any(call.kwargs.get("index") == 4 and call.kwargs.get("state") == "done" for call in event.call_args_list))

    def test_dedicated_initialization_replaces_only_upstream_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            defaults = home / "hermes-agent/hermes_cli/default_soul.py"
            defaults.parent.mkdir(parents=True)
            defaults.write_text('DEFAULT_SOUL_MD = "upstream identity"\n')
            soul = home / "SOUL.md"
            soul.write_text("upstream identity")
            MODULE.install_soul(home, ROOT, replace=False, dedicated=True)
            self.assertEqual(soul.read_bytes(), (ROOT / "ops/installer/templates/SOUL.md").read_bytes())
            soul.write_text("my personalized Nora")
            MODULE.install_soul(home, ROOT, replace=False, dedicated=True)
            self.assertEqual(soul.read_text(), "my personalized Nora")

    def test_mcp_uses_selected_instance_port(self):
        import yaml
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            value = yaml.safe_load(MODULE.render_mcp(root / "hermes", root / "tavern", port=18899))
            self.assertEqual(value["mcp_servers"]["nora"]["env"]["NORA_MCP_BASE_URL"], "http://127.0.0.1:18899")

    def test_first_install_persists_readable_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            MODULE.write_install_receipt(root, {"versions": {"tavern": "2.2.8"}, "commit": "abc"})
            receipt = json.loads((root / "tavern-updates/installed.json").read_text())
            self.assertEqual(receipt["version"], "2.2.8")
            self.assertEqual(receipt["commit"], "abc")

    def test_marks_verified_integrated_dependencies_as_ready(self):
        with tempfile.TemporaryDirectory(prefix="nora-integrated-deps-") as temporary:
            root = Path(temporary)
            source = root / "source"
            install_root = root / "install"
            engine = source / "app/engine/sillytavern"
            mcp = source / "nora-mcp/node_modules"
            (engine / "node_modules/express").mkdir(parents=True)
            (engine / "node_modules/webpack").mkdir(parents=True)
            (mcp / "@modelcontextprotocol/sdk").mkdir(parents=True)
            (mcp / "zod").mkdir(parents=True)
            (engine / "package-lock.json").write_text('{"lockfileVersion": 3}\n', encoding="utf-8")
            for path in (
                engine / "node_modules/express/package.json",
                engine / "node_modules/webpack/package.json",
                mcp / "@modelcontextprotocol/sdk/package.json",
                mcp / "zod/package.json",
            ):
                path.write_text("{}\n", encoding="utf-8")

            MODULE.mark_bundled_dependencies(source, install_root, {
                "integratedDependencies": {"nodeMajor": 26},
            })

            marker = json.loads((install_root / "tavern-state/native-runtime/dependencies.json").read_text(encoding="utf-8"))
            self.assertEqual(marker["node_major"], 26)
            self.assertEqual(marker["source"], "nora-integrated-package")

    def test_restores_existing_targets_and_removes_targets_created_after_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="nora-first-install-test-") as temporary:
            home = Path(temporary) / "home"
            backup = Path(temporary) / "backup"
            existing_file = home / "config.yaml"
            existing_tree = home / "skills/creative/tavern"
            new_tree = home / "apps/tavern-runtime"
            existing_tree.mkdir(parents=True)
            existing_file.write_text("original: true\n", encoding="utf-8")
            (existing_tree / "SKILL.md").write_text("original skill\n", encoding="utf-8")

            records = MODULE.snapshot_targets(home, [existing_file, existing_tree, new_tree], backup)
            existing_file.write_text("changed: true\n", encoding="utf-8")
            (existing_tree / "SKILL.md").write_text("changed skill\n", encoding="utf-8")
            new_tree.mkdir(parents=True)
            (new_tree / "server.js").write_text("new runtime\n", encoding="utf-8")

            MODULE.restore_targets(home, records, backup)

            self.assertEqual(existing_file.read_text(encoding="utf-8"), "original: true\n")
            self.assertEqual((existing_tree / "SKILL.md").read_text(encoding="utf-8"), "original skill\n")
            self.assertFalse(new_tree.exists())

    def test_installs_the_runtime_hook_at_the_path_hermes_executes(self):
        with tempfile.TemporaryDirectory(prefix="nora-first-install-hook-") as temporary:
            root = Path(temporary)
            home = root / "home"
            source = root / "source"
            origin = source / "ops/hooks/tavern-liveware-register"
            origin.mkdir(parents=True)
            (origin / "HOOK.yaml").write_text("name: tavern-liveware-register\n", encoding="utf-8")
            (origin / "handler.py").write_text("HANDLER = 'new'\n", encoding="utf-8")
            (origin / "run.sh").write_text("#!/bin/sh\n# ensure\n", encoding="utf-8")

            installed = MODULE.install_host_hook(home, source)

            self.assertEqual(installed, str(home / "hooks/tavern-liveware-register"))
            self.assertEqual(
                (home / "hooks/tavern-liveware-register/run.sh").read_text(encoding="utf-8"),
                "#!/bin/sh\n# ensure\n",
            )


if __name__ == "__main__":
    unittest.main()
