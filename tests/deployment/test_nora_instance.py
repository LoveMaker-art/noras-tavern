import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InstanceTests(unittest.TestCase):
    def test_legacy_recovery_uses_existing_mcp_port_without_creating_a_home(self):
        import yaml
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            config = {"mcp_servers": {"nora": {"env": {"NORA_MCP_BASE_URL": "http://127.0.0.1:18899",
                      "NORA_MCP_STATE_ROOT": str(home / "tavern-state")}}}}
            (home / "config.yaml").write_text(yaml.safe_dump(config))
            module = load("instance_legacy", ROOT / "ops/scripts/nora-instance.py")
            value = module.configuration(home)
            self.assertEqual(value["port"], 18899)
            self.assertEqual(value["installRoot"], str(home.resolve()))
            self.assertFalse((home / "nora-instance.json").exists())

    def test_windows_lock_uses_one_byte_at_stable_offset(self):
        module = load("nora_lock_test", ROOT / "ops/updater/runtime_lock.py")
        from unittest.mock import Mock
        windows = SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=Mock())
        with tempfile.TemporaryDirectory() as temporary, \
             patch.object(module, "os", SimpleNamespace(name="nt")), \
             patch.dict(sys.modules, msvcrt=windows):
            with module.installation_lock(Path(temporary)):
                pass
        self.assertEqual([call.args[1:] for call in windows.locking.call_args_list], [(1, 1), (2, 1)])

    def test_legacy_updater_refuses_managed_nora_before_mutation(self):
        module = load("nora_legacy_updater_test", ROOT / "ops/updater/update.py")
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            (home / "nora-instance.json").write_text("{}")
            with self.assertRaisesRegex(RuntimeError, "禁止"):
                module.install(SimpleNamespace(home=str(home), install_root=str(home / "tavern")))
            self.assertEqual(sorted(file.name for file in home.iterdir()), ["nora-instance.json"])

    def test_check_uses_instance_file_not_stale_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "hermes"
            home.mkdir()
            config = {"schema": 1, "noraHome": str(root), "hermesHome": str(home),
                      "installRoot": str(root / "tavern"), "port": 18899}
            (home / "nora-instance.json").write_text(json.dumps(config))
            result = subprocess.run([sys.executable, "-B", str(ROOT / "ops/scripts/nora-instance.py"), "check"],
                env={**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": "/unrelated"},
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"ok": True, "port": 18899})
            config["installRoot"] = str(root.parent / "other")
            (home / "nora-instance.json").write_text(json.dumps(config))
            module = load("nora_instance", ROOT / "ops/scripts/nora-instance.py")
            with self.assertRaises(RuntimeError):
                module.configuration(home)

    def test_liveware_recovery_propagates_nondefault_port(self):
        integration = load("liveware_test", ROOT / "ops/updater/liveware_integration.py")
        with patch.object(integration, "start_runtime") as start, \
             patch.object(integration, "repair", return_value={"status": "updated"}) as repair:
            integration.ensure(Path("/isolated/tavern"), 18899, hermes_home=Path("/isolated/hermes"))
        self.assertEqual(start.call_args.kwargs["port"], 18899)
        self.assertEqual(repair.call_args.args[1], 18899)

    def test_hook_uses_hermes_python_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, HERMES_HOME=temporary):
            (Path(temporary) / "nora-instance.json").write_text("{}")
            hook = load("hook_test", ROOT / "ops/hooks/tavern-liveware-register/handler.py")
            with patch.object(hook.subprocess, "Popen") as spawn:
                hook.handle("irrelevant", {})
                spawn.assert_not_called()
                hook.handle("gateway:startup", {})
                self.assertEqual(spawn.call_args.args[0], [sys.executable, "-B",
                    str(Path(temporary).resolve() / "scripts/nora-instance.py"), "recover-existing"])

    def test_existing_recovery_cli_preserves_nondefault_port(self):
        integration = load("liveware_recovery_port", ROOT / "ops/updater/liveware_integration.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tavern, hermes = root / "tavern", root / "hermes"
            state = tavern / "tavern-state/apps.json"
            state.parent.mkdir(parents=True)
            state.write_text(json.dumps({
                "console": {"app_id": "app-tavern", "domain": "app-tavern.apps.clawling.io"},
                "actor": {"app_id": "app-profile", "domain": "app-profile.apps.clawling.io"},
            }))
            with patch.object(sys, "argv", ["liveware_integration.py", "--home", str(tavern),
                    "--hermes-home", str(hermes), "--port", "18899", "recover-existing"]), \
                 patch.object(integration, "start_runtime") as start, \
                 patch.object(integration, "repair") as repair, \
                 patch.object(integration, "refresh", return_value={"status": "updated"}) as refresh, \
                 patch("builtins.print"):
                integration.main()
            start.assert_called_once_with(tavern, port=18899, hermes_home=hermes)
            refresh.assert_called_once_with(tavern, 18899, hermes_home=hermes)
            repair.assert_not_called()


if __name__ == "__main__":
    unittest.main()
