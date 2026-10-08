import importlib.util
import io
import json
import os
from pathlib import Path, PureWindowsPath
import sys
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch, Mock

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
        # These tests start at the target-selection boundary. Real CLI owner
        # admission is exercised by the independent native/APP gates.
        cli = SimpleNamespace(ensure_operation=Mock())
        with patch.object(sys, "argv", ["bootstrap.py", "--apply", "--confirm",
                                        "--target-commit", "same-commit", *extra]), \
                patch.dict(sys.modules, operation_cli=cli), \
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

    def test_world_probe_uses_regular_windows_paths_at_node_boundary(self):
        state = self.root / "state"
        (state / "native").mkdir(parents=True)
        for prefix, expected in [("\\\\?\\C:\\Nora", "C:\\Nora"),
                                 ("\\\\?\\UNC\\server\\share\\Nora", "\\\\server\\share\\Nora")]:
            with self.subTest(prefix=prefix), \
                    patch.object(UPDATER.sys, "platform", "win32"), \
                    patch.object(UPDATER, "HERE", PureWindowsPath(prefix) / "ops/updater"), \
                    patch.object(UPDATER.shutil, "which", return_value="node.exe"), \
                    patch.object(UPDATER._operation_control, "managed_run", return_value=SimpleNamespace(stdout="{}")) as probe:
                self.assertEqual(UPDATER.verify_worlds(PureWindowsPath(prefix) / "app", state), {})
                command = probe.call_args.args[0]
                self.assertEqual(command[1], str(PureWindowsPath(expected) / "ops/updater/verify-worlds.mjs"))
                self.assertEqual(command[2], str(PureWindowsPath(expected) / "app"))
                self.assertEqual(probe.call_args.kwargs["check"], True)

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

    def test_managed_update_requires_matching_instance_not_outer_directory_backup(self):
        tavern = self.managed_installation()
        self.assertEqual(BOOTSTRAP.resolve_update_target(
            self.home, tavern, managed_home=self.root), (self.home, tavern))
        journal = self.root / "installer/system-update/journal.json"
        journal.unlink()
        self.assertEqual(BOOTSTRAP.resolve_update_target(
            self.home, tavern, managed_home=self.root), (self.home, tavern))

    def historical_without_acceptance(self):
        tavern = self.managed_installation()
        updates = tavern / 'tavern-updates'
        (updates / 'nora-system.json').unlink()
        (updates / 'installed.json').write_text(json.dumps({'schema':1,'version':'2.3.15','commit':'a'*40}))
        (updates / 'installed-manifest.json').write_text(json.dumps({
            'schema':'tavern-release/v2','versions':{'tavern':'2.3.15'},'commit':'a'*40}))
        return tavern

    def test_missing_acceptance_can_resolve_only_with_consistent_desktop_history(self):
        tavern = self.historical_without_acceptance()
        files = {p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(BOOTSTRAP.resolve_update_target(self.home,tavern,managed_home=self.root),(self.home,tavern))
        self.assertTrue(BOOTSTRAP.managed_instance(self.home,self.root)['missingSystemReceipt'])
        self.assertEqual(files,{p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        with self.assertRaisesRegex(RuntimeError,'启动器'):
            BOOTSTRAP.resolve_update_target(self.home,tavern)

    def test_managed_instance_names_missing_record_without_private_path(self):
        tavern = self.historical_without_acceptance()
        (tavern / 'tavern-updates/installed-manifest.json').unlink()
        with self.assertRaises(RuntimeError) as failure:
            BOOTSTRAP.managed_instance(self.home, self.root)
        self.assertEqual(str(failure.exception),
                         '无法核对启动器实例记录，已停止更新：缺少 installed-manifest.json。')
        self.assertNotIn(str(self.root), str(failure.exception))
        self.assertTrue(failure.exception.__suppress_context__)

    def test_managed_instance_reports_json_line_without_document_content(self):
        tavern = self.managed_installation()
        marker = tavern / 'tavern-updates/nora-system.json'
        marker.write_text('{\n"private-key": "private-model-credential",\ninvalid}')
        with self.assertRaises(RuntimeError) as failure:
            BOOTSTRAP.managed_instance(self.home, self.root)
        self.assertEqual(str(failure.exception),
                         '无法核对启动器实例记录，已停止更新：nora-system.json 的 JSON 损坏（第 3 行）。')
        self.assertNotIn('private-model-credential', str(failure.exception))
        self.assertNotIn(str(self.root), str(failure.exception))
        self.assertTrue(failure.exception.__suppress_context__)

    def test_managed_instance_reports_permission_without_os_error_text(self):
        self.managed_installation()
        private_error = PermissionError(13, 'private-config-value', str(self.home / 'nora-instance.json'))
        with patch.object(Path, 'read_text', side_effect=private_error):
            with self.assertRaises(RuntimeError) as failure:
                BOOTSTRAP.managed_instance(self.home, self.root)
        self.assertEqual(str(failure.exception),
                         '无法核对启动器实例记录，已停止更新：无法读取或核对 nora-instance.json，系统拒绝访问。')
        self.assertNotIn('private-config-value', str(failure.exception))
        self.assertNotIn(str(self.root), str(failure.exception))
        self.assertTrue(failure.exception.__suppress_context__)

    def test_managed_instance_reports_safe_file_read_failures(self):
        self.managed_installation()
        record = self.home / 'nora-instance.json'
        record.write_bytes(b'{"private-value": "\xff"}')
        with self.assertRaises(RuntimeError) as failure:
            BOOTSTRAP.managed_instance(self.home, self.root)
        self.assertEqual(str(failure.exception),
                         '无法核对启动器实例记录，已停止更新：nora-instance.json 不是有效的 UTF-8 文本。')
        for error, reason in [(IsADirectoryError('private-config-value'),
                               'nora-instance.json 不是可读取的记录文件。'),
                              (OSError(5, 'private-config-value'),
                               '读取或核对 nora-instance.json 时发生文件系统错误。')]:
            with self.subTest(reason=reason), patch.object(Path, 'read_text', side_effect=error):
                with self.assertRaises(RuntimeError) as failure:
                    BOOTSTRAP.managed_instance(self.home, self.root)
                self.assertEqual(str(failure.exception), '无法核对启动器实例记录，已停止更新：' + reason)
                self.assertNotIn('private-config-value', str(failure.exception))
                self.assertTrue(failure.exception.__suppress_context__)

    def test_managed_instance_names_invalid_binding_fields_without_values(self):
        self.managed_installation()
        record = self.home / 'nora-instance.json'
        original = json.loads(record.read_text())
        cases = [
            ([], 'nora-instance.json 不是 JSON 对象。'),
            ({**original, 'schema': 999}, 'nora-instance.json 的 schema 无效。'),
            ({key: value for key, value in original.items() if key != 'installRoot'},
             'nora-instance.json 缺少 installRoot 字段。'),
            ({**original, 'noraHome': '/private-user-value'},
             'nora-instance.json 的 noraHome 路径与启动器实例不符或为符号链接。'),
            ({**original, 'hermesHome': 42}, 'nora-instance.json 的 hermesHome 路径格式无效。'),
            ({**original, 'port': 'private-port-value'}, 'nora-instance.json 的 port 无效。'),
        ]
        for value, reason in cases:
            with self.subTest(reason=reason):
                record.write_text(json.dumps(value))
                with self.assertRaises(RuntimeError) as failure:
                    BOOTSTRAP.managed_instance(self.home, self.root)
                self.assertEqual(str(failure.exception), '无法核对启动器实例记录，已停止更新：' + reason)
                self.assertNotIn('private-user-value', str(failure.exception))
                self.assertNotIn('private-port-value', str(failure.exception))
                self.assertNotIn(str(self.root), str(failure.exception))
                self.assertEqual(json.loads(record.read_text()), value)

    def test_managed_instance_names_invalid_system_receipt_without_replacing_it(self):
        tavern = self.managed_installation()
        marker = tavern / 'tavern-updates/nora-system.json'
        for value, reason in [([], 'nora-system.json 不是 JSON 对象。'),
                              ({'schema': 999}, 'nora-system.json 的 schema 无效。')]:
            with self.subTest(reason=reason):
                marker.write_text(json.dumps(value))
                with self.assertRaises(RuntimeError) as failure:
                    BOOTSTRAP.managed_instance(self.home, self.root)
                self.assertEqual(str(failure.exception), '无法核对启动器实例记录，已停止更新：' + reason)
                self.assertEqual(json.loads(marker.read_text()), value)
        marker.unlink()
        target = self.root / 'private-receipt-name.json'
        target.write_text('{"schema":1}')
        marker.symlink_to(target)
        with self.assertRaises(RuntimeError) as failure:
            BOOTSTRAP.managed_instance(self.home, self.root)
        self.assertEqual(str(failure.exception),
                         '无法核对启动器实例记录，已停止更新：nora-system.json 为符号链接。')
        self.assertNotIn(str(target), str(failure.exception))

    def test_managed_instance_distinguishes_historical_receipt_failures(self):
        tavern = self.historical_without_acceptance()
        updates = tavern / 'tavern-updates'
        receipt = json.loads((updates / 'installed.json').read_text())
        manifest = json.loads((updates / 'installed-manifest.json').read_text())
        cases = [
            ('installed.json', [], 'installed.json 不是 JSON 对象。'),
            ('installed.json', {**receipt, 'schema': 999}, 'installed.json 的 schema 无效。'),
            ('installed-manifest.json', [], 'installed-manifest.json 不是 JSON 对象。'),
            ('installed-manifest.json', {**manifest, 'schema': 'private-schema'},
             'installed-manifest.json 的 schema 无效。'),
            ('installed.json', {**receipt, 'commit': 'private-commit'}, 'installed.json 的 commit 格式无效。'),
            ('installed.json', {**receipt, 'version': 'private-version'}, 'installed.json 的 version 格式无效。'),
            ('installed-manifest.json', {**manifest, 'commit': 'b' * 40},
             'installed.json 与 installed-manifest.json 的 commit 不一致。'),
            ('installed-manifest.json', {**manifest, 'versions': {'tavern': '2.3.16'}},
             'installed.json 与 installed-manifest.json 的 version 不一致。'),
            ('installed-manifest.json', {**manifest, 'versions': []},
             'installed-manifest.json 的 versions 字段格式无效。'),
        ]
        for name, value, reason in cases:
            with self.subTest(reason=reason):
                for original_name, original in [('installed.json', receipt), ('installed-manifest.json', manifest)]:
                    (updates / original_name).write_text(json.dumps(original))
                (updates / name).write_text(json.dumps(value))
                before = {file.name: file.read_bytes() for file in updates.iterdir() if file.is_file()}
                with self.assertRaises(RuntimeError) as failure:
                    BOOTSTRAP.managed_instance(self.home, self.root)
                self.assertEqual(str(failure.exception), '无法核对启动器实例记录，已停止更新：' + reason)
                self.assertNotIn('private-', str(failure.exception))
                self.assertNotIn(str(self.root), str(failure.exception))
                self.assertFalse((updates / 'nora-system.json').exists())
                self.assertEqual(before, {file.name: file.read_bytes() for file in updates.iterdir() if file.is_file()})

    def test_missing_acceptance_refuses_absent_or_conflicting_history(self):
        tavern = self.historical_without_acceptance()
        manifest = tavern / 'tavern-updates/installed-manifest.json'
        original = manifest.read_bytes()
        for broken in (None, '{}', json.dumps({'schema':'tavern-release/v2','versions':{'tavern':'2.3.15'},'commit':'b'*40})):
            with self.subTest(broken=broken):
                if broken is None:
                    manifest.unlink(missing_ok=True)
                else:
                    manifest.write_text(broken)
                with self.assertRaisesRegex(RuntimeError,'实例'):
                    BOOTSTRAP.resolve_update_target(self.home,tavern,managed_home=self.root)
                self.assertFalse((tavern / 'tavern-updates/nora-system.json').exists())
                manifest.write_bytes(original)

    def test_existing_corrupt_acceptance_is_not_treated_as_missing(self):
        tavern = self.historical_without_acceptance()
        marker = tavern / 'tavern-updates/nora-system.json'
        for content in ('not json','{"schema":999}'):
            with self.subTest(content=content):
                marker.write_text(content)
                with self.assertRaisesRegex(RuntimeError,'实例'):
                    BOOTSTRAP.resolve_update_target(self.home,tavern,managed_home=self.root)
                self.assertEqual(marker.read_text(),content)

    def test_missing_acceptance_still_refuses_wrong_paths_and_mcp_port(self):
        tavern = self.historical_without_acceptance()
        with self.assertRaisesRegex(RuntimeError,'实例'):
            BOOTSTRAP.resolve_update_target(self.home,tavern,managed_home=self.root/'other')
        (self.home / 'config.yaml').write_bytes(UPDATER.render_mcp(self.home,tavern,18898))
        with self.assertRaisesRegex(RuntimeError,'配置'):
            BOOTSTRAP.resolve_update_target(self.home,tavern,managed_home=self.root)

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
