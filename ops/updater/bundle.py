"""Read a pinned full-release bundle without executing archive content."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.request

PARTS = {"app": "tavern-runtime", "ops": "tavern-ops", "nora-mcp": "nora-mcp"}
REPOSITORY = "LoveMaker-art/noras-tavern"
HEX = re.compile(r"^[a-f0-9]{64}$")


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
        raise ValueError("Release manifest digest differs from the reviewed/pinned digest")
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
    return manifest


def extract_bundle(directory, destination, manifest):
    """Only regular, manifested, size-bounded files; never extractall()."""
    seen, expanded = set(), 0
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Extraction requires a new staging directory")
    destination.mkdir(parents=True)
    for part, archive in manifest["archives"].items():
        name = f"nora-tavern-{part}.tar.gz"
        if archive.get("name") != name:
            raise ValueError("Unexpected archive name")
        with (Path(directory) / name).open("rb") as stream:
            raw = stream.read(256 * 1024 * 1024 + 1)
        if len(raw) > 256 * 1024 * 1024 or digest(raw) != archive.get("sha256"):
            raise ValueError("Archive checksum/size mismatch: " + name)
        with tarfile.open(Path(directory) / name, "r:gz") as tar:
            for member in tar:
                p = relative(member.name)
                if not member.isfile() or p.parts[0] != part or member.name in seen:
                    raise ValueError("Unsafe or duplicate archive member: " + member.name)
                if member.name not in manifest["artifacts"] or not 0 <= member.size <= 64 * 1024 * 1024:
                    raise ValueError("Unmanifested/oversize member: " + member.name)
                expanded += member.size
                if expanded > 512 * 1024 * 1024:
                    raise ValueError("Expanded release exceeds size limit")
                data = tar.extractfile(member).read(member.size + 1)
                if digest(data) != manifest["artifacts"][member.name]:
                    raise ValueError("Artifact checksum mismatch: " + member.name)
                target = destination.joinpath(*p.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
                seen.add(member.name)
    if seen != set(manifest["artifacts"]):
        raise ValueError("Archive is missing manifested files")
    for required in ("app/native-runtime.json", "app/story_profile_runtime/manifest.json",
                     "nora-mcp/dist/server.js", "nora-mcp/npm-shrinkwrap.json",
                     "ops/scripts/install-hermes-skills.py", "ops/updater/update.py",
                     "ops/skills/agents-tavern.md", "ops/skills/creative/nora-cardforge/SKILL.md"):
        if required not in seen:
            raise ValueError("Incomplete full release: " + required)


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
