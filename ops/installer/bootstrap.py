#!/usr/bin/env python3
"""Download one release and run the Hermes-only Nora Tavern first installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


REPO = "LoveMaker-art/noras-tavern"
ASSETS = (
    "release-manifest.json",
    "SHA256SUMS",
    "nora-tavern-app.tar.gz",
    "nora-tavern-ops.tar.gz",
    "nora-tavern-nora-mcp.tar.gz",
)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "nora-tavern-first-install/1"})
    with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def verify_release(directory: Path) -> str:
    checks = {}
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(None, 1)
        checks[name.strip()] = digest
    for name in ASSETS:
        if not (directory / name).is_file():
            raise RuntimeError("发布文件缺失：" + name)
        if name != "SHA256SUMS" and sha(directory / name) != checks.get(name):
            raise RuntimeError("发布文件校验失败：" + name)
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "tavern-release/v2" or manifest.get("candidate"):
        raise RuntimeError("首次安装默认只允许正式 Nora Tavern v2 发布包")
    return checks["release-manifest.json"]


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise RuntimeError("发布包包含非法路径：" + name)
    return path


def extract_ops_runner(release_dir: Path, destination: Path) -> Path:
    manifest = json.loads((release_dir / "release-manifest.json").read_text(encoding="utf-8"))
    expected = {
        name: digest
        for name, digest in manifest.get("artifacts", {}).items()
        if name.startswith("ops/")
    }
    if not expected:
        raise RuntimeError("发布包缺少 ops 文件清单")
    archive = release_dir / "nora-tavern-ops.tar.gz"
    if sha(archive) != manifest["archives"]["ops"]["sha256"]:
        raise RuntimeError("ops 发布包校验失败")
    seen = set()
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            path = safe_member(member.name)
            if not member.isfile() or path.parts[0] != "ops" or member.name not in expected:
                raise RuntimeError("ops 发布包包含未声明文件：" + member.name)
            data = package.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != expected[member.name]:
                raise RuntimeError("ops 文件校验失败：" + member.name)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(member.name)
    required = {
        "ops/installer/first_install.py",
        "ops/installer/templates/SOUL.md",
        "ops/updater/bundle.py",
        "ops/scripts/install-hermes-skills.py",
    }
    missing = sorted(required - seen)
    if missing:
        raise RuntimeError("ops 发布包缺少首次安装文件：" + ", ".join(missing))
    return destination / "ops/installer/first_install.py"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--hermes-home", "--data-root", dest="hermes_home")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--replace-soul", action="store_true")
    parser.add_argument("--skip-liveware", action="store_true")
    parser.add_argument("--force-first-install", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if not (args.apply and args.confirm):
        raise RuntimeError("首次安装必须显式传入 --apply --confirm")

    with tempfile.TemporaryDirectory(prefix="nora-tavern-bootstrap.") as temporary:
        work = Path(temporary)
        release_dir = args.release_dir
        if release_dir is None:
            release_dir = work / "release"
            release_dir.mkdir()
            base = (
                f"https://github.com/{REPO}/releases/download/{args.tag}"
                if args.tag else f"https://github.com/{REPO}/releases/latest/download"
            )
            for name in ASSETS:
                download(base + "/" + name, release_dir / name)
        manifest_sha = verify_release(release_dir)
        installer = extract_ops_runner(release_dir, work / "runner")
        command = [
            sys.executable, "-u", "-B", str(installer),
            "--release-dir", str(Path(release_dir).resolve()),
            "--manifest-sha256", manifest_sha,
            "--port", str(args.port),
            "--apply", "--confirm",
        ]
        if args.hermes_home:
            command += ["--hermes-home", args.hermes_home]
        if args.replace_soul:
            command.append("--replace-soul")
        if args.skip_liveware:
            command.append("--skip-liveware")
        if args.force_first_install:
            command.append("--force-first-install")
        result = subprocess.run(command)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[nora-tavern-install] 安装失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
