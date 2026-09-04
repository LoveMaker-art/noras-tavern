"""Read a pinned full-release bundle without executing archive content."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import urllib.request

PARTS = {"app": "tavern-runtime", "ops": "tavern-ops", "nora-mcp": "nora-mcp"}
REPOSITORY = "LoveMaker-art/noras-tavern"
HEX = re.compile(r"^[a-f0-9]{64}$")
MODULE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    if not isinstance(value, str) or not value or any(c in value for c in "\\\n\r\0"):
        raise ValueError("Invalid release path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(x in ("", ".", "..") for x in value.split("/")):
        raise ValueError("Unsafe release path: " + value)
    return p


def read_bundle(directory, expected, *, candidate=False):
    directory = Path(directory)
    with (directory / "release-manifest.json").open("rb") as stream:
        raw = stream.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("Manifest size limit exceeded")
    if not HEX.fullmatch(expected or "") or digest(raw) != expected:
        raise ValueError("Release manifest digest does not match SHA256SUMS")
    manifest = json.loads(raw)
    if manifest.get("schema") != "tavern-release/v2":
        raise ValueError("Requires tavern-release/v2; legacy Python releases are not compatible")
    if manifest.get("candidate") and not candidate:
        raise ValueError("Candidate requires explicit --allow-candidate; not a stable release")
    if set(manifest.get("archives", {})) != set(PARTS):
        raise ValueError("Full release must contain app, ops and nora-mcp archives")
    artifacts = manifest.get("artifacts", {})
    if not artifacts or len(artifacts) > 20000:
        raise ValueError("Invalid artifact inventory")
    for name, sha in artifacts.items():
        p = relative(name)
        if p.parts[0] not in PARTS or not HEX.fullmatch(sha):
            raise ValueError("Invalid artifact: " + name)
    modes = manifest.get("artifactModes")
    if modes is not None and (
            not isinstance(modes, dict) or set(modes) != set(artifacts)
            or any(mode not in (0o644, 0o755) for mode in modes.values())):
        raise ValueError("Invalid artifact mode inventory")
    modules = manifest.get("modules")
    if modules is not None:
        if not isinstance(modules, dict) or not modules:
            raise ValueError("Invalid release modules")
        assigned = set()
        for module, descriptor in modules.items():
            if not MODULE.fullmatch(module) or not isinstance(descriptor, dict):
                raise ValueError("Invalid release module: " + str(module))
            if descriptor.get("name") != f"nora-tavern-module-{module}.tar.gz" or not HEX.fullmatch(descriptor.get("sha256", "")):
                raise ValueError("Invalid release module archive: " + module)
            members = descriptor.get("artifacts")
            if not isinstance(members, list) or not members:
                raise ValueError("Empty release module: " + module)
            for name in members:
                if name not in artifacts or name in assigned:
                    raise ValueError("Invalid or duplicate module artifact: " + str(name))
                assigned.add(name)
        if assigned != set(artifacts):
            raise ValueError("Release modules do not cover the artifact inventory")
    return manifest


def installed_roots(home):
    home = Path(home)
    return {
        "app": home / "apps/tavern-runtime",
        "ops": home / "apps/tavern-ops",
        "nora-mcp": home / "apps/nora-mcp",
    }


def artifact_path(name, roots):
    p = relative(name)
    root = roots.get(p.parts[0]) if roots else None
    return root.joinpath(*p.parts[1:]) if root else None


def file_matches(path, expected, expected_mode=None):
    try:
        if path is None or not path.is_file() or path.is_symlink():
            return False
        return (digest(path.read_bytes()) == expected
                and (expected_mode is None or path.stat().st_mode & 0o777 == expected_mode))
    except OSError:
        return False


def changed_modules(manifest, roots):
    modules = manifest.get("modules") or {}
    artifacts = manifest.get("artifacts") or {}
    modes = manifest.get("artifactModes") or {}
    changed = []
    for module, descriptor in modules.items():
        if any(not file_matches(artifact_path(name, roots), artifacts[name], modes.get(name)) for name in descriptor["artifacts"]):
            changed.append(module)
    return sorted(changed)


def _extract_archive(archive_path, expected, destination):
    seen = set()
    expanded = 0
    with tarfile.open(archive_path, "r:gz") as tar:
        for member in tar:
            p = relative(member.name)
            if not member.isfile() or member.name not in expected or member.name in seen:
                raise ValueError("Unsafe, unexpected or duplicate archive member: " + member.name)
            if not 0 <= member.size <= 64 * 1024 * 1024:
                raise ValueError("Oversize archive member: " + member.name)
            expanded += member.size
            if expanded > 512 * 1024 * 1024:
                raise ValueError("Expanded archive exceeds size limit")
            data = tar.extractfile(member).read(member.size + 1)
            if digest(data) != expected[member.name]:
                raise ValueError("Artifact checksum mismatch: " + member.name)
            target = destination.joinpath(*p.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError("Archive is missing manifested files")
    return seen


def extract_bundle(directory, destination, manifest, *, roots=None):
    """Only regular, manifested, size-bounded files; never extractall()."""
    seen = set()
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Extraction requires a new staging directory")
    destination.mkdir(parents=True)
    directory = Path(directory)
    artifacts = manifest["artifacts"]
    full_names = {part: f"nora-tavern-{part}.tar.gz" for part in PARTS}
    full_available = all((directory / name).is_file() for name in full_names.values())
    changed = changed_modules(manifest, roots) if roots and manifest.get("modules") else sorted((manifest.get("modules") or {}).keys())
    downloaded = []
    if full_available:
        for part, archive in manifest["archives"].items():
            name = full_names[part]
            if archive.get("name") != name:
                raise ValueError("Unexpected archive name")
            raw = (directory / name).read_bytes()
            if len(raw) > 256 * 1024 * 1024 or digest(raw) != archive.get("sha256"):
                raise ValueError("Archive checksum/size mismatch: " + name)
            expected = {key: value for key, value in artifacts.items() if key.startswith(part + "/")}
            seen.update(_extract_archive(directory / name, expected, destination))
    elif manifest.get("modules") and roots:
        changed_set = set(changed)
        for module, descriptor in manifest["modules"].items():
            members = descriptor["artifacts"]
            if module in changed_set:
                archive = directory / descriptor["name"]
                if (not archive.is_file() or archive.stat().st_size > 256 * 1024 * 1024
                        or digest(archive.read_bytes()) != descriptor["sha256"]):
                    raise ValueError("Changed module archive is missing or invalid: " + module)
                expected = {name: artifacts[name] for name in members}
                seen.update(_extract_archive(archive, expected, destination))
                downloaded.append(module)
                continue
            for name in members:
                source = artifact_path(name, roots)
                if not file_matches(source, artifacts[name], (manifest.get("artifactModes") or {}).get(name)):
                    raise ValueError("Reusable artifact changed during update planning: " + name)
                target = destination.joinpath(*relative(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                seen.add(name)
    else:
        raise ValueError("Release contains neither complete archives nor a reusable incremental module set")
    if seen != set(manifest["artifacts"]):
        raise ValueError("Archive is missing manifested files")
    for required in ("app/native-runtime.json", "app/story_profile_runtime/manifest.json",
                     "nora-mcp/dist/server.js", "nora-mcp/npm-shrinkwrap.json",
                     "ops/scripts/install-hermes-skills.py", "ops/updater/update.py",
                     "ops/skills/agents-tavern.md", "ops/skills/creative/nora-cardforge/SKILL.md"):
        if required not in seen:
            raise ValueError("Incomplete full release: " + required)
    return {
        "mode": "full" if full_available else "incremental",
        "changedModules": changed,
        "downloadedModules": sorted(downloaded),
    }


def download_release(tag, destination):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", tag):
        raise ValueError("Use an explicit GitHub release tag, not a branch or URL")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    base = f"https://github.com/{REPOSITORY}/releases/download/{tag}/"
    for name in ("release-manifest.json", "SHA256SUMS", *(f"nora-tavern-{p}.tar.gz" for p in PARTS)):
        request = urllib.request.Request(base + name, headers={"User-Agent": "tavern-updater-v2"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(256 * 1024 * 1024 + 1)
        if len(data) > 256 * 1024 * 1024:
            raise ValueError("Download size limit exceeded")
        (destination / name).write_bytes(data)
    checks = dict(line.split(None, 1)[::-1] for line in (destination / "SHA256SUMS").read_text().splitlines())
    expected = checks.get("release-manifest.json", "")
    if digest((destination / "release-manifest.json").read_bytes()) != expected:
        raise ValueError("Downloaded manifest checksum mismatch")
    return {"repository": REPOSITORY, "tag": tag, "directory": str(destination), "manifestSha256": expected}
