#!/usr/bin/env python3
"""Reviewable, state-preserving Tavern release updater."""

import argparse
from contextlib import contextmanager
import fcntl
import fnmatch
from functools import wraps
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

REPO = os.environ.get("TAVERN_UPDATE_REPO", "LoveMaker-art/noras-tavern")
API_OVERRIDE = os.environ.get("TAVERN_UPDATE_API")
TAG_API_OVERRIDE = os.environ.get("TAVERN_UPDATE_TAG_API")
API = API_OVERRIDE or f"https://api.github.com/repos/{REPO}/releases/latest"
TAG_API = TAG_API_OVERRIDE or f"https://api.github.com/repos/{REPO}/releases/tags/v{{version}}"
RELEASES_URL = f"https://github.com/{REPO}/releases"
LATEST_DOWNLOAD_URL = f"{RELEASES_URL}/latest/download"
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (
    "/opt/data" if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir()
    else Path.home() / ".hermes"
)).expanduser().resolve()
DATA = Path(os.environ.get("TAVERN_DATA_ROOT", HERMES_HOME)).expanduser().resolve()
TAVERN_STATE_DIR = Path(
    os.environ.get("TAVERN_STATE_DIR", DATA / "tavern-state")
).expanduser().resolve()
CUSTOM_STARTER_DIR = TAVERN_STATE_DIR / "starter"
HERMES_SCRIPTS_DIR = Path(
    os.environ.get("TAVERN_UPDATE_SCRIPTS_DIR", DATA / "scripts")
).expanduser().resolve()
HERMES_CRON_DIR = Path(
    os.environ.get("TAVERN_UPDATE_CRON_DIR", DATA / "cron")
).expanduser().resolve()
HERMES_CRON_JOBS_FILE = HERMES_CRON_DIR / "jobs.json"
PYTHON = os.environ.get("TAVERN_PYTHON", sys.executable)
HERMES = os.environ.get("TAVERN_HERMES", shutil.which("hermes") or "hermes")
HEALTH_URL = os.environ.get("TAVERN_HEALTH_URL", "http://127.0.0.1:8799/api/health")
SKIP_SERVICE = os.environ.get("TAVERN_SKIP_SERVICE") == "1"
TARGETS = {
    "runtime": DATA / "apps/tavern-runtime",
    "skills": DATA / "skills/creative",
    "system-skills": DATA / "skills/system",
    "updater": DATA / "skills/system/tavern-updater",
    "scripts": HERMES_SCRIPTS_DIR,
    "cron": HERMES_CRON_DIR,
}
AGENTS_PATH = DATA / "AGENTS.md"
UPDATE_ROOT = DATA / "tavern-updates"
BACKUPS = UPDATE_ROOT / "backups"
PLANS = UPDATE_ROOT / "plans"
BASELINE = UPDATE_ROOT / "baseline"
STATE = UPDATE_ROOT / "state.json"
LOCK = UPDATE_ROOT / "update.lock"
BASELINE_META = ".baseline.json"
ASSET_MANIFEST = "manifest.json"
ASSET_ARCHIVE = "tavern-release.tar.gz"
SKILL_ASSET_MANIFEST = "skill-manifest.json"
SKILL_ASSET_ARCHIVE = "tavern-skill.tar.gz"
VERSION_RE = re.compile(r"^version:\s*['\"]?([^'\"\s]+)", re.MULTILINE)
LOCAL_ASSET_QUERY_RE = re.compile(
    r"(?P<prefix>\b(?:src|href)=[\"'](?:\./)?[A-Za-z0-9_./-]+\.(?:js|css))\?[^\"']*",
    re.IGNORECASE,
)
IGNORED = ("__pycache__", "*.pyc", "*.log", "*.bak*", "*.before-*", ".DS_Store")
PROTECTED = (".env", ".env.*", "*.db", "*.sqlite", "*.sqlite3", "sessions", "credentials", "backups")
OBSOLETE_UPDATER_FILES = (
    "references/conflict-inspection.md",
    "references/agents-block.md",
)
# Exact fingerprints of transitional runtime builds that were deployed to some
# instances before the equivalent implementation was published as a Release.
# Only these known bytes may be replaced automatically; unknown local edits must
# remain available only for identifying legacy starter customizations.
COMPATIBILITY_REPLACEMENTS = {
    "runtime/server.py": {
        "c0ec128edbba6fb6e9ddd16a30c48ff68d3beba7a2ba0b87de6e74e1859ea79b": {
            "min_target": "1.21.0",
            "reason": "story-state-watch-policy",
        },
        "21deaa1e65bf5836827327b1857f8d72f3f5e12473e40131dc872cd94858cb46": {
            "min_target": "1.21.3",
            "reason": "world-theme-preview",
        },
    },
    "runtime/web/app.js": {
        "38ba6dc28b092b92d88367cfc35f5b69e8417be662a80b794263585a78cf7165": {
            "min_target": "1.21.0",
            "reason": "state-sync-bounded-polling",
        },
    },
}
HISTORICAL_SKILL_FILES = {
    "scripts/install.sh",
    "scripts/make_test_card.py",
    "scripts/smoke.py",
}
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
HERMES_SCRIPT_FILES = {
    "nora-tavern-update-check.sh",
    "nora-tavern-card-send.py",
}
HERMES_CRON_FILES = {
    "nora-tavern-update-check.json",
}
OBSOLETE_CREATIVE_SKILL_NAMES = (
    "tavern-cards",
    "tavern-worldbooks",
)
SAFE_CREATIVE_SKILL_NAMES = CREATIVE_SKILL_NAMES + OBSOLETE_CREATIVE_SKILL_NAMES
CREATIVE_SKILL_FILES = {
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
}
SYSTEM_SKILL_FILES = {
    "model-api-manager/SKILL.md",
    "model-api-manager/references/hermes-model.md",
    "model-api-manager/references/provider-protocols.md",
    "model-api-manager/references/security-and-rollback.md",
    "model-api-manager/references/tavern-model.md",
    "model-api-manager/scripts/model_api_manager.py",
}
LEGACY_SPLIT_SKILL_FILES = {
    "tavern-cards/SKILL.md",
    "tavern-cards/references/card-authoring.md",
    "tavern-cards/references/field-mapping.md",
    "tavern-cards/references/card-localization.md",
    "tavern-cards/references/card-workflow.md",
    "tavern-worldbooks/SKILL.md",
    "tavern-worldbooks/references/lore-audit.md",
    "tavern-worldbooks/references/worldbook-authoring.md",
}
LEGACY_SKILL_FILES = {
    "SKILL.md",
    "references/actor-memory.md",
    "references/card-authoring.md",
    "references/card-localization.md",
    "references/card-workflow.md",
    "references/content-modeling.md",
    "references/diagnostics.md",
    "references/event-driven-update.md",
    "references/i18n.md",
    "references/liveware-ops.md",
    "references/lore-audit.md",
    "references/model-config.md",
    "references/recommendation-planning.md",
    "references/world-expansion.md",
    "references/world-rebuild.md",
    "references/worldbook-authoring.md",
    "scripts/bringup.sh",
    "scripts/provision.sh",
    "scripts/tavern_cli.py",
}
ALLOWED_OBSOLETE = {
    "skills/tavern/" + name
    for name in (LEGACY_SKILL_FILES - {"SKILL.md", "scripts/bringup.sh", "scripts/provision.sh", "scripts/tavern_cli.py"})
} | {
    "skills/tavern/scripts/install.sh",
    "skills/tavern/scripts/make_test_card.py",
    "skills/tavern/scripts/smoke.py",
}
AGENTS_RELEASE_FILE = "references/AGENTS.md"
LEGACY_RUNTIME_FILES = {
    ".tavern-release-version",
    "actor.py",
    "actor_self.md",
    "card_import.py",
    "server.py",
    "web/actor.html",
    "web/actor.js",
    "web/app.js",
    "web/bridge.js",
    "web/console.css",
    "web/i18n.js",
    "web/index.html",
}
EXPANDED_RUNTIME_FILES = LEGACY_RUNTIME_FILES | {
    "background_jobs.py",
    "continuity_model.py",
    "memory_cache.py",
    "model_registry.py",
    "production_views.py",
    "request_security.py",
    "runtime_http.py",
    "state_store.py",
    "story_ledger.py",
    "story_profile.py",
    "tts_service.py",
    "web/security.js",
}
MODULAR_RUNTIME_FILES = EXPANDED_RUNTIME_FILES | {
    "generation_service.py",
    "message_segments.py",
    "reply_format.py",
    "runtime_cast_service.py",
    "story_state_service.py",
    "turn_plan_service.py",
}
SINGLE_PASS_RUNTIME_FILES = MODULAR_RUNTIME_FILES - {"turn_plan_service.py"}
VOICE_CATALOG_RUNTIME_FILES = SINGLE_PASS_RUNTIME_FILES | {"qwen_audio_voices.json"}
CARD_PREPARATION_RUNTIME_FILES = VOICE_CATALOG_RUNTIME_FILES | {"card_preparation.py"}
PERSONALITY_RUNTIME_FILES = CARD_PREPARATION_RUNTIME_FILES | {"personality_service.py"}
STARTER_ASSET_FILES = {
    "assets/fixtures/starter/index.json",
    "assets/fixtures/starter/audrey-barista.png",
    "assets/fixtures/starter/doria-android.png",
    "assets/fixtures/starter/ichitora-detective.png",
    "assets/fixtures/starter/kuchanan-explorer.png",
    "assets/fixtures/starter/librarian.png",
    "assets/fixtures/starter/medieval-knight.png",
    "assets/fixtures/starter/reiko-samurai.png",
    "assets/fixtures/starter/yan-buddy.png",
}
STARTER_ASSET_RUNTIME_FILES = CARD_PREPARATION_RUNTIME_FILES | STARTER_ASSET_FILES
PRE_RETRY_RUNTIME_FILES = PERSONALITY_RUNTIME_FILES | STARTER_ASSET_FILES
ENV_LOADER_RUNTIME_FILES = PRE_RETRY_RUNTIME_FILES | {"env_loader.py"}
RUNTIME_FILES = ENV_LOADER_RUNTIME_FILES | {"model_retry.py"}
OBSOLETE_MANAGED_FILES = {
    "runtime/turn_plan_service.py",
}
ALLOWED_OBSOLETE |= OBSOLETE_MANAGED_FILES
EXPANDED_RUNTIME_VERSION = (1, 21, 0)
MODULAR_RUNTIME_VERSION = (1, 22, 0)
SINGLE_PASS_RUNTIME_VERSION = (1, 23, 6)
VOICE_CATALOG_RUNTIME_VERSION = (1, 23, 9)
CARD_PREPARATION_RUNTIME_VERSION = (1, 23, 13)
PERSONALITY_RUNTIME_VERSION = (1, 24, 0)
STARTER_ASSET_RUNTIME_VERSION = (1, 23, 18)
RETRY_POLICY_RUNTIME_VERSION = (1, 24, 6)
ENV_LOADER_RUNTIME_VERSION = (1, 24, 5)
ALLOWED_MANAGED = {
    "runtime": RUNTIME_FILES | {"turn_plan_service.py"},
    "updater": {
        "SKILL.md",
        "agents/openai.yaml",
        AGENTS_RELEASE_FILE,
        "references/agents-block.md",
        "references/release-format.md",
        "scripts/update.py",
    },
    "skills": CREATIVE_SKILL_FILES,
    "system-skills": SYSTEM_SKILL_FILES,
    "scripts": HERMES_SCRIPT_FILES,
    "cron": HERMES_CRON_FILES,
}


def version_key(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", str(value or ""))
    if not match:
        raise RuntimeError(f"unsupported semantic version: {value}")
    return tuple(int(part) for part in match.groups())


def runtime_files_for_version(version):
    key = version_key(version)
    if key >= RETRY_POLICY_RUNTIME_VERSION:
        return RUNTIME_FILES
    if key >= ENV_LOADER_RUNTIME_VERSION:
        return ENV_LOADER_RUNTIME_FILES
    if key >= PERSONALITY_RUNTIME_VERSION:
        return PRE_RETRY_RUNTIME_FILES
    if key >= STARTER_ASSET_RUNTIME_VERSION:
        return STARTER_ASSET_RUNTIME_FILES
    if key >= CARD_PREPARATION_RUNTIME_VERSION:
        return CARD_PREPARATION_RUNTIME_FILES
    if key >= VOICE_CATALOG_RUNTIME_VERSION:
        return VOICE_CATALOG_RUNTIME_FILES
    if key >= SINGLE_PASS_RUNTIME_VERSION:
        return SINGLE_PASS_RUNTIME_FILES
    if key >= MODULAR_RUNTIME_VERSION:
        return MODULAR_RUNTIME_FILES
    if key >= EXPANDED_RUNTIME_VERSION:
        return EXPANDED_RUNTIME_FILES
    return LEGACY_RUNTIME_FILES


def request_json(url):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "tavern-updater/2"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def download(url, destination):
    req = urllib.request.Request(url, headers={"Accept": "application/octet-stream", "User-Agent": "tavern-updater/2"})
    with urllib.request.urlopen(req, timeout=120) as response, open(destination, "wb") as output:
        shutil.copyfileobj(response, output)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def local_version():
    marker = TARGETS["runtime"] / ".tavern-release-version"
    try:
        value = marker.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    try:
        match = VERSION_RE.search((TARGETS["skills"] / "tavern/SKILL.md").read_text(encoding="utf-8"))
        return match.group(1) if match else "0.0.0"
    except OSError:
        return "0.0.0"


def local_skill_version():
    try:
        match = VERSION_RE.search((TARGETS["skills"] / "tavern/SKILL.md").read_text(encoding="utf-8"))
        return match.group(1) if match else "0.0.0"
    except OSError:
        return "0.0.0"


def local_skill_versions():
    versions = {}
    for name in CREATIVE_SKILL_NAMES:
        path = TARGETS["skills"] / name / "SKILL.md"
        try:
            match = VERSION_RE.search(path.read_text(encoding="utf-8"))
            versions[name] = match.group(1) if match else "0.0.0"
        except OSError:
            versions[name] = "missing"
    return versions


def release_from_api(url):
    release = request_json(url)
    if release.get("draft") or release.get("prerelease"):
        raise RuntimeError("latest GitHub release is not stable")
    assets = {item.get("name"): item.get("browser_download_url") for item in release.get("assets") or []}
    required = (ASSET_MANIFEST, ASSET_ARCHIVE, SKILL_ASSET_MANIFEST, SKILL_ASSET_ARCHIVE)
    missing = [name for name in required if not assets.get(name)]
    if missing:
        raise RuntimeError("release is missing required assets: " + ", ".join(missing))
    return {"tag": release.get("tag_name"), "assets": assets, "url": release.get("html_url")}


def release_from_download(version=None):
    if version is None:
        manifest = request_json(f"{LATEST_DOWNLOAD_URL}/{ASSET_MANIFEST}")
        version = str(manifest.get("version") or "")
    version_key(version)
    tag = "v" + version
    base = f"{RELEASES_URL}/download/{tag}"
    names = [
        ASSET_MANIFEST,
        ASSET_ARCHIVE,
        SKILL_ASSET_MANIFEST,
        SKILL_ASSET_ARCHIVE,
    ]
    for baseline_version in ("1.14.12", "1.21.5"):
        names.extend((
            f"baseline-v{baseline_version}-manifest.json",
            f"tavern-baseline-v{baseline_version}.tar.gz",
        ))
    return {
        "tag": tag,
        "assets": {name: f"{base}/{name}" for name in names},
        "url": f"{RELEASES_URL}/tag/{tag}",
    }


def latest_release():
    return release_from_api(API) if API_OVERRIDE else release_from_download()


def tagged_release(version):
    if TAG_API_OVERRIDE:
        return release_from_api(TAG_API.format(version=version))
    return release_from_download(version)


def canonical_skill_managed(skill_manifest):
    managed = [str(path) for path in (skill_manifest.get("managed_files") or [])]
    if skill_manifest.get("schema") == 1:
        return ["skills/tavern/" + path.partition("/")[2] for path in managed]
    return managed


def validate_split_skill_managed(skill_managed, historical=False):
    actual = set(skill_managed)
    allowed_files = CREATIVE_SKILL_FILES | (LEGACY_SPLIT_SKILL_FILES if historical else set())
    allowed = {"skills/" + name for name in allowed_files}
    if historical:
        directories = {
            path.split("/", 2)[1]
            for path in actual
            if path.startswith("skills/") and path.count("/") >= 2
        }
        required = {f"skills/{name}/SKILL.md" for name in directories}
        if (
            "tavern" not in directories
            or not directories.issubset(set(SAFE_CREATIVE_SKILL_NAMES))
            or not required.issubset(actual)
            or not actual.issubset(allowed)
        ):
            raise RuntimeError("historical Tavern creative-skill release does not match the safe allowlist")
    elif actual != allowed:
        raise RuntimeError("Tavern creative-skill release does not match the safe allowlist")


def skill_obsolete_files(skill_manifest):
    return [str(path) for path in (skill_manifest.get("obsolete_files") or [])]


def release_material(work, release=None, historical=False):
    work.mkdir(parents=True, exist_ok=True)
    release = release or latest_release()
    manifest_path = work / ASSET_MANIFEST
    archive_path = work / ASSET_ARCHIVE
    skill_manifest_path = work / SKILL_ASSET_MANIFEST
    skill_archive_path = work / SKILL_ASSET_ARCHIVE
    download(release["assets"][ASSET_MANIFEST], manifest_path)
    download(release["assets"][ASSET_ARCHIVE], archive_path)
    download(release["assets"][SKILL_ASSET_MANIFEST], skill_manifest_path)
    download(release["assets"][SKILL_ASSET_ARCHIVE], skill_archive_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    skill_manifest = json.loads(skill_manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema") != 4 or manifest.get("scope") != "tavern-system"
            or manifest.get("archive") != ASSET_ARCHIVE):
        raise RuntimeError("unsupported release manifest")
    version = str(manifest.get("version") or "")
    if release.get("tag") != "v" + version:
        raise RuntimeError("release tag and manifest version do not match")
    digest = sha256_file(archive_path)
    if digest != manifest.get("sha256"):
        raise RuntimeError("release archive SHA256 mismatch")
    managed = manifest.get("managed_files") or []
    for path in managed:
        area, separator, name = str(path).partition("/")
        if not separator or name not in ALLOWED_MANAGED.get(area, set()):
            raise RuntimeError(f"release attempts to manage a forbidden path: {path}")
    release_runtime_files = runtime_files_for_version(version)
    required_runtime = {f"runtime/{name}" for name in release_runtime_files}
    if not required_runtime.issubset(set(managed)):
        raise RuntimeError("release is missing required Tavern system files")
    required_system_skills = {f"system-skills/{name}" for name in SYSTEM_SKILL_FILES}
    if not historical and not required_system_skills.issubset(set(managed)):
        raise RuntimeError("release is missing the managed Tavern system skills")
    if not historical and "updater/" + AGENTS_RELEASE_FILE not in set(managed):
        raise RuntimeError("release is missing the managed AGENTS.md")
    skill_schema = skill_manifest.get("schema")
    skill_scope = skill_manifest.get("scope")
    if (skill_schema, skill_scope) not in (
            (1, "tavern-creative-skill"),
            (2, "tavern-creative-skills"),
            (3, "tavern-creative-skills"),
    ) or skill_manifest.get("archive") != SKILL_ASSET_ARCHIVE:
        raise RuntimeError("unsupported Tavern skill manifest")
    if str(skill_manifest.get("version") or "") != version:
        raise RuntimeError("runtime and Tavern skill release versions do not match")
    if sha256_file(skill_archive_path) != skill_manifest.get("sha256"):
        raise RuntimeError("Tavern skill archive SHA256 mismatch")
    skill_managed = skill_manifest.get("managed_files") or []
    if skill_schema == 1:
        allowed_skill = LEGACY_SKILL_FILES | (HISTORICAL_SKILL_FILES if historical else set())
        for path in skill_managed:
            area, separator, name = str(path).partition("/")
            if area != "skill" or not separator or name not in allowed_skill:
                raise RuntimeError(f"Tavern skill release attempts to manage a forbidden path: {path}")
        if "skill/SKILL.md" not in skill_managed:
            raise RuntimeError("Tavern skill release is missing SKILL.md")
    else:
        validate_split_skill_managed(skill_managed, historical=historical)
        if skill_schema == 3:
            directories = tuple(skill_manifest.get("directories") or ())
            safe_directories = (
                bool(directories)
                and len(directories) == len(set(directories))
                and "tavern" in directories
                and set(directories).issubset(set(SAFE_CREATIVE_SKILL_NAMES))
            )
            if (
                skill_manifest.get("install_mode") != "exact-directories"
                or (historical and not safe_directories)
                or (not historical and directories != CREATIVE_SKILL_NAMES)
            ):
                raise RuntimeError("Tavern creative-skill release has an unsafe install policy")
            if skill_manifest.get("obsolete_files"):
                raise RuntimeError("exact-directory skill releases must not list obsolete files")
        else:
            obsolete = set(skill_obsolete_files(skill_manifest))
            if not obsolete.issubset(ALLOWED_OBSOLETE) or obsolete & set(skill_managed):
                raise RuntimeError("Tavern creative-skill release has an unsafe retirement list")
    return release, manifest, archive_path, skill_manifest, skill_archive_path


def historical_system_material(work, release):
    """Verify an installed release without coupling it to today's skill layout."""
    work.mkdir(parents=True, exist_ok=True)
    manifest_path = work / ASSET_MANIFEST
    archive_path = work / ASSET_ARCHIVE
    download(release["assets"][ASSET_MANIFEST], manifest_path)
    download(release["assets"][ASSET_ARCHIVE], archive_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schema") != 4
        or manifest.get("scope") != "tavern-system"
        or manifest.get("archive") != ASSET_ARCHIVE
    ):
        raise RuntimeError("unsupported historical release manifest")
    version = str(manifest.get("version") or "")
    if release.get("tag") != "v" + version:
        raise RuntimeError("historical release tag and manifest version do not match")
    if sha256_file(archive_path) != manifest.get("sha256"):
        raise RuntimeError("historical release archive SHA256 mismatch")
    managed = [str(path) for path in (manifest.get("managed_files") or [])]
    for path in managed:
        area, separator, name = path.partition("/")
        if not separator or name not in ALLOWED_MANAGED.get(area, set()):
            raise RuntimeError(f"historical release attempts to manage a forbidden path: {path}")
    expected_runtime = {f"runtime/{name}" for name in runtime_files_for_version(version)}
    actual_runtime = {path for path in managed if path.startswith("runtime/")}
    if actual_runtime != expected_runtime:
        raise RuntimeError("historical release runtime does not match its version allowlist")
    return manifest, archive_path


def safe_extract(archive, destination, manifest):
    destination = destination.resolve()
    allowed_areas = {"runtime", "updater", "system-skills", "scripts", "cron"}
    with tarfile.open(archive, "r:gz") as package:
        for member in package.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] not in allowed_areas:
                raise RuntimeError("release archive contains an unmanaged top-level path")
            target = (destination / member.name).resolve()
            if destination not in target.parents and target != destination:
                raise RuntimeError("release archive contains an unsafe path")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("release archive contains an unsupported link or device")
        package.extractall(destination)
    required = (destination / "runtime/server.py", destination / "runtime/actor.py",
                destination / "runtime/actor_self.md",
                destination / "runtime/.tavern-release-version", destination / "updater/SKILL.md")
    for path in required:
        if not path.is_file():
            raise RuntimeError(f"release archive is missing {path.relative_to(destination)}")
    expected = manifest.get("files") or {}
    managed = manifest.get("managed_files") or []
    actual = tree_hashes(destination)
    if actual != expected or sorted(expected) != sorted(managed):
        raise RuntimeError("release file manifest mismatch")


def safe_extract_skill(archive, destination, manifest):
    destination = destination.resolve()
    schema = manifest.get("schema")
    top = "skill" if schema == 1 else "skills"
    with tempfile.TemporaryDirectory(prefix="tavern-skill-extract-") as temp:
        raw = Path(temp).resolve()
        with tarfile.open(archive, "r:gz") as package:
            for member in package.getmembers():
                parts = Path(member.name).parts
                if not parts or parts[0] != top:
                    raise RuntimeError("Tavern skill archive contains an unmanaged top-level path")
                target = (raw / member.name).resolve()
                if raw not in target.parents and target != raw:
                    raise RuntimeError("Tavern skill archive contains an unsafe path")
                if member.issym() or member.islnk() or member.isdev():
                    raise RuntimeError("Tavern skill archive contains an unsupported link or device")
            package.extractall(raw)
        expected = manifest.get("files") or {}
        managed = manifest.get("managed_files") or []
        actual = {f"{top}/{name}": digest for name, digest in tree_hashes(raw / top).items()}
        if actual != expected or sorted(expected) != sorted(managed):
            raise RuntimeError("Tavern skill file manifest mismatch")
        if schema == 1:
            shutil.copytree(raw / "skill", destination / "skills/tavern", dirs_exist_ok=True)
        else:
            shutil.copytree(raw / "skills", destination / "skills", dirs_exist_ok=True)


def bundled_baseline(work, release, version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(version)):
        raise RuntimeError("installed version cannot select a bundled historical baseline")
    work.mkdir(parents=True, exist_ok=True)
    manifest_name = f"baseline-v{version}-manifest.json"
    archive_name = f"tavern-baseline-v{version}.tar.gz"
    assets = release.get("assets") or {}
    if not assets.get(manifest_name) or not assets.get(archive_name):
        raise RuntimeError(f"latest release does not include a verified baseline for {version}")
    manifest_path = work / manifest_name
    archive_path = work / archive_name
    download(assets[manifest_name], manifest_path)
    download(assets[archive_name], archive_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("schema") != 1
            or manifest.get("scope") != "tavern-historical-baseline"
            or manifest.get("version") != version
            or manifest.get("archive") != archive_name):
        raise RuntimeError("unsupported bundled historical baseline manifest")
    if sha256_file(archive_path) != manifest.get("sha256"):
        raise RuntimeError("bundled historical baseline archive SHA256 mismatch")
    managed = [str(path) for path in (manifest.get("managed_files") or [])]
    baseline_files = runtime_files_for_version(version)
    required = {f"runtime/{name}" for name in baseline_files}
    if set(managed) != required or set(manifest.get("files") or {}) != required:
        raise RuntimeError("bundled historical baseline does not match the runtime allowlist")
    unpacked = work / "unpacked"
    unpacked.mkdir(parents=True)
    with tarfile.open(archive_path, "r:gz") as package:
        for member in package.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] != "runtime":
                raise RuntimeError("historical baseline contains an unmanaged top-level path")
            target = (unpacked / member.name).resolve()
            if unpacked.resolve() not in target.parents and target != unpacked.resolve():
                raise RuntimeError("historical baseline contains an unsafe path")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("historical baseline contains an unsupported link or device")
        package.extractall(unpacked)
    actual = {f"runtime/{name}": digest for name, digest in tree_hashes(unpacked / "runtime").items()}
    if actual != manifest.get("files"):
        raise RuntimeError("bundled historical baseline file manifest mismatch")
    marker = (unpacked / "runtime/.tavern-release-version").read_text(encoding="utf-8").strip()
    if marker != version:
        raise RuntimeError("bundled historical baseline version marker mismatch")
    return unpacked


def ignored(path):
    return any(fnmatch.fnmatch(part, pattern) for part in path.parts for pattern in IGNORED)


def protected(path):
    return any(fnmatch.fnmatch(part, pattern) for part in path.parts for pattern in PROTECTED)


def tree_files(root):
    if not root.is_dir():
        return {}
    return {path.relative_to(root).as_posix(): path for path in root.rglob("*") if path.is_file() and not ignored(path.relative_to(root))}


def tree_hashes(root):
    return {name: sha256_file(path) for name, path in sorted(tree_files(root).items())}


def official_skill_hashes(root=None, include_obsolete=False):
    root = root or TARGETS["skills"]
    names = SAFE_CREATIVE_SKILL_NAMES if include_obsolete else CREATIVE_SKILL_NAMES
    return {
        name: tree_hashes(root / name)
        for name in names
    }


def official_system_skill_hashes(root=None):
    root = root or TARGETS["system-skills"]
    return {
        name: tree_hashes(root / name)
        for name in SYSTEM_SKILL_NAMES
    }


def split_managed(managed_files):
    grouped = {area: set() for area in TARGETS}
    for path in managed_files:
        area, separator, name = str(path).partition("/")
        if not separator or name not in ALLOWED_MANAGED.get(area, set()):
            raise RuntimeError(f"release manages an unsupported path: {path}")
        grouped[area].add(name)
    return grouped


def managed_fingerprint(managed_files, obsolete_files=None, include_agents=True):
    payload = {}
    for area, names in split_managed(managed_files).items():
        for name in sorted(names):
            path = TARGETS[area] / name
            payload[f"{area}/{name}"] = sha256_file(path) if path.is_file() else None
    for key in sorted(set(obsolete_files or [])):
        if key not in ALLOWED_OBSOLETE:
            raise RuntimeError(f"release retires an unsupported path: {key}")
        area, _, name = key.partition("/")
        path = TARGETS[area] / name
        payload[key] = sha256_file(path) if path.is_file() else None
    payload["skills/exact-directories"] = official_skill_hashes(include_obsolete=True)
    payload["system-skills/exact-directories"] = official_system_skill_hashes()
    if include_agents:
        payload["agents/AGENTS.md"] = sha256_file(AGENTS_PATH) if AGENTS_PATH.is_file() else None
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def category(area, name):
    if area in ("skills", "system-skills"):
        return "skill"
    if area == "updater":
        return "updater"
    if area in ("scripts", "cron"):
        return "integration"
    suffix = Path(name).suffix.lower()
    if name.startswith("web/") or suffix in (".html", ".css", ".js"):
        return "frontend"
    return "backend"


def binary(path):
    try:
        return b"\0" in path.read_bytes()[:8192]
    except OSError:
        return False


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def atomic_write_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.parent / ("." + path.name + ".next-" + uuid.uuid4().hex[:8])
    try:
        pending.write_text(content, encoding="utf-8")
        os.replace(pending, path)
    finally:
        try:
            pending.unlink()
        except OSError:
            pass


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _next_update_check_run_at(now=None):
    now = now or datetime.now(timezone.utc)
    candidate = now.replace(hour=1, minute=0, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.isoformat()


def _load_cron_jobs_document():
    if not HERMES_CRON_JOBS_FILE.is_file():
        return {"jobs": []}
    try:
        data = json.loads(HERMES_CRON_JOBS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Hermes cron database is invalid JSON: {HERMES_CRON_JOBS_FILE}") from exc
    if isinstance(data, list):
        return {"jobs": data}
    if isinstance(data, dict) and isinstance(data.get("jobs", []), list):
        return data
    raise RuntimeError("Hermes cron database must be a JSON object with a jobs array")


def _update_check_job_matches(job, template):
    return (
        str(job.get("id") or "") == str(template.get("id") or "")
        or str(job.get("script") or "") == str(template.get("script") or "")
        or str(job.get("name") or "") == str(template.get("name") or "")
    )


def install_update_check_cron(staged_root):
    template_path = staged_root / "cron/nora-tavern-update-check.json"
    if not template_path.is_file():
        return {"installed": False, "reason": "template-missing"}
    template = json.loads(template_path.read_text(encoding="utf-8"))
    if (
        template.get("script") != "nora-tavern-update-check.sh"
        or not template.get("no_agent")
        or (template.get("schedule") or {}).get("expr") != "0 1 * * *"
    ):
        raise RuntimeError("Nora Tavern update-check cron template is malformed")
    document = _load_cron_jobs_document()
    jobs = list(document.get("jobs") or [])
    index = next((i for i, job in enumerate(jobs) if _update_check_job_matches(job, template)), None)
    existing = jobs[index] if index is not None else {}
    now_iso = _utc_now_iso()
    next_run_at = existing.get("next_run_at") or _next_update_check_run_at()
    try:
        if datetime.fromisoformat(str(next_run_at).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            next_run_at = _next_update_check_run_at()
    except (TypeError, ValueError):
        next_run_at = _next_update_check_run_at()
    merged = {
        **template,
        "id": existing.get("id") or template["id"],
        "created_at": existing.get("created_at") or now_iso,
        "next_run_at": next_run_at,
        "last_run_at": existing.get("last_run_at"),
        "last_status": existing.get("last_status"),
        "last_error": existing.get("last_error"),
        "last_delivery_error": existing.get("last_delivery_error"),
    }
    if index is None:
        jobs.append(merged)
        action = "created"
    else:
        jobs[index] = merged
        action = "unchanged" if existing == merged else "updated"
    document["jobs"] = jobs
    document["updated_at"] = now_iso
    atomic_write_text(
        HERMES_CRON_JOBS_FILE,
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
    )
    try:
        HERMES_CRON_JOBS_FILE.chmod(0o600)
    except OSError:
        pass
    return {
        "installed": True,
        "action": action,
        "id": merged["id"],
        "script": merged["script"],
        "schedule": merged["schedule_display"],
        "next_run_at": merged["next_run_at"],
    }


def stage_agents(unpacked, plan_dir):
    release_path = unpacked / "updater" / AGENTS_RELEASE_FILE
    if not release_path.is_file():
        raise RuntimeError("release is missing the managed AGENTS.md")
    current = AGENTS_PATH.read_text(encoding="utf-8") if AGENTS_PATH.is_file() else ""
    updated = release_path.read_text(encoding="utf-8")
    if not updated.strip() or not updated.startswith("# AGENTS.md"):
        raise RuntimeError("release AGENTS.md is malformed")
    plan_dir.mkdir(parents=True, exist_ok=True)
    staged = plan_dir / "staged-agents.md"
    staged.write_text(updated, encoding="utf-8")
    return staged, {
        "path": "agents/AGENTS.md",
        "category": "skill",
        "status": "unchanged" if updated == current else "upstream",
        "base_sha256": None,
        "installed_sha256": sha256_file(AGENTS_PATH) if AGENTS_PATH.is_file() else None,
        "release_sha256": sha256_file(release_path),
        "metadata_normalized": False,
    }


def stage_official_area(area, incoming_root, output_root, managed_names):
    """Stage release-owned files exactly; local copies remain available in backup."""
    current = tree_files(TARGETS[area])
    incoming = tree_files(incoming_root)
    report = []
    for name in sorted(managed_names):
        source = incoming.get(name)
        if source is None:
            raise RuntimeError(f"release is missing official file: {area}/{name}")
        installed = current.get(name)
        current_hash = sha256_file(installed) if installed else None
        release_hash = sha256_file(source)
        copy_file(source, output_root / name)
        report.append({
            "path": f"{area}/{name}",
            "category": category(area, name),
            "status": "unchanged" if current_hash == release_hash else "upstream",
            "base_sha256": None,
            "installed_sha256": current_hash,
            "release_sha256": release_hash,
            "metadata_normalized": False,
        })
    return report, []


def stage_official_skills(incoming_root, output_root, managed_names):
    expected = set(managed_names)
    if expected != CREATIVE_SKILL_FILES:
        raise RuntimeError("release does not contain the exact official Tavern skill set")
    current = tree_files(TARGETS["skills"])
    incoming = tree_files(incoming_root)
    report = []
    for name in sorted(expected):
        source = incoming.get(name)
        if source is None:
            raise RuntimeError(f"release is missing official skill file: {name}")
        installed = current.get(name)
        current_hash = sha256_file(installed) if installed else None
        release_hash = sha256_file(source)
        copy_file(source, output_root / name)
        report.append({
            "path": "skills/" + name,
            "category": "skill",
            "status": "unchanged" if current_hash == release_hash else "upstream",
            "base_sha256": None,
            "installed_sha256": current_hash,
            "release_sha256": release_hash,
            "metadata_normalized": False,
        })
    official_prefixes = tuple(name + "/" for name in CREATIVE_SKILL_NAMES)
    for name, path in sorted(current.items()):
        if name in expected or not name.startswith(official_prefixes):
            continue
        report.append({
            "path": "skills/" + name,
            "category": "skill",
            "status": "replaced",
            "base_sha256": None,
            "installed_sha256": sha256_file(path),
            "release_sha256": None,
            "metadata_normalized": False,
        })
    return report, []


def stage_official_system_skills(incoming_root, output_root, managed_names):
    expected = set(managed_names)
    if expected != SYSTEM_SKILL_FILES:
        raise RuntimeError("release does not contain the exact official Tavern system-skill set")
    current = tree_files(TARGETS["system-skills"])
    incoming = tree_files(incoming_root)
    report = []
    for name in sorted(expected):
        source = incoming.get(name)
        if source is None:
            raise RuntimeError(f"release is missing official system-skill file: {name}")
        installed = current.get(name)
        current_hash = sha256_file(installed) if installed else None
        release_hash = sha256_file(source)
        copy_file(source, output_root / name)
        report.append({
            "path": "system-skills/" + name,
            "category": "skill",
            "status": "unchanged" if current_hash == release_hash else "upstream",
            "base_sha256": None,
            "installed_sha256": current_hash,
            "release_sha256": release_hash,
            "metadata_normalized": False,
        })
    official_prefixes = tuple(name + "/" for name in SYSTEM_SKILL_NAMES)
    for name, path in sorted(current.items()):
        if name in expected or not name.startswith(official_prefixes):
            continue
        report.append({
            "path": "system-skills/" + name,
            "category": "skill",
            "status": "replaced",
            "base_sha256": None,
            "installed_sha256": sha256_file(path),
            "release_sha256": None,
            "metadata_normalized": False,
        })
    return report, []


def merge_file(base, current, incoming, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "merge-file", "-p", str(current), str(base), str(incoming)],
        text=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode == 0:
        output.write_bytes(result.stdout)
        return True
    return False


def normalize_local_asset_queries(path):
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    return LOCAL_ASSET_QUERY_RE.sub(r"\g<prefix>", text)


def metadata_only_upgrade(area, name, base, current, target_version):
    if not target_version or area != "runtime" or name != "web/index.html":
        return False
    normalized_base = normalize_local_asset_queries(base)
    normalized_current = normalize_local_asset_queries(current)
    return normalized_base is not None and normalized_base == normalized_current


def compatibility_replacement(area, name, current_hash, target_version):
    if not target_version or not current_hash:
        return None
    migration = COMPATIBILITY_REPLACEMENTS.get(f"{area}/{name}", {}).get(current_hash)
    if not migration or version_key(target_version) < version_key(migration["min_target"]):
        return None
    return migration["reason"]


def starter_card_key(card):
    if not isinstance(card, dict):
        raise ValueError("starter card must be an object")
    for field in ("file", "card_json", "source", "name"):
        value = str(card.get(field) or "").strip()
        if value:
            return field + ":" + value
    raise ValueError("starter card has no stable identity")


def starter_document(path):
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("cards"), list):
        raise ValueError("starter index must contain a cards array")
    cards = {}
    order = []
    for card in document["cards"]:
        key = starter_card_key(card)
        if key in cards:
            raise ValueError("starter index contains duplicate card identities")
        cards[key] = card
        order.append(key)
    return document, cards, order


def merge_starter_index(base, current, incoming, output):
    """Three-way merge the official starter catalog while preserving local cards."""
    try:
        if base:
            base_doc, base_cards, _base_order = starter_document(base)
        else:
            base_doc, base_cards = {"cards": []}, {}
        current_doc, current_cards, current_order = starter_document(current)
        incoming_doc, incoming_cards, incoming_order = starter_document(incoming)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        return False

    merged_doc = dict(incoming_doc)
    for field, value in current_doc.items():
        if field != "cards" and value != base_doc.get(field):
            merged_doc[field] = value

    merged_cards = dict(incoming_cards)
    merged_order = list(incoming_order)
    for key, base_card in base_cards.items():
        current_card = current_cards.get(key)
        if current_card is None:
            merged_cards.pop(key, None)
            merged_order = [item for item in merged_order if item != key]
        elif current_card != base_card:
            merged_cards[key] = current_card
            if key not in merged_order:
                merged_order.append(key)
    for key in current_order:
        if key not in base_cards:
            merged_cards[key] = current_cards[key]
            if key not in merged_order:
                merged_order.append(key)

    merged_doc["cards"] = [merged_cards[key] for key in merged_order if key in merged_cards]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(merged_doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return True


def safe_starter_asset_name(card):
    name = str(card.get("card_json") or card.get("file") or "").strip()
    path = Path(name)
    if not name or path.is_absolute() or ".." in path.parts:
        raise RuntimeError("starter entry contains an unsafe asset path")
    return path.as_posix()


def stage_legacy_starter_migration(base_runtime, current_runtime, output):
    """Extract local starter changes from a legacy runtime into protected state."""
    relative = Path("assets/fixtures/starter")
    base_dir = base_runtime / relative
    current_dir = current_runtime / relative
    current_index = current_dir / "index.json"
    if not current_index.is_file():
        return {"cards": 0, "disabled": 0, "assets": 0}
    try:
        current_doc, current_cards, current_order = starter_document(current_index)
        base_index = base_dir / "index.json"
        if base_index.is_file():
            _base_doc, base_cards, _base_order = starter_document(base_index)
        else:
            base_cards = {}
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("local starter catalog cannot be migrated safely") from error

    custom_keys = [
        key for key in current_order
        if key not in base_cards or current_cards[key] != base_cards[key]
    ]
    disabled = sorted(key for key in base_cards if key not in current_cards)
    cards = [current_cards[key] for key in custom_keys]
    if not cards and not disabled:
        return {"cards": 0, "disabled": 0, "assets": 0}

    output.mkdir(parents=True, exist_ok=True)
    copied = 0
    for card in cards:
        name = safe_starter_asset_name(card)
        source = current_dir / name
        if not source.is_file():
            raise RuntimeError(f"local starter asset is missing: {name}")
        copy_file(source, output / name)
        copied += 1
    (output / "index.json").write_text(
        json.dumps({
            "schema": 1,
            "source": "legacy-runtime-migration",
            "cards": cards,
            "disabled": disabled,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {"cards": len(cards), "disabled": len(disabled), "assets": copied}


def install_starter_migration(staged):
    index_path = staged / "index.json"
    if not index_path.is_file():
        return {"cards": 0, "disabled": 0, "assets": 0}
    staged_doc, staged_cards, staged_order = starter_document(index_path)
    existing_index = CUSTOM_STARTER_DIR / "index.json"
    if existing_index.is_file():
        try:
            existing_doc, existing_cards, existing_order = starter_document(existing_index)
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError("protected starter catalog is invalid") from error
    else:
        existing_doc, existing_cards, existing_order = {"cards": []}, {}, []

    merged_cards = dict(staged_cards)
    merged_order = list(staged_order)
    for key in existing_order:
        merged_cards[key] = existing_cards[key]
        if key not in merged_order:
            merged_order.append(key)
    disabled = set(staged_doc.get("disabled") or []) | set(existing_doc.get("disabled") or [])
    disabled -= set(merged_cards)

    CUSTOM_STARTER_DIR.mkdir(parents=True, exist_ok=True)
    copied = 0
    for key in staged_order:
        card = staged_cards[key]
        name = safe_starter_asset_name(card)
        source = staged / name
        target = CUSTOM_STARTER_DIR / name
        if key in existing_cards and target.is_file():
            continue
        copy_file(source, target)
        copied += 1
    atomic_write_text(
        existing_index,
        json.dumps({
            "schema": 1,
            "source": "protected-starter-overlay",
            "cards": [merged_cards[key] for key in merged_order],
            "disabled": sorted(disabled),
        }, ensure_ascii=False, indent=2) + "\n",
    )
    return {"cards": len(staged_cards), "disabled": len(disabled), "assets": copied}


def merge_area(
        area, base_root, current_root, incoming_root, output_root, managed_names,
        compatibility_target=None):
    base = tree_files(base_root)
    current = tree_files(current_root)
    incoming = tree_files(incoming_root)
    report = []
    conflicts = []
    for name in sorted(managed_names):
        b, c, n = base.get(name), current.get(name), incoming.get(name)
        bh = sha256_file(b) if b else None
        ch = sha256_file(c) if c else None
        nh = sha256_file(n) if n else None
        status = "unchanged"
        source = None
        metadata_normalized = False
        compatibility_migration = None
        if area == "runtime" and name == ".tavern-release-version" and not c and n:
            source, status = n, "upstream-added"
        elif ch == nh:
            source = c
        elif ch == bh:
            source, status = n, "upstream"
        elif nh == bh:
            source, status = c, "local"
        elif area == "runtime" and name == "assets/fixtures/starter/index.json" and c and n and merge_starter_index(
                b, c, n, output_root / name):
            status = "structured-merged"
        elif b and c and n and metadata_only_upgrade(
                area, name, b, c, compatibility_target):
            source, status = n, "metadata-normalized"
            metadata_normalized = True
        elif b and c and n:
            compatibility_migration = compatibility_replacement(
                area, name, ch, compatibility_target)
            if compatibility_migration:
                source, status = n, "compatibility-migrated"
            elif not any(binary(path) for path in (b, c, n)):
                merged = merge_file(b, c, n, output_root / name)
                if merged:
                    status = "merged"
                else:
                    status = "conflict"
            else:
                status = "conflict"
        elif not b and n and not c:
            source, status = n, "upstream-added"
        else:
            status = "conflict"
        if status == "conflict":
            conflicts.append(f"{area}/{name}")
        elif status not in ("merged", "structured-merged") and source:
            copy_file(source, output_root / name)
        report.append({
            "path": f"{area}/{name}",
            "category": category(area, name),
            "status": status,
            "base_sha256": bh,
            "installed_sha256": ch,
            "release_sha256": nh,
            "metadata_normalized": metadata_normalized,
            "compatibility_migration": compatibility_migration,
        })
    return report, conflicts


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


@contextmanager
def update_lock():
    UPDATE_ROOT.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+", encoding="utf-8") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another Tavern update operation is already running") from exc
        stream.seek(0)
        stream.truncate()
        stream.write(json.dumps({"pid": os.getpid(), "started_at": int(time.time())}) + "\n")
        stream.flush()
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def exclusive(command):
    @wraps(command)
    def wrapped(*args, **kwargs):
        with update_lock():
            return command(*args, **kwargs)
    return wrapped


def request_bytes(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "tavern-updater/2"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(), response.getcode(), response.headers.get_content_type()


def validate_release_code(unpacked, managed_files):
    grouped = split_managed(managed_files)
    python_files, shell_files, javascript_files = [], [], []
    for area, names in grouped.items():
        for name in sorted(names):
            path = unpacked / area / name
            if path.suffix == ".py":
                python_files.append(path)
            elif path.suffix == ".sh":
                shell_files.append(path)
            elif path.suffix == ".js":
                javascript_files.append(path)
    if python_files:
        validation_env = os.environ.copy()
        validation_env["PYTHONPYCACHEPREFIX"] = str(unpacked / ".validation-pycache")
        run(
            [PYTHON, "-m", "py_compile", *map(str, python_files)],
            env=validation_env,
        )
    for path in shell_files:
        checker = "sh"
        try:
            first_line = path.read_text(encoding="utf-8", errors="ignore").splitlines()[0]
        except (OSError, IndexError):
            first_line = ""
        if "bash" in first_line:
            checker = shutil.which("bash") or "bash"
        run([checker, "-n", str(path)])
    node = shutil.which("node")
    if javascript_files and not node:
        raise RuntimeError("Node.js is required to validate managed frontend JavaScript")
    for path in javascript_files:
        run([node, "--check", str(path)], stdout=subprocess.DEVNULL)
    return {
        "python": len(python_files),
        "shell": len(shell_files),
        "javascript": len(javascript_files),
    }


def health():
    if SKIP_SERVICE:
        return True, {"ok": True, "skipped": True}
    try:
        base = HEALTH_URL.rsplit("/api/health", 1)[0]
        data = request_json(HEALTH_URL)
        checks = {"health": bool(data.get("ok") and data.get("key_set"))}
        for name, path in (
            ("identity", "/api/identity"),
            ("actor_card", "/api/actor_card?lang=zh"),
            ("productions", "/api/productions"),
            ("models", "/api/models"),
        ):
            payload = request_json(base + path)
            checks[name] = payload is not None
        for name, path in (("console", "/"), ("actor", "/actor")):
            body, status, content_type = request_bytes(base + path)
            checks[name] = status == 200 and bool(body) and content_type in ("text/html", "application/xhtml+xml")
        return all(checks.values()), {**data, "checks": checks}
    except Exception as exc:
        return False, {"error": str(exc)}


def validate_installed_skills():
    found = []
    for expected in CREATIVE_SKILL_NAMES:
        path = TARGETS["skills"] / expected / "SKILL.md"
        if not path.is_file():
            raise RuntimeError(f"installed Tavern skill is missing: {expected}")
        text = path.read_text(encoding="utf-8")
        match = re.search(r"(?m)^name:\s*['\"]?([^'\"\s]+)", text)
        actual = match.group(1) if match else ""
        if actual != expected:
            raise RuntimeError(f"installed Tavern skill metadata mismatch: {expected}")
        found.append(expected)
    for expected in SYSTEM_SKILL_NAMES:
        path = TARGETS["system-skills"] / expected / "SKILL.md"
        if not path.is_file():
            raise RuntimeError(f"installed Tavern system skill is missing: {expected}")
        text = path.read_text(encoding="utf-8")
        match = re.search(r"(?m)^name:\s*['\"]?([^'\"\s]+)", text)
        actual = match.group(1) if match else ""
        if actual != expected:
            raise RuntimeError(f"installed Tavern system-skill metadata mismatch: {expected}")
        found.append(expected)
    hermes_report = {"checked": False}
    if not SKIP_SERVICE and Path(HERMES).is_file():
        env = dict(os.environ)
        env["HERMES_HOME"] = str(DATA)
        result = subprocess.run(
            [HERMES, "skills", "list"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError("Hermes skill registration check failed: " + result.stdout[-1000:])
        missing = [
            name for name in CREATIVE_SKILL_NAMES + SYSTEM_SKILL_NAMES
            if name not in result.stdout
        ]
        if missing:
            raise RuntimeError("Hermes did not register Tavern skills: " + ", ".join(missing))
        hermes_report = {"checked": True, "registered": found}
    return {"files": found, "hermes": hermes_report}


def copy_managed(source_root, destination_root, managed_files, areas=None):
    grouped = split_managed(managed_files)
    for area, names in grouped.items():
        if areas is not None and area not in areas:
            continue
        for name in sorted(names):
            source = source_root / area / name
            if source.is_file():
                copy_file(source, destination_root / area / name)


def install_managed(source_root, managed_files, areas=None):
    grouped = split_managed(managed_files)
    for area, names in grouped.items():
        if areas is not None and area not in areas:
            continue
        for name in sorted(names):
            source = source_root / area / name
            if not source.is_file():
                raise RuntimeError(f"staged managed file is missing: {area}/{name}")
            target = TARGETS[area] / name
            target.parent.mkdir(parents=True, exist_ok=True)
            pending = target.parent / ("." + target.name + ".next-" + uuid.uuid4().hex[:8])
            try:
                shutil.copy2(source, pending)
                os.replace(pending, target)
            finally:
                try:
                    pending.unlink()
                except OSError:
                    pass


def remove_path(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def replace_official_skills(staged_root):
    expected = {
        name: {
            path.partition("/")[2]
            for path in CREATIVE_SKILL_FILES
            if path.startswith(name + "/")
        }
        for name in CREATIVE_SKILL_NAMES
    }
    pending = TARGETS["skills"] / (".tavern-skills.next-" + uuid.uuid4().hex[:8])
    remove_path(pending)
    pending.mkdir(parents=True)
    try:
        for name in CREATIVE_SKILL_NAMES:
            source = staged_root / name
            if tree_hashes(source).keys() != expected[name]:
                raise RuntimeError(f"staged official skill directory is incomplete: {name}")
            shutil.copytree(source, pending / name)
        for name in CREATIVE_SKILL_NAMES:
            target = TARGETS["skills"] / name
            remove_path(target)
            os.replace(pending / name, target)
        for name in OBSOLETE_CREATIVE_SKILL_NAMES:
            remove_path(TARGETS["skills"] / name)
    finally:
        remove_path(pending)
    installed = official_skill_hashes()
    staged = official_skill_hashes(staged_root)
    if installed != staged:
        raise RuntimeError("installed official skill directories do not match the reviewed release")


def replace_official_system_skills(staged_root):
    expected = {
        name: {
            path.partition("/")[2]
            for path in SYSTEM_SKILL_FILES
            if path.startswith(name + "/")
        }
        for name in SYSTEM_SKILL_NAMES
    }
    pending = TARGETS["system-skills"] / (
        ".tavern-system-skills.next-" + uuid.uuid4().hex[:8]
    )
    remove_path(pending)
    pending.mkdir(parents=True)
    try:
        for name in SYSTEM_SKILL_NAMES:
            source = staged_root / name
            if tree_hashes(source).keys() != expected[name]:
                raise RuntimeError(f"staged official system-skill directory is incomplete: {name}")
            shutil.copytree(source, pending / name)
        for name in SYSTEM_SKILL_NAMES:
            target = TARGETS["system-skills"] / name
            remove_path(target)
            os.replace(pending / name, target)
    finally:
        remove_path(pending)
    installed = official_system_skill_hashes()
    staged = official_system_skill_hashes(staged_root)
    if installed != staged:
        raise RuntimeError("installed official system-skill directories do not match the reviewed release")


def prune_empty_parents(path, root):
    parent = path.parent
    while parent != root:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def remove_obsolete_updater_files():
    for name in OBSOLETE_UPDATER_FILES:
        try:
            (TARGETS["updater"] / name).unlink()
        except FileNotFoundError:
            pass


def remove_obsolete_managed_files(obsolete_files):
    for key in sorted(set(obsolete_files or [])):
        if key not in ALLOWED_OBSOLETE:
            raise RuntimeError(f"release retires an unsupported path: {key}")
        area, separator, name = key.partition("/")
        if not separator or area not in TARGETS:
            raise RuntimeError(f"release retires an invalid path: {key}")
        remove_path(TARGETS[area] / name)


def backup_current(version, managed_files, obsolete_files=None):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS / f"{version}-{stamp}-{uuid.uuid4().hex[:8]}"
    backup.mkdir(parents=True, exist_ok=False)
    missing = []
    for area, names in split_managed(managed_files).items():
        if area in ("skills", "system-skills"):
            continue
        for name in sorted(names):
            current = TARGETS[area] / name
            if current.is_file():
                copy_file(current, backup / "installed" / area / name)
            else:
                missing.append(f"{area}/{name}")
    if BASELINE.is_dir():
        shutil.copytree(BASELINE, backup / "baseline")
    skill_directories_present = []
    for name in SAFE_CREATIVE_SKILL_NAMES:
        current = TARGETS["skills"] / name
        if current.exists() and not current.is_dir():
            raise RuntimeError(f"official skill path is not a directory: {current}")
        if current.is_dir():
            shutil.copytree(current, backup / "skill-directories" / name)
            skill_directories_present.append(name)
    system_skill_directories_present = []
    for name in SYSTEM_SKILL_NAMES:
        current = TARGETS["system-skills"] / name
        if current.exists() and not current.is_dir():
            raise RuntimeError(f"official system-skill path is not a directory: {current}")
        if current.is_dir():
            shutil.copytree(current, backup / "system-skill-directories" / name)
            system_skill_directories_present.append(name)
    agents_present = AGENTS_PATH.is_file()
    if agents_present:
        copy_file(AGENTS_PATH, backup / "AGENTS.md")
    starter_overlay_present = CUSTOM_STARTER_DIR.is_dir()
    if starter_overlay_present:
        shutil.copytree(CUSTOM_STARTER_DIR, backup / "protected-starter")
    cron_jobs_present = HERMES_CRON_JOBS_FILE.is_file()
    if cron_jobs_present:
        copy_file(HERMES_CRON_JOBS_FILE, backup / "hermes-cron/jobs.json")
    obsolete_present = []
    for name in OBSOLETE_UPDATER_FILES:
        current = TARGETS["updater"] / name
        if current.is_file():
            copy_file(current, backup / "obsolete/updater" / name)
            obsolete_present.append("updater/" + name)
    managed_obsolete_present = []
    for key in sorted(set(obsolete_files or [])):
        if key not in ALLOWED_OBSOLETE:
            raise RuntimeError(f"release retires an unsupported path: {key}")
        area, _, name = key.partition("/")
        current = TARGETS[area] / name
        if current.is_file():
            copy_file(current, backup / "obsolete-managed" / area / name)
            managed_obsolete_present.append(key)
    metadata = {
        "schema": 2,
        "managed_files": sorted(managed_files),
        "missing": missing,
        "baseline_present": BASELINE.is_dir(),
        "obsolete_present": obsolete_present,
        "managed_obsolete_files": sorted(set(obsolete_files or [])),
        "managed_obsolete_present": managed_obsolete_present,
        "skill_directories_present": skill_directories_present,
        "system_skill_directories_present": system_skill_directories_present,
        "agents_present": agents_present,
        "starter_overlay_managed": True,
        "starter_overlay_present": starter_overlay_present,
        "cron_jobs_present": cron_jobs_present,
    }
    (backup / "backup.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return backup


def stop_server():
    if SKIP_SERVICE:
        return
    subprocess.run(["pkill", "-f", "server.py --port 8799"], check=False)
    time.sleep(1)


def start_server():
    if not SKIP_SERVICE:
        run(["sh", str(DATA / "skills/creative/tavern/scripts/bringup.sh")])


def restore(backup):
    metadata_path = backup / "backup.json"
    if not metadata_path.is_file():
        raise RuntimeError("rollback backup metadata is missing")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    managed_files = metadata.get("managed_files") or []
    missing = set(metadata.get("missing") or [])
    stop_server()
    for area, names in split_managed(managed_files).items():
        if area in ("skills", "system-skills") and metadata.get("schema") == 2:
            continue
        for name in sorted(names):
            key = f"{area}/{name}"
            target = TARGETS[area] / name
            if key in missing:
                try:
                    target.unlink()
                except OSError:
                    pass
                prune_empty_parents(target, TARGETS[area])
            else:
                copy_file(backup / "installed" / area / name, target)
    managed_obsolete_present = set(metadata.get("managed_obsolete_present") or [])
    for key in metadata.get("managed_obsolete_files") or []:
        if key not in ALLOWED_OBSOLETE:
            continue
        area, _, name = key.partition("/")
        target = TARGETS[area] / name
        if key in managed_obsolete_present:
            copy_file(backup / "obsolete-managed" / area / name, target)
        else:
            remove_path(target)
    obsolete_present = set(metadata.get("obsolete_present") or [])
    for name in OBSOLETE_UPDATER_FILES:
        key = "updater/" + name
        target = TARGETS["updater"] / name
        if key in obsolete_present:
            copy_file(backup / "obsolete/updater" / name, target)
        else:
            try:
                target.unlink()
            except FileNotFoundError:
                pass
            prune_empty_parents(target, TARGETS["updater"])
    if metadata.get("schema") == 2:
        present = set(metadata.get("skill_directories_present") or [])
        for name in SAFE_CREATIVE_SKILL_NAMES:
            target = TARGETS["skills"] / name
            remove_path(target)
            if name in present:
                shutil.copytree(backup / "skill-directories" / name, target)
        if "system_skill_directories_present" in metadata:
            system_present = set(metadata.get("system_skill_directories_present") or [])
            for name in SYSTEM_SKILL_NAMES:
                target = TARGETS["system-skills"] / name
                remove_path(target)
                if name in system_present:
                    shutil.copytree(backup / "system-skill-directories" / name, target)
    else:
        retired_present = set(metadata.get("retired_present") or [])
        for key in metadata.get("retired_files") or []:
            if key not in ALLOWED_OBSOLETE:
                continue
            area, _, name = key.partition("/")
            target = TARGETS[area] / name
            if key in retired_present:
                copy_file(backup / "retired" / area / name, target)
            else:
                try:
                    target.unlink()
                except FileNotFoundError:
                    pass
                prune_empty_parents(target, TARGETS[area])
    if metadata.get("agents_present"):
        copy_file(backup / "AGENTS.md", AGENTS_PATH)
    else:
        try:
            AGENTS_PATH.unlink()
        except FileNotFoundError:
            pass
    if metadata.get("starter_overlay_managed"):
        remove_path(CUSTOM_STARTER_DIR)
        if metadata.get("starter_overlay_present"):
            shutil.copytree(backup / "protected-starter", CUSTOM_STARTER_DIR)
    if metadata.get("cron_jobs_present"):
        copy_file(backup / "hermes-cron/jobs.json", HERMES_CRON_JOBS_FILE)
    else:
        try:
            HERMES_CRON_JOBS_FILE.unlink()
        except FileNotFoundError:
            pass
    shutil.rmtree(BASELINE, ignore_errors=True)
    if metadata.get("baseline_present") and (backup / "baseline").is_dir():
        shutil.copytree(backup / "baseline", BASELINE)
    start_server()


def write_baseline(upstream, managed_files, version):
    pending = UPDATE_ROOT / ".baseline.next"
    shutil.rmtree(pending, ignore_errors=True)
    pending.mkdir(parents=True)
    copy_managed(upstream, pending, managed_files)
    metadata = {
        "schema": 1,
        "version": version,
        "managed_files": sorted(managed_files),
        "hashes": {
            area: tree_hashes(pending / area)
            for area in TARGETS
        },
    }
    (pending / BASELINE_META).write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    old = UPDATE_ROOT / ".baseline.old"
    shutil.rmtree(old, ignore_errors=True)
    if BASELINE.exists():
        BASELINE.rename(old)
    pending.rename(BASELINE)
    shutil.rmtree(old, ignore_errors=True)


def cached_baseline(version, managed_files):
    metadata_path = BASELINE / BASELINE_META
    if not metadata_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if metadata.get("schema") != 1 or metadata.get("version") != version:
        return None
    if sorted(metadata.get("managed_files") or []) != sorted(managed_files):
        return None
    actual = {area: tree_hashes(BASELINE / area) for area in TARGETS}
    if actual != metadata.get("hashes"):
        return None
    return BASELINE


def command_check(_args):
    with tempfile.TemporaryDirectory(prefix="tavern-update-check-") as temp:
        release, manifest, _archive, skill_manifest, _skill_archive = release_material(Path(temp))
    installed = local_version()
    skill_installed = local_skill_version()
    skill_versions = local_skill_versions()
    print(json.dumps({
        "installed": installed,
        "latest": manifest["version"],
        "skill_installed": skill_installed,
        "skill_latest": skill_manifest["version"],
        "skills_installed": skill_versions,
        "skills_complete": all(value != "missing" for value in skill_versions.values()),
        "skill_version_drift": any(
            value not in ("missing", skill_manifest["version"])
            for value in skill_versions.values()),
        "release": release["url"],
    }, ensure_ascii=False))


@exclusive
def command_review(_args):
    UPDATE_ROOT.mkdir(parents=True, exist_ok=True)
    PLANS.mkdir(parents=True, exist_ok=True)
    installed = local_version()
    with tempfile.TemporaryDirectory(prefix="tavern-update-review-") as temp:
        work = Path(temp)
        target_work = work / "target"
        release, manifest, archive, skill_manifest, skill_archive = release_material(target_work)
        managed_files = sorted(set(manifest["managed_files"] + canonical_skill_managed(skill_manifest)))
        obsolete_files = sorted(OBSOLETE_MANAGED_FILES)
        if version_key(manifest["version"]) < version_key(installed):
            raise RuntimeError("latest release is older than the installed version")
        unpacked = target_work / "unpacked"
        unpacked.mkdir()
        safe_extract(archive, unpacked, manifest)
        safe_extract_skill(skill_archive, unpacked, skill_manifest)
        validation = validate_release_code(unpacked, managed_files)

        baseline_trusted = True
        baseline_source = "target-release" if manifest["version"] == installed else "installed-release"
        baseline_warning = ""
        base_root = unpacked
        if manifest["version"] != installed:
            cached = cached_baseline(installed, managed_files)
            if cached:
                base_root = cached
                baseline_source = "verified-cache"
            else:
                try:
                    base_work = work / "base"
                    base_release = tagged_release(installed)
                    old_manifest, old_archive = historical_system_material(
                        base_work, base_release)
                    if old_manifest["version"] != installed:
                        raise RuntimeError("installed release version does not match its manifest")
                    base_root = base_work / "unpacked"
                    base_root.mkdir()
                    safe_extract(old_archive, base_root, old_manifest)
                    baseline_source = "installed-tag-system"
                except Exception as tagged_error:
                    try:
                        base_root = bundled_baseline(work / "bundled-base", release, installed)
                        baseline_source = "bundled-historical-baseline"
                    except Exception as bundled_error:
                        baseline_trusted = False
                        baseline_source = "unavailable"
                        baseline_warning = (
                            "No verified official baseline is available for installed version "
                            f"{installed}: tagged release: {tagged_error}; bundled baseline: "
                            f"{bundled_error}. Official code can still be replaced safely; the entire "
                            "installed starter catalog will be preserved as a user overlay."
                        )
                        base_root = work / "untrusted-empty-base"
                        for area in TARGETS:
                            (base_root / area).mkdir(parents=True, exist_ok=True)

        plan_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
        plan_dir = PLANS / plan_id
        staged = plan_dir / "staged"
        upstream = plan_dir / "upstream"
        starter_migration = plan_dir / "starter-migration"
        staged.mkdir(parents=True)
        upstream.mkdir(parents=True)
        copy_managed(unpacked, upstream, managed_files)
        starter_migration_summary = stage_legacy_starter_migration(
            base_root / "runtime",
            TARGETS["runtime"],
            starter_migration,
        )
        files, conflicts = [], []
        managed_by_area = split_managed(managed_files)
        for area, target in TARGETS.items():
            incoming = unpacked / area
            if area == "skills":
                area_files, area_conflicts = stage_official_skills(
                    incoming, staged / area, managed_by_area[area])
            elif area == "system-skills":
                area_files, area_conflicts = stage_official_system_skills(
                    incoming, staged / area, managed_by_area[area])
            else:
                area_files, area_conflicts = stage_official_area(
                    area, incoming, staged / area, managed_by_area[area])
            files.extend(area_files)
            conflicts.extend(area_conflicts)
        staged_agents, agents_report = stage_agents(unpacked, plan_dir)
        files.append(agents_report)
        counts = {}
        categories = {}
        for item in files:
            counts[item["status"]] = counts.get(item["status"], 0) + 1
            if item["status"] != "unchanged":
                categories[item["category"]] = categories.get(item["category"], 0) + 1
        plan = {
            "schema": 2,
            "skill_install_mode": "exact-directories",
            "plan_id": plan_id,
            "installed": installed,
            "target": manifest["version"],
            "release": release["url"],
            "archive_sha256": manifest["sha256"],
            "skill_archive_sha256": skill_manifest["sha256"],
            "created_at": int(time.time()),
            "managed_files": managed_files,
            "obsolete_files": obsolete_files,
            "current_fingerprint": managed_fingerprint(managed_files, obsolete_files),
            "staged_hashes": {area: tree_hashes(staged / area) for area in TARGETS},
            "upstream_hashes": {area: tree_hashes(upstream / area) for area in TARGETS},
            "starter_migration_hashes": tree_hashes(starter_migration),
            "starter_migration": starter_migration_summary,
            "staged_agents_sha256": sha256_file(staged_agents),
            "baseline_trusted": baseline_trusted,
            "baseline_source": baseline_source,
            "baseline_warning": baseline_warning,
            "validation": validation,
            "reported_at": None,
            "ready": not conflicts,
            "counts": counts,
            "categories": categories,
            "conflicts": conflicts,
            "metadata_normalized": [
                item["path"] for item in files if item.get("metadata_normalized")
            ],
            "compatibility_migrations": [
                {
                    "path": item["path"],
                    "reason": item["compatibility_migration"],
                }
                for item in files if item.get("compatibility_migration")
            ],
            "files": files,
        }
        atomic_write_text(
            plan_dir / "plan.json",
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        )
    print(json.dumps({
        "plan_id": plan["plan_id"],
        "installed": plan["installed"],
        "target": plan["target"],
        "ready": plan["ready"],
        "baseline_trusted": plan["baseline_trusted"],
        "baseline_source": plan["baseline_source"],
        "baseline_warning": plan["baseline_warning"],
        "validation": plan["validation"],
        "counts": plan["counts"],
        "categories": plan["categories"],
        "conflicts": plan["conflicts"],
        "metadata_normalized": plan["metadata_normalized"],
        "compatibility_migrations": plan["compatibility_migrations"],
        "starter_migration": plan["starter_migration"],
    }, ensure_ascii=False))


@exclusive
def command_report(args):
    plan_path = PLANS / args.plan / "plan.json"
    if not plan_path.is_file():
        raise RuntimeError("review plan does not exist")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if managed_fingerprint(
            plan.get("managed_files") or [], plan.get("obsolete_files") or []) != plan.get("current_fingerprint"):
        raise RuntimeError("installed files changed after review; run review again")
    changes = [item for item in plan.get("files") or [] if item.get("status") != "unchanged"]
    plan["reported_at"] = int(time.time())
    atomic_write_text(plan_path, json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    report = {
        "plan_id": plan["plan_id"],
        "installed": plan["installed"],
        "target": plan["target"],
        "scope": "tavern-system",
        "ready": plan["ready"],
        "baseline_trusted": plan["baseline_trusted"],
        "baseline_source": plan["baseline_source"],
        "baseline_warning": plan["baseline_warning"],
        "validation": plan["validation"],
        "counts": plan["counts"],
        "categories": plan["categories"],
        "conflicts": plan["conflicts"],
        "metadata_normalized": plan.get("metadata_normalized") or [],
        "compatibility_migrations": plan.get("compatibility_migrations") or [],
        "starter_migration": plan.get("starter_migration") or {
            "cards": 0, "disabled": 0, "assets": 0,
        },
        "changed_files": len(changes),
        "details": bool(args.details),
        "preserved": [
            "Tavern state, worlds, characters, stories, uploads and model configuration",
            "identity, persona, credentials and ClawChat databases",
            "custom skill directories",
            "locally added or edited starter catalog entries",
        ],
        "managed_policy": "Official runtime, frontend, Tavern skills and AGENTS.md are verified and backed up before replacement.",
        "next_step": "Report this compact summary once. Request file details only for a real conflict diagnosis.",
    }
    if args.details:
        report["changes"] = changes
    print(json.dumps(report, ensure_ascii=False))


def load_plan(plan_id):
    plan_path = PLANS / plan_id / "plan.json"
    if not plan_path.is_file():
        raise RuntimeError("review plan does not exist")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("schema") != 2 or plan.get("skill_install_mode") != "exact-directories":
        raise RuntimeError("review plan does not use the required exact-directory skill policy")
    file_conflicts = {
        item.get("path")
        for item in (plan.get("files") or [])
        if item.get("status") == "conflict"
    }
    declared_conflicts = set(plan.get("conflicts") or [])
    if declared_conflicts != file_conflicts or bool(plan.get("ready")) == bool(file_conflicts):
        raise RuntimeError("review plan conflict state is inconsistent; run review again")
    staged = plan_path.parent / "staged"
    upstream = plan_path.parent / "upstream"
    if not plan.get("ready"):
        raise RuntimeError("review plan contains merge conflicts")
    if not plan.get("reported_at"):
        raise RuntimeError("review plan has not been reported; run report and show it to the user first")
    managed_files = plan.get("managed_files") or []
    obsolete_files = plan.get("obsolete_files") or []
    if managed_fingerprint(managed_files, obsolete_files) != plan.get("current_fingerprint"):
        raise RuntimeError("installed files changed after review; run review again")
    actual = {area: tree_hashes(staged / area) for area in TARGETS}
    if actual != plan.get("staged_hashes"):
        raise RuntimeError("reviewed staging files changed after review")
    actual_upstream = {area: tree_hashes(upstream / area) for area in TARGETS}
    if actual_upstream != plan.get("upstream_hashes"):
        raise RuntimeError("verified upstream files changed after review")
    starter_migration = plan_path.parent / "starter-migration"
    if tree_hashes(starter_migration) != (plan.get("starter_migration_hashes") or {}):
        raise RuntimeError("reviewed starter migration changed after review")
    staged_agents = plan_path.parent / "staged-agents.md"
    if not staged_agents.is_file() or sha256_file(staged_agents) != plan.get("staged_agents_sha256"):
        raise RuntimeError("reviewed AGENTS.md staging changed after review")
    return plan, staged, upstream, staged_agents, starter_migration


@exclusive
def command_apply(args):
    if not args.confirm:
        raise RuntimeError("apply requires --confirm")
    if not args.plan:
        raise RuntimeError("apply requires --plan from a successful review")
    BACKUPS.mkdir(parents=True, exist_ok=True)
    plan, staged, upstream, staged_agents, starter_migration = load_plan(args.plan)
    managed_files = plan.get("managed_files") or []
    obsolete_files = plan.get("obsolete_files") or []
    installed = local_version()
    backup = backup_current(installed, managed_files, obsolete_files)
    try:
        stop_server()
        install_managed(staged, managed_files, areas={"runtime"})
        starter_report = install_starter_migration(starter_migration)
        remove_obsolete_managed_files(obsolete_files)
        replace_official_skills(staged / "skills")
        replace_official_system_skills(staged / "system-skills")
        atomic_write_text(AGENTS_PATH, staged_agents.read_text(encoding="utf-8"))
        skill_report = validate_installed_skills()
        start_server()
        ok, report = health()
        if not ok:
            raise RuntimeError("health check failed: " + json.dumps(report, ensure_ascii=False))
        install_managed(staged, managed_files, areas={"scripts", "cron"})
        cron_report = install_update_check_cron(staged)
        # Self-update last so a failed application update keeps the known-good updater.
        install_managed(staged, managed_files, areas={"updater"})
        remove_obsolete_updater_files()
        write_baseline(upstream, managed_files, plan["target"])
        state = {
            "installed": plan["target"],
            "previous": installed,
            "backup": str(backup),
            "release": plan["release"],
            "plan_id": args.plan,
            "updated_at": int(time.time()),
        }
        atomic_write_text(STATE, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    except Exception as error:
        restore(backup)
        rollback_ok, rollback_report = health()
        if not rollback_ok:
            raise RuntimeError(
                "update failed and the restored service did not pass validation: "
                + json.dumps(rollback_report, ensure_ascii=False)
            ) from error
        raise
    print(json.dumps({"updated": True, "from": installed, "to": plan["target"],
                      "plan_id": args.plan, "skills": skill_report,
                      "starter_migration": starter_report,
                      "cron": cron_report,
                      "health": report}, ensure_ascii=False))


@exclusive
def command_rollback(args):
    if not args.confirm:
        raise RuntimeError("rollback requires --confirm")
    if not STATE.exists():
        raise RuntimeError("no updater state is available for rollback")
    state = json.loads(STATE.read_text(encoding="utf-8"))
    backup = Path(state.get("backup") or "")
    if not (backup / "backup.json").is_file():
        raise RuntimeError("rollback backup is missing")
    current = local_version()
    restore(backup)
    ok, report = health()
    if not ok:
        raise RuntimeError("rollback completed but health check failed: " + json.dumps(report, ensure_ascii=False))
    STATE.unlink()
    print(json.dumps({"rolled_back": True, "from": current, "to": local_version(), "health": report}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.set_defaults(func=command_check)
    review = sub.add_parser("review")
    review.set_defaults(func=command_review)
    report = sub.add_parser("report")
    report.add_argument("--plan", required=True)
    report.add_argument("--details", action="store_true")
    report.set_defaults(func=command_report)
    apply_parser = sub.add_parser("apply")
    apply_parser.add_argument("--plan")
    apply_parser.add_argument("--confirm", action="store_true")
    apply_parser.set_defaults(func=command_apply)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("--confirm", action="store_true")
    rollback.set_defaults(func=command_rollback)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
