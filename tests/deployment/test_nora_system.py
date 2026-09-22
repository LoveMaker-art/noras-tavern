import json
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack
from types import SimpleNamespace
from ops.installer import nora_system as system
from ops.installer import first_install
from ops.installer import launcher_bridge as bridge


class NoraSystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "hermes"
        self.root = Path(self.temp.name) / "tavern"
        self.home.mkdir()
        for name in system.SKILLS:
            file = self.home / "skills" / name / "SKILL.md"
            file.parent.mkdir(parents=True)
            file.write_text("test skill")
        cardforge = Path(__file__).resolve().parents[1] / "skills/creative/nora-cardforge"
        for name in ("resources/starter-stories", "references", "scripts"):
            shutil.copytree(cardforge / name, self.home / "skills/creative/nora-cardforge" / name, dirs_exist_ok=True)
        for relative in ("apps/nora-mcp/dist/server.js", "apps/tavern-runtime/native_lifecycle.py", "apps/tavern-runtime/story_profile_runtime/manifest.json"):
            file = self.root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("{}")
        (self.home / "SOUL.md").write_text("Nora")
        (self.home / "AGENTS.md").write_text("## Environment\n\nProject instructions.\n")
        node = self.home / "node"
        node.touch()
        import yaml
        config = yaml.safe_load(first_install.render_mcp(self.home, self.root, 18899))
        config["mcp_servers"]["nora"]["command"] = str(node)
        (self.home / "config.yaml").write_text(yaml.safe_dump(config))
        system.save_json(self.home / "hermes-agent/.hermes-bootstrap-complete", {"sha256": "hash"})
        system.save_json(self.home / "nora-components.json", {"files": {"node": "hash"}})
        python = self.home / "hermes-agent/venv/bin/python3"
        python.parent.mkdir(parents=True)
        python.touch()
        self.manifest = {"versions": {"tavern": "2.2.8"}, "commit": "a" * 40}
        system.save_json(self.home / "nora-instance.json", {"schema": 1, "port": 18899,
            "noraHome": str(self.home.parent), "hermesHome": str(self.home), "installRoot": str(self.root)})
        for name in system.MANAGED_FILES:
            file = self.home / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("events: [gateway:startup]" if name.endswith("HOOK.yaml") else "managed")
        for name in system.CLAWCHAT_SKILLS:
            file = self.home / "clawchat-skills" / name / "SKILL.md"
            file.parent.mkdir(parents=True)
            file.write_text(name)
        greeting = self.home / "clawchat/greeting.md"
        greeting.parent.mkdir()
        greeting.write_text("Nora")
        config["skills"] = {"external_dirs": ["clawchat-skills"]}
        (self.home / "config.yaml").write_text(yaml.safe_dump(config))
        self.job = {"id": "nora", "script": "nora-tavern-update-check.py", "enabled": True,
                    "no_agent": True, "deliver": "local", "schedule": {"expr": "0 9 * * *"}}
        system.save_json(self.home / "cron/jobs.json", {"jobs": [self.job]})

    def initialize(self):
        system.record_initialization(self.home, self.root, self.manifest, {name: True for name in system.PROOFS})
        first_install.write_install_receipt(self.root, self.manifest)

    def test_files_alone_are_not_a_complete_installation(self):
        result = system.inspect(self.home, self.root, 18899)
        self.assertFalse(result["ready"])
        self.assertFalse(result["setupCompleted"])

    def test_verified_install_is_not_yet_paired_and_configured(self):
        self.initialize()
        result = system.inspect(self.home, self.root, 18899)
        self.assertTrue(result["ready"], result["problems"])
        self.assertFalse(result["setupCompleted"])
        system.mark_setup_complete(self.root)
        self.assertTrue(system.inspect(self.home, self.root, 18899)["setupCompleted"])

    def test_missing_skill_invalidates_completion(self):
        self.initialize()
        system.mark_setup_complete(self.root)
        (self.home / "skills/creative/tavern/SKILL.md").unlink()
        result = system.inspect(self.home, self.root, 18899)
        self.assertFalse(result["ready"])
        self.assertFalse(result["setupCompleted"])

    def test_empty_or_missing_agents_invalidates_completion(self):
        self.initialize()
        system.mark_setup_complete(self.root)
        path = self.home / "AGENTS.md"
        for content in ("", " \n", None):
            with self.subTest(content=content):
                if content is None:
                    path.unlink()
                else:
                    path.write_text(content)
                result = system.inspect(self.home, self.root, 18899)
                self.assertFalse(result["ready"])
                self.assertFalse(result["setupCompleted"])

    def test_custom_personality_is_preserved_on_reopen(self):
        self.initialize()
        (self.home / "SOUL.md").write_text("my Nora")
        self.assertTrue(system.inspect(self.home, self.root, 18899)["ready"])
        self.assertEqual((self.home / "SOUL.md").read_text(), "my Nora")

    def test_wrong_instance_and_changed_release_are_not_ready(self):
        self.initialize()
        self.assertFalse(system.inspect(self.home, self.root, 8799)["ready"])
        first_install.write_install_receipt(self.root, {"versions": {"tavern": "2.2.9"}, "commit": "b" * 40})
        self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])

    def test_completion_requires_runtime_evidence(self):
        with self.assertRaises(RuntimeError):
            system.mark_setup_complete(self.root)

    def test_changed_hook_invalidates_completion(self):
        self.initialize()
        (self.home / "hooks/tavern-liveware-register/handler.py").write_text("wrong")
        self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])

    def test_disabled_or_duplicate_cron_invalidates_completion(self):
        self.initialize()
        for jobs in ([{**self.job, "enabled": False}], [self.job, self.job], []):
            system.save_json(self.home / "cron/jobs.json", {"jobs": jobs})
            self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])

    def test_malformed_records_are_not_ready_instead_of_crashing_status(self):
        self.initialize()
        system.save_json(self.home / "cron/jobs.json", {"jobs": None})
        record_path = self.root / "tavern-updates/nora-system.json"
        record = system.read_json(record_path)
        system.save_json(record_path, {**record, "proof": None, "managed": None})
        self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])

    def test_clawchat_skill_and_greeting_are_required(self):
        self.initialize()
        (self.home / "clawchat/greeting.md").unlink()
        self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])

    def test_old_partial_proof_cannot_claim_complete(self):
        self.initialize()
        path = self.root / "tavern-updates/nora-system.json"
        record = system.read_json(path)
        record["proof"] = {"hermesContext": True, "mcpInstanceRead": True}
        system.save_json(path, record)
        self.assertFalse(system.inspect(self.home, self.root, 18899)["ready"])
        with self.assertRaises(RuntimeError):
            system.mark_setup_complete(self.root)

    def test_daily_state_reads_acceptance_receipts_without_inspecting_user_files(self):
        self.initialize()
        system.record_files_ready(self.home)
        system.mark_setup_complete(self.root)
        with patch.object(system, 'digest', side_effect=AssertionError('daily hash check')), \
                patch.object(system, 'managed_problems', side_effect=AssertionError('daily acceptance check')):
            state = system.installation_state(self.home, self.root)
        self.assertTrue(state['ready'])
        self.assertTrue(state['setupCompleted'])
        self.assertTrue(state['noraInstalled'])

    def test_daily_state_preserves_edit_delete_disable_and_add_operations(self):
        self.initialize()
        system.record_files_ready(self.home)
        system.mark_setup_complete(self.root)
        for name in ('skills/creative/tavern/SKILL.md', 'SOUL.md', 'AGENTS.md',
                     'hooks/tavern-liveware-register/handler.py', 'config.yaml'):
            (self.home / name).write_text('user edited content')
        (self.home / 'skills/creative/tavern-ops/SKILL.md').unlink()
        (self.home / 'clawchat/greeting.md').unlink()
        personal = self.home / 'skills/personal/SKILL.md'
        personal.parent.mkdir()
        personal.write_text('my own skill')
        system.save_json(self.home / 'cron/jobs.json', {'jobs': [{**self.job, 'enabled': False}]})
        for _ in range(2):
            state = system.installation_state(self.home, self.root)
            self.assertTrue(state['ready'], state)
            self.assertTrue(state['setupCompleted'])
        self.assertEqual((self.home / 'config.yaml').read_text(), 'user edited content')
        self.assertFalse((self.home / 'skills/creative/tavern-ops/SKILL.md').exists())
        self.assertFalse(system.read_json(self.home / 'cron/jobs.json')['jobs'][0]['enabled'])
        # Explicit installation acceptance still rejects incomplete/mutated delivery.
        self.assertFalse(system.inspect(self.home, self.root, 18899)['ready'])

    def test_daily_state_requires_recorded_initial_acceptance_not_current_file_hashes(self):
        state = system.installation_state(self.home, self.root)
        self.assertFalse(state['ready'])
        self.initialize()
        self.assertTrue(system.installation_state(self.home, self.root)['ready'])
        self.assertFalse(system.installation_state(self.home, self.root)['setupCompleted'])
        record = self.root / 'tavern-updates/nora-system.json'
        system.save_json(record, {'schema': 1, 'proof': None, 'setupCompleted': True})
        self.assertFalse(system.installation_state(self.home, self.root)['ready'])

    def test_status_poll_does_not_revalidate_files_or_rewrite_customizations(self):
        self.initialize()
        system.record_files_ready(self.home)
        system.mark_setup_complete(self.root)
        (self.home / 'skills/creative/tavern/SKILL.md').write_text('my edited skill')
        with ExitStack() as stack:
            for name in ('inspect', 'files_ready', 'digest', 'managed_problems'):
                stack.enter_context(patch.object(system, name, side_effect=AssertionError('poll revalidated ' + name)))
            stack.enter_context(patch.object(bridge, 'hermes_command', return_value='python'))
            stack.enter_context(patch.object(bridge, 'read_verified_model', return_value={}))
            stack.enter_context(patch.object(bridge, 'gateway_status', return_value={'clawchatConnected': False}))
            stack.enter_context(patch.object(bridge, 'clawchat_paired', return_value=False))
            stack.enter_context(patch.object(bridge, 'installed', return_value=True))
            stack.enter_context(patch.object(bridge, 'run_json', return_value={'health': {'ok': True}}))
            stack.enter_context(patch.object(bridge, 'env_for', return_value={}))
            stack.enter_context(patch.object(bridge, 'python_command', return_value='python'))
            for _ in range(2):
                state = bridge.status_payload(self.home.parent, self.home, self.root, 18899)
                self.assertTrue(state['systemReady'])
                self.assertTrue(state['noraInstalled'])
                self.assertTrue(state['running'])
        self.assertEqual((self.home / 'skills/creative/tavern/SKILL.md').read_text(), 'my edited skill')

    def exercise_start(self, *, first_setup=False, failure=None):
        self.initialize()
        if not first_setup:
            system.mark_setup_complete(self.root)
        (self.root / 'apps/tavern-runtime/native-runtime.json').write_text('{}')
        (self.home / 'skills/creative/tavern/SKILL.md').write_text('custom skill')
        system.save_json(self.home / 'cron/jobs.json', {'jobs': []})
        args = SimpleNamespace(nora_home=self.home.parent, hermes_home=self.home,
                               install_root=self.root, port=18899, service='all', command='start')
        with ExitStack() as stack:
            for name in ('inspect', 'files_ready', 'digest'):
                stack.enter_context(patch.object(system, name, side_effect=AssertionError('startup revalidated ' + name)))
            for name, value in (('env_for', {}), ('python_command', 'fixture-python'),
                                ('status_payload', {'running': True, 'clawchatConnected': True})):
                stack.enter_context(patch.object(bridge, name, return_value=value))
            model = stack.enter_context(patch.object(bridge, 'read_verified_model', return_value={'model': 'fixture'}))
            paired = stack.enter_context(patch.object(bridge, 'clawchat_paired', return_value=True))
            sync = stack.enter_context(patch.object(bridge, 'sync_nora_profile'))
            bundle = stack.enter_context(patch.object(bridge, 'require_bundled_clawchat'))
            run = stack.enter_context(patch.object(bridge, 'run_stream', side_effect=failure))
            gateway = stack.enter_context(patch.object(bridge, 'start_gateway'))
            verify = stack.enter_context(patch.object(system, 'verify_runtime'))
            mark = stack.enter_context(patch.object(system, 'mark_setup_complete'))
            emit = stack.enter_context(patch.object(bridge, 'emit'))
            if failure:
                with self.assertRaisesRegex(RuntimeError, 'fixture start failure'):
                    bridge.command_start(args)
                gateway.assert_not_called()
                verify.assert_not_called()
                self.assertFalse(any(call.kwargs.get('state') == 'done' for call in emit.call_args_list))
            else:
                bridge.command_start(args)
                self.assertEqual(run.call_count, 2 if first_setup else 1)
                gateway.assert_called_once()
                self.assertEqual(verify.call_count, int(first_setup))
                self.assertEqual(mark.call_count, int(first_setup))
                self.assertEqual(bundle.call_count, int(first_setup))
                self.assertEqual(sync.call_count, int(first_setup))
            self.assertEqual(model.call_count, int(first_setup))
            self.assertEqual(paired.call_count, int(first_setup))
        self.assertEqual(system.read_json(self.home / 'cron/jobs.json'), {'jobs': []})

    def test_completed_install_starts_without_reaccepting_or_forcing_registration(self):
        self.exercise_start()

    def test_first_setup_still_runs_delivery_acceptance(self):
        self.exercise_start(first_setup=True)

    def test_actual_start_failure_is_not_hidden_by_historical_acceptance(self):
        self.exercise_start(failure=RuntimeError('fixture start failure'))


if __name__ == "__main__":
    unittest.main()
