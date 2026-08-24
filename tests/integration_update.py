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
        protected = data / "tavern-state"
        protected.mkdir(parents=True)
        (protected / "private.json").write_text('{"preference":"keep me"}\n', encoding="utf-8")
        before = state_hashes(protected)

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
        assert review["baseline_trusted"]
        report = run_json(
            [sys.executable, str(UPDATER), "report", "--plan", review["plan_id"]], env)
        assert report["ready"]
        applied = run_json(
            [sys.executable, str(UPDATER), "apply", "--plan", review["plan_id"], "--confirm"], env)
        assert applied["to"] == target_version
        assert (data / "apps/tavern-runtime/.tavern-release-version").read_text().strip() == target_version
        assert state_hashes(protected) == before
        baseline_meta = json.loads((data / "tavern-updates/baseline/.baseline.json").read_text())
        assert baseline_meta["version"] == target_version
        assert sha256(data / "tavern-updates/baseline/runtime/server.py") == target_manifest["files"]["runtime/server.py"]

        rolled_back = run_json([sys.executable, str(UPDATER), "rollback", "--confirm"], env)
        assert rolled_back["to"] == base_version
        assert state_hashes(protected) == before
        assert not (data / "tavern-updates/state.json").exists()
        print(json.dumps({
            "ok": True,
            "from": base_version,
            "to": target_version,
            "baseline": review["baseline_source"],
            "protected_state_unchanged": True,
            "rollback": True,
        }))


if __name__ == "__main__":
    main()
