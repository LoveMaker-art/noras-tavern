#!/usr/bin/env python3
"""Build the state-free Tavern release assets consumed by tavern-updater."""

import hashlib
import json
from pathlib import Path
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
BACKEND = APP / "backend"
FRONTEND = APP / "frontend"
ASSETS = APP / "assets"
HERMES = ROOT / "integrations/hermes"
SKILLS = ROOT / "skills"
HERMES_AGENTS = HERMES / "AGENTS.md"
LEGACY_BASELINES = ROOT / "legacy-baselines"
UPDATER = SKILLS / "tavern-updater"
MODEL_API_MANAGER = SKILLS / "model-api-manager"
DIST = ROOT / "dist"
STAGE = DIST / "release"
ARCHIVE = DIST / "tavern-release.tar.gz"
SKILL_STAGE = DIST / "skill-release"
SKILL_ARCHIVE = DIST / "tavern-skill.tar.gz"
SKILL_MANIFEST = DIST / "skill-manifest.json"
BOOTSTRAP_SOURCE = ROOT / "bootstrap/tavern_updater_bootstrap.py"
BOOTSTRAP_ASSET = DIST / "tavern-updater-bootstrap.py"
BOOTSTRAP_LAUNCHER_SOURCE = ROOT / "bootstrap/install_tavern_updater.sh"
BOOTSTRAP_LAUNCHER_ASSET = DIST / "install-tavern-updater.sh"
BOOTSTRAP_MANIFEST = DIST / "bootstrap-manifest.json"
LEGACY_BACKEND_FILES = ("actor.py", "actor_self.md", "server.py", "card_import.py")
BACKEND_FILES = (
    "actor.py",
    "background_jobs.py",
    "card_import.py",
    "card_preparation.py",
    "continuity_model.py",
    "env_loader.py",
    "generation_service.py",
    "memory_cache.py",
    "message_segments.py",
    "model_registry.py",
    "personality_service.py",
    "production_views.py",
    "reply_format.py",
    "request_security.py",
    "runtime_cast_service.py",
    "runtime_http.py",
    "server.py",
    "state_store.py",
    "story_ledger.py",
    "story_profile.py",
    "story_state_service.py",
    "tts_service.py",
)
RUNTIME_DATA_FILES = (
    "actor_self.md",
    "qwen_audio_voices.json",
)
STARTER_ASSET_DIR = "fixtures/starter"
LEGACY_FRONTEND_FILES = (
    "actor.html",
    "actor.js",
    "app.js",
    "bridge.js",
    "console.css",
    "i18n.js",
    "index.html",
)
FRONTEND_FILES = (
    "actor.html",
    "actor.js",
    "app.js",
    "bridge.js",
    "console.css",
    "i18n.js",
    "index.html",
    "security.js",
)
LEGACY_BASELINE_RUNTIME_FILES = tuple(LEGACY_BACKEND_FILES) + tuple(
    f"web/{name}" for name in LEGACY_FRONTEND_FILES
) + (
    ".tavern-release-version",
)
CREATIVE_SKILL_NAMES = (
    "tavern",
    "tavern-world",
    "tavern-story-profile",
    "tavern-continuity",
    "tavern-ops",
    "tavern-world-visuals",
)
SYSTEM_SKILL_NAMES = (
    "model-api-manager",
)


def copy(source, destination):
    if source.is_dir():
        shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.bak*", "*.before-*", "*.log"))
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def main():
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    shutil.rmtree(DIST, ignore_errors=True)
    (STAGE / "runtime").mkdir(parents=True)
    (STAGE / "updater").mkdir(parents=True)
    for name in BACKEND_FILES:
        copy(BACKEND / name, STAGE / "runtime" / name)
    for name in RUNTIME_DATA_FILES:
        copy(ASSETS / name, STAGE / "runtime" / name)
    copy(
        ASSETS / STARTER_ASSET_DIR,
        STAGE / "runtime/assets" / STARTER_ASSET_DIR,
    )
    for name in FRONTEND_FILES:
        copy(FRONTEND / name, STAGE / "runtime/web" / name)
    (STAGE / "runtime/.tavern-release-version").write_text(version + "\n", encoding="utf-8")
    copy(UPDATER / "SKILL.md", STAGE / "updater/SKILL.md")
    copy(UPDATER / "scripts", STAGE / "updater/scripts")
    copy(UPDATER / "references", STAGE / "updater/references")
    copy(HERMES_AGENTS, STAGE / "updater/references/AGENTS.md")
    if (UPDATER / "agents").is_dir():
        copy(UPDATER / "agents", STAGE / "updater/agents")
    copy(MODEL_API_MANAGER, STAGE / "system-skills/model-api-manager")
    files = {
        path.relative_to(STAGE).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(STAGE.rglob("*"))
        if path.is_file()
    }
    with tarfile.open(ARCHIVE, "w:gz", format=tarfile.PAX_FORMAT) as package:
        package.add(STAGE / "runtime", arcname="runtime")
        package.add(STAGE / "updater", arcname="updater")
        package.add(STAGE / "system-skills", arcname="system-skills")
    digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    manifest = {
        "schema": 4,
        "scope": "tavern-system",
        "version": version,
        "archive": ARCHIVE.name,
        "sha256": digest,
        "managed_files": sorted(files),
        "files": files,
    }
    (DIST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    (SKILL_STAGE / "skills").mkdir(parents=True)
    for name in CREATIVE_SKILL_NAMES:
        copy(SKILLS / name, SKILL_STAGE / "skills" / name)
    skill_files = {
        path.relative_to(SKILL_STAGE).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(SKILL_STAGE.rglob("*"))
        if path.is_file()
    }
    with tarfile.open(SKILL_ARCHIVE, "w:gz", format=tarfile.PAX_FORMAT) as package:
        package.add(SKILL_STAGE / "skills", arcname="skills")
    skill_manifest = {
        "schema": 3,
        "scope": "tavern-creative-skills",
        "install_mode": "exact-directories",
        "directories": list(CREATIVE_SKILL_NAMES),
        "version": version,
        "archive": SKILL_ARCHIVE.name,
        "sha256": hashlib.sha256(SKILL_ARCHIVE.read_bytes()).hexdigest(),
        "managed_files": sorted(skill_files),
        "files": skill_files,
    }
    SKILL_MANIFEST.write_text(
        json.dumps(skill_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    copy(BOOTSTRAP_SOURCE, BOOTSTRAP_ASSET)
    copy(BOOTSTRAP_LAUNCHER_SOURCE, BOOTSTRAP_LAUNCHER_ASSET)
    bootstrap_files = {
        BOOTSTRAP_ASSET.name: hashlib.sha256(BOOTSTRAP_ASSET.read_bytes()).hexdigest(),
        BOOTSTRAP_LAUNCHER_ASSET.name: hashlib.sha256(BOOTSTRAP_LAUNCHER_ASSET.read_bytes()).hexdigest(),
    }
    bootstrap_manifest = {
        "schema": 1,
        "scope": "tavern-updater-bootstrap",
        "version": version,
        "file": BOOTSTRAP_ASSET.name,
        "sha256": bootstrap_files[BOOTSTRAP_ASSET.name],
        "files": bootstrap_files,
    }
    BOOTSTRAP_MANIFEST.write_text(
        json.dumps(bootstrap_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    baselines = []
    if LEGACY_BASELINES.is_dir():
        for baseline_root in sorted(path for path in LEGACY_BASELINES.iterdir() if path.is_dir()):
            baseline_version = baseline_root.name.removeprefix("v")
            baseline_source = baseline_root / "runtime"
            actual_source_files = {
                path.relative_to(baseline_source).as_posix()
                for path in baseline_source.rglob("*")
                if path.is_file()
            }
            if actual_source_files != set(LEGACY_BASELINE_RUNTIME_FILES):
                raise RuntimeError(
                    f"legacy baseline {baseline_version} does not match the runtime allowlist"
                )
            marker = (baseline_source / ".tavern-release-version").read_text(encoding="utf-8").strip()
            if marker != baseline_version:
                raise RuntimeError(f"legacy baseline {baseline_version} has a mismatched version marker")
            baseline_stage = DIST / f"baseline-v{baseline_version}-release"
            for name in LEGACY_BASELINE_RUNTIME_FILES:
                copy(baseline_source / name, baseline_stage / "runtime" / name)
            baseline_files = {
                path.relative_to(baseline_stage).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(baseline_stage.rglob("*"))
                if path.is_file()
            }
            baseline_archive = DIST / f"tavern-baseline-v{baseline_version}.tar.gz"
            with tarfile.open(baseline_archive, "w:gz", format=tarfile.PAX_FORMAT) as package:
                package.add(baseline_stage / "runtime", arcname="runtime")
            baseline_manifest = {
                "schema": 1,
                "scope": "tavern-historical-baseline",
                "version": baseline_version,
                "archive": baseline_archive.name,
                "sha256": hashlib.sha256(baseline_archive.read_bytes()).hexdigest(),
                "managed_files": sorted(baseline_files),
                "files": baseline_files,
            }
            baseline_manifest_path = DIST / f"baseline-v{baseline_version}-manifest.json"
            baseline_manifest_path.write_text(
                json.dumps(baseline_manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            baselines.append(baseline_manifest)
            shutil.rmtree(baseline_stage)
    shutil.rmtree(STAGE)
    shutil.rmtree(SKILL_STAGE)
    print(json.dumps({
        "release": manifest,
        "skill": skill_manifest,
        "bootstrap": bootstrap_manifest,
        "baselines": baselines,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
