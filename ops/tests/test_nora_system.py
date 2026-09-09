import json
import shutil
from pathlib import Path
import tempfile
import unittest
from ops.installer import nora_system as system
from ops.installer import first_install


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
        (self.home / "AGENTS.md").write_text("<!-- BEGIN TAVERN SKILLS -->\ninstructions")
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


if __name__ == "__main__":
    unittest.main()
