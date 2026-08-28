#!/usr/bin/env python3
"""Install Tavern's verified updater on legacy Hermes/ClawChat instances."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid


REPO = os.environ.get("TAVERN_UPDATE_REPO", "LoveMaker-art/noras-tavern")
RELEASE_BASE_URL = os.environ.get(
    "TAVERN_BOOTSTRAP_RELEASE_BASE_URL",
    f"https://github.com/{REPO}/releases/latest/download",
)
ASSET_MANIFEST = "manifest.json"
ASSET_ARCHIVE = "tavern-release.tar.gz"
SKILL_ASSET_MANIFEST = "skill-manifest.json"
SKILL_ASSET_ARCHIVE = "tavern-skill.tar.gz"
UPDATER_FILES = (
    "SKILL.md",
    "agents/openai.yaml",
    "references/AGENTS.md",
    "references/release-format.md",
    "scripts/update.py",
)
OBSOLETE_UPDATER_FILES = (
    "references/conflict-inspection.md",
    "references/agents-block.md",
)
CREATIVE_SKILL_NAMES = (
    "tavern",
    "tavern-world",
    "tavern-story-profile",
    "tavern-continuity",
    "tavern-ops",
    "tavern-world-visuals",
)
SKILL_FILES = (
    "tavern/SKILL.md",
    "tavern/hooks/tavern-liveware-register/HOOK.yaml",
    "tavern/hooks/tavern-liveware-register/handler.py",
    "tavern/hooks/tavern-liveware-register/run.sh",
    "tavern/plugins/tavern-soul-reload/__init__.py",
    "tavern/plugins/tavern-soul-reload/plugin.yaml",
    "tavern/references/conversation-cards.md",
    "tavern/references/shared-contract.md",
    "tavern/scripts/bringup.sh",
    "tavern/scripts/provision.sh",
    "tavern/scripts/runtime.sh",
    "tavern/scripts/tavern_cli.py",
    "tavern-world/SKILL.md",
    "tavern-world/references/card-workflow.md",
    "tavern-world/references/world-workflow.md",
    "tavern-world/references/worldbook-workflow.md",
    "tavern-story-profile/SKILL.md",
    "tavern-story-profile/references/actor-memory.md",
    "tavern-story-profile/scripts/profile_memory.py",
    "tavern-continuity/SKILL.md",
    "tavern-continuity/references/diagnostics.md",
    "tavern-continuity/references/state-repair.md",
    "tavern-continuity/scripts/tavern_repair.py",
    "tavern-ops/SKILL.md",
    "tavern-ops/references/i18n.md",
    "tavern-ops/references/liveware-ops.md",
    "tavern-ops/references/model-config.md",
    "tavern-world-visuals/SKILL.md",
    "tavern-world-visuals/references/theme-schema.md",
    "tavern-world-visuals/scripts/world_theme.py",
)
SYSTEM_SKILL_FILES = (
    "model-api-manager/SKILL.md",
    "model-api-manager/references/hermes-model.md",
    "model-api-manager/references/provider-protocols.md",
    "model-api-manager/references/security-and-rollback.md",
    "model-api-manager/references/tavern-model.md",
    "model-api-manager/scripts/model_api_manager.py",
)
AGENTS_RELEASE_FILE = "references/AGENTS.md"


def download(url, destination):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/octet-stream", "User-Agent": "tavern-updater-bootstrap/1"},
    )
    with urllib.request.urlopen(request, timeout=120) as response, open(destination, "wb") as output:
        shutil.copyfileobj(response, output)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_release(work, release_dir=None):
    if release_dir:
        release_dir = Path(release_dir)
        manifest_path = release_dir / ASSET_MANIFEST
        archive_path = release_dir / ASSET_ARCHIVE
        skill_manifest_path = release_dir / SKILL_ASSET_MANIFEST
        skill_archive_path = release_dir / SKILL_ASSET_ARCHIVE
        if not all(path.is_file() for path in (
                manifest_path, archive_path, skill_manifest_path, skill_archive_path)):
            raise RuntimeError("local release directory is missing required assets")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        skill_manifest = json.loads(skill_manifest_path.read_text(encoding="utf-8"))
        return ({"tag": "v" + str(manifest.get("version") or ""), "url": str(release_dir)},
                manifest, archive_path, skill_manifest, skill_archive_path)

    required_assets = (ASSET_MANIFEST, ASSET_ARCHIVE, SKILL_ASSET_MANIFEST, SKILL_ASSET_ARCHIVE)
    manifest_path = work / ASSET_MANIFEST
    archive_path = work / ASSET_ARCHIVE
    skill_manifest_path = work / SKILL_ASSET_MANIFEST
    skill_archive_path = work / SKILL_ASSET_ARCHIVE
    destinations = {
        ASSET_MANIFEST: manifest_path,
        ASSET_ARCHIVE: archive_path,
        SKILL_ASSET_MANIFEST: skill_manifest_path,
        SKILL_ASSET_ARCHIVE: skill_archive_path,
    }
    for name in required_assets:
        download(f"{RELEASE_BASE_URL.rstrip('/')}/{name}", destinations[name])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    skill_manifest = json.loads(skill_manifest_path.read_text(encoding="utf-8"))
    version = str(manifest.get("version") or "")
    return {
        "tag": "v" + version,
        "url": f"https://github.com/{REPO}/releases/tag/v{version}",
    }, manifest, archive_path, skill_manifest, skill_archive_path


def validate_release(release, manifest, archive_path, skill_manifest, skill_archive_path):
    if (manifest.get("schema") != 4 or manifest.get("scope") != "tavern-system"
            or manifest.get("archive") != ASSET_ARCHIVE):
        raise RuntimeError("unsupported release manifest")
    version = str(manifest.get("version") or "")
    if release.get("tag") != "v" + version:
        raise RuntimeError("release tag and manifest version do not match")
    if sha256_file(archive_path) != manifest.get("sha256"):
        raise RuntimeError("release archive SHA256 mismatch")
    managed = set(manifest.get("managed_files") or [])
    hashes = manifest.get("files") or {}
    required = {"updater/" + name for name in UPDATER_FILES}
    if not required.issubset(managed) or not required.issubset(hashes):
        raise RuntimeError("release does not contain the complete updater skill")
    required_system_skills = {"system-skills/" + name for name in SYSTEM_SKILL_FILES}
    if not required_system_skills.issubset(managed) or not required_system_skills.issubset(hashes):
        raise RuntimeError("release does not contain the complete managed system-skill set")
    if (skill_manifest.get("schema") != 3
            or skill_manifest.get("scope") != "tavern-creative-skills"
            or skill_manifest.get("install_mode") != "exact-directories"
            or tuple(skill_manifest.get("directories") or ()) != CREATIVE_SKILL_NAMES
            or skill_manifest.get("archive") != SKILL_ASSET_ARCHIVE):
        raise RuntimeError("unsupported Tavern skill manifest")
    if str(skill_manifest.get("version") or "") != version:
        raise RuntimeError("runtime and Tavern skill release versions do not match")
    if sha256_file(skill_archive_path) != skill_manifest.get("sha256"):
        raise RuntimeError("Tavern skill archive SHA256 mismatch")
    skill_managed = set(skill_manifest.get("managed_files") or [])
    skill_hashes = skill_manifest.get("files") or {}
    allowed = {"skills/" + name for name in SKILL_FILES}
    if skill_managed != allowed or set(skill_hashes) != allowed:
        raise RuntimeError("Tavern skill release does not match the safe allowlist")


def extract_updater(archive_path, manifest, destination):
    expected = manifest.get("files") or {}
    required = {"updater/" + name: name for name in UPDATER_FILES}
    found = set()
    with tarfile.open(archive_path, "r:gz") as package:
        for member in package.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts:
                raise RuntimeError("release archive contains an unsafe path")
            if path.parts[0] not in ("runtime", "updater", "system-skills", "scripts", "cron"):
                raise RuntimeError("release archive contains an unmanaged top-level path")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("release archive contains an unsupported link or device")
            key = path.as_posix()
            if key not in required:
                continue
            source = package.extractfile(member)
            if source is None:
                raise RuntimeError(f"release updater file is unreadable: {key}")
            data = source.read()
            if sha256_bytes(data) != expected.get(key):
                raise RuntimeError(f"release updater file SHA256 mismatch: {key}")
            target = destination / required[key]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            found.add(key)
    if found != set(required):
        missing = sorted(set(required) - found)
        raise RuntimeError("release archive is missing updater files: " + ", ".join(missing))
    (destination / "scripts/update.py").chmod(0o755)


def backup_existing(data_root, updater_target, agents_path):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = data_root / "tavern-updates/bootstrap-backups" / stamp
    copied = False
    if updater_target.is_dir():
        shutil.copytree(updater_target, backup / "tavern-updater")
        copied = True
    if agents_path.is_file():
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(agents_path, backup / "AGENTS.md")
        copied = True
    return str(backup) if copied else ""


def install_updater(staged, target):
    for name in UPDATER_FILES:
        source = staged / name
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        pending = destination.parent / ("." + destination.name + ".next-" + uuid.uuid4().hex[:8])
        try:
            shutil.copy2(source, pending)
            os.replace(pending, destination)
        finally:
            try:
                pending.unlink()
            except OSError:
                pass
    for name in OBSOLETE_UPDATER_FILES:
        try:
            (target / name).unlink()
        except FileNotFoundError:
            pass


def run_json(command, env):
    result = subprocess.run(command, check=False, text=True, capture_output=True, env=env)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"command failed ({' '.join(command)}): {detail}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("updater command returned no report")
    return json.loads(lines[-1])


def generate_report(update_script, data_root):
    env = os.environ.copy()
    env["TAVERN_DATA_ROOT"] = str(data_root)
    check = run_json([sys.executable, str(update_script), "check"], env)
    review = run_json([sys.executable, str(update_script), "review"], env)
    report = run_json(
        [sys.executable, str(update_script), "report", "--plan", review["plan_id"]],
        env,
    )
    return {"check": check, "report": report}


def apply_reported_plan(update_script, data_root, report):
    if not report.get("ready"):
        raise RuntimeError("review contains conflicts; automatic update was stopped")
    env = os.environ.copy()
    env["TAVERN_DATA_ROOT"] = str(data_root)
    return run_json(
        [sys.executable, str(update_script), "apply", "--plan", report["plan_id"], "--confirm"],
        env,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Install Tavern's verified updater on a legacy Hermes instance and generate an update report."
    )
    default_home = os.environ.get("HERMES_HOME")
    if not default_home:
        default_home = (
            "/opt/data"
            if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir()
            else str(Path.home() / ".hermes")
        )
    parser.add_argument(
        "--data-root",
        default=os.environ.get("TAVERN_DATA_ROOT", default_home),
    )
    parser.add_argument("--apply", action="store_true", help="apply the reviewed update after installation")
    parser.add_argument("--confirm", action="store_true", help="confirm that this command authorizes update installation")
    parser.add_argument("--release-dir", help=argparse.SUPPRESS)
    parser.add_argument("--skip-report", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.apply and not args.confirm:
        raise RuntimeError("--apply requires --confirm")

    data_root = Path(args.data_root).resolve()
    updater_target = data_root / "skills/system/tavern-updater"
    agents_path = data_root / "AGENTS.md"
    agents_before = agents_path.read_bytes() if agents_path.is_file() else None
    with tempfile.TemporaryDirectory(prefix="tavern-updater-bootstrap-") as temp:
        work = Path(temp)
        release, manifest, archive_path, skill_manifest, skill_archive_path = fetch_release(work, args.release_dir)
        validate_release(release, manifest, archive_path, skill_manifest, skill_archive_path)
        staged_updater = work / "updater"
        extract_updater(archive_path, manifest, staged_updater)
        backup = backup_existing(data_root, updater_target, agents_path)
        install_updater(staged_updater, updater_target)
        agents_changed = False

    result = {
        "ok": True,
        "bootstrap_schema": 1,
        "updater_installed": True,
        "tavern_skill_included": True,
        "tavern_skills_included": list(SKILL_FILES),
        "release": release["url"],
        "release_version": manifest["version"],
        "agents_updated": agents_changed,
        "backup": backup,
        "next_step": "Show one update report and wait for approval. All six creative skills, the managed model API system skill, and the complete release-managed AGENTS.md are included in that plan and must not be offered as separate follow-ups.",
    }
    if not args.skip_report:
        result.update(generate_report(updater_target / "scripts/update.py", data_root))
        report = result["report"]
        if args.apply:
            if result["check"].get("installed") == result["check"].get("latest") and not report.get("changes"):
                result["apply"] = {"updated": False, "already_current": True}
            else:
                result["apply"] = apply_reported_plan(
                    updater_target / "scripts/update.py", data_root, report)
            agents_after = agents_path.read_bytes() if agents_path.is_file() else None
            result["agents_updated"] = agents_after != agents_before
            result["next_step"] = "Report the installed version and health result."
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
