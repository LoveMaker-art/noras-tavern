#!/usr/bin/env python3
"""Exercise a real Release upgrade and rollback in an isolated data root."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
UPDATER = ROOT / "skills/tavern-updater/scripts/update.py"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def release_document(version, assets):
    names = ["manifest.json", "tavern-release.tar.gz", "skill-manifest.json", "tavern-skill.tar.gz"]
    names.extend(path.name for path in sorted(assets.glob("baseline-v*-manifest.json")))
    names.extend(path.name for path in sorted(assets.glob("tavern-baseline-v*.tar.gz")))
    return {
        "tag_name": "v" + version,
        "draft": False,
        "prerelease": False,
        "html_url": "https://example.invalid/releases/tag/v" + version,
        "assets": [
            {"name": name, "browser_download_url": (assets / name).resolve().as_uri()}
            for name in names
        ],
    }


def extract_install(assets, data_root):
    with tempfile.TemporaryDirectory(prefix="tavern-install-stage-") as temp:
        stage = Path(temp)
        with tarfile.open(assets / "tavern-release.tar.gz", "r:gz") as package:
            package.extractall(stage)
        with tarfile.open(assets / "tavern-skill.tar.gz", "r:gz") as package:
            package.extractall(stage)
        shutil.copytree(stage / "runtime", data_root / "apps/tavern-runtime")
        shutil.copytree(stage / "updater", data_root / "skills/system/tavern-updater")
        system_skills = stage / "system-skills"
        if system_skills.is_dir():
            for skill in system_skills.iterdir():
                if skill.is_dir():
                    shutil.copytree(skill, data_root / "skills/system" / skill.name)
        shutil.copy2(stage / "updater/references/AGENTS.md", data_root / "AGENTS.md")
        creative_root = data_root / "skills/creative"
        creative_root.mkdir(parents=True)
        for skill in (stage / "skills").iterdir():
            if skill.is_dir():
                shutil.copytree(skill, creative_root / skill.name)


def refresh_updater(assets, data_root):
    """Mirror the bootstrap step that installs the target updater before review."""
    with tempfile.TemporaryDirectory(prefix="tavern-updater-refresh-") as temp:
        stage = Path(temp)
        with tarfile.open(assets / "tavern-release.tar.gz", "r:gz") as package:
            package.extractall(stage)
        shutil.copytree(
            stage / "updater",
            data_root / "skills/system/tavern-updater",
            dirs_exist_ok=True,
        )


def run_json(command, env):
    result = subprocess.run(command, env=env, text=True, capture_output=True)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{detail}"
        )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return json.loads(lines[-1])


def state_hashes(root):
    return {
        path.relative_to(root).as_posix(): sha256(path)
        for path in root.rglob("*")
        if path.is_file()
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-assets", required=True, type=Path)
    parser.add_argument("--target-assets", required=True, type=Path)
    parser.add_argument("--simulate-unknown-baseline", action="store_true")
    args = parser.parse_args()
    base_manifest = json.loads((args.base_assets / "manifest.json").read_text())
    target_manifest = json.loads((args.target_assets / "manifest.json").read_text())
    base_version = base_manifest["version"]
    target_version = target_manifest["version"]

    with tempfile.TemporaryDirectory(prefix="tavern-update-integration-") as temp:
        root = Path(temp)
        data = root / "data"
        extract_install(args.base_assets, data)
        refresh_updater(args.target_assets, data)
        runtime = data / "apps/tavern-runtime"
        installed_version = "0.9.0" if args.simulate_unknown_baseline else base_version
        if args.simulate_unknown_baseline:
            (runtime / ".tavern-release-version").write_text(
                installed_version + "\n", encoding="utf-8"
            )
        server = runtime / "server.py"
        server.write_text(
            server.read_text(encoding="utf-8") + "\n# local retry-policy patch\n",
            encoding="utf-8",
        )
        model_retry = runtime / "model_retry.py"
        if model_retry.is_file():
            model_retry.write_text(
                model_retry.read_text(encoding="utf-8") + "\n# local retry-five patch\n",
                encoding="utf-8",
            )
        starter = data / "apps/tavern-runtime/assets/fixtures/starter"
        starter.mkdir(parents=True, exist_ok=True)
        starter_index = starter / "index.json"
        if starter_index.is_file():
            starter_document = json.loads(starter_index.read_text(encoding="utf-8"))
        else:
            starter_document = {"note": "local starter catalog", "cards": []}
        starter_document.setdefault("cards", []).append({
            "file": "custom-local.png",
            "name": "Custom Local",
            "source": "local:integration-fixture",
        })
        starter_index.write_text(
            json.dumps(starter_document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        custom_starter = starter / "custom-local.png"
        custom_starter.write_bytes(b"local starter fixture")
        custom_starter_hash = sha256(custom_starter)
        protected = data / "tavern-state"
        protected.mkdir(parents=True)
        (protected / "private.json").write_text('{"preference":"keep me"}\n', encoding="utf-8")
        private_hash = sha256(protected / "private.json")

        api = root / "api"
        (api / "tags").mkdir(parents=True)
        (api / "latest.json").write_text(
            json.dumps(release_document(target_version, args.target_assets)), encoding="utf-8")
        (api / "tags" / f"v{base_version}.json").write_text(
            json.dumps(release_document(base_version, args.base_assets)), encoding="utf-8")

        env = os.environ.copy()
        env.update({
            "TAVERN_DATA_ROOT": str(data),
            "TAVERN_UPDATE_API": (api / "latest.json").resolve().as_uri(),
            "TAVERN_UPDATE_TAG_API": "file://" + str((api / "tags/v{version}.json").resolve()),
            "TAVERN_PYTHON": sys.executable,
            "TAVERN_SKIP_SERVICE": "1",
        })
        review = run_json([sys.executable, str(UPDATER), "review"], env)
        assert review["ready"], {
            "conflicts": review["conflicts"],
            "baseline_source": review["baseline_source"],
            "baseline_warning": review["baseline_warning"],
        }
        assert review["conflicts"] == []
        if args.simulate_unknown_baseline:
            assert not review["baseline_trusted"]
            assert review["baseline_source"] == "unavailable"
        else:
            assert review["baseline_trusted"]
        report = run_json(
            [sys.executable, str(UPDATER), "report", "--plan", review["plan_id"]], env)
        assert report["ready"]
        applied = run_json(
            [sys.executable, str(UPDATER), "apply", "--plan", review["plan_id"], "--confirm"], env)
        assert applied["to"] == target_version
        assert (data / "apps/tavern-runtime/.tavern-release-version").read_text().strip() == target_version
        assert sha256(protected / "private.json") == private_hash
        assert sha256(starter_index) == target_manifest["files"][
            "runtime/assets/fixtures/starter/index.json"
        ]
        protected_starter = protected / "starter"
        merged_starter = json.loads(
            (protected_starter / "index.json").read_text(encoding="utf-8")
        )
        assert any(
            card.get("source") == "local:integration-fixture"
            for card in merged_starter.get("cards") or []
        )
        assert sha256(protected_starter / "custom-local.png") == custom_starter_hash
        baseline_meta = json.loads((data / "tavern-updates/baseline/.baseline.json").read_text())
        assert baseline_meta["version"] == target_version
        assert sha256(data / "tavern-updates/baseline/runtime/server.py") == target_manifest["files"]["runtime/server.py"]

        rolled_back = run_json([sys.executable, str(UPDATER), "rollback", "--confirm"], env)
        assert rolled_back["to"] == installed_version
        assert sha256(protected / "private.json") == private_hash
        assert not protected_starter.exists()
        assert sha256(custom_starter) == custom_starter_hash
        assert not (data / "tavern-updates/state.json").exists()
        print(json.dumps({
            "ok": True,
            "from": installed_version,
            "to": target_version,
            "baseline": review["baseline_source"],
            "protected_user_data_preserved": True,
            "legacy_code_patches_replaced": True,
            "rollback": True,
        }))


if __name__ == "__main__":
    main()
