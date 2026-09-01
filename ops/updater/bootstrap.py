#!/usr/bin/env python3
"""Download one release and hand it to the direct Tavern installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
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


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target):
    request = urllib.request.Request(url, headers={"User-Agent": "tavern-updater/3"})
    with urllib.request.urlopen(request, timeout=120) as response, Path(target).open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def verify_bundle(directory, expected_manifest=None):
    directory = Path(directory)
    sums = {}
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(None, 1)
        sums[name.strip()] = digest
    for name in ASSETS:
        if not (directory / name).is_file():
            raise RuntimeError("发布文件缺失或校验失败：" + name)
        if name != "SHA256SUMS" and sha(directory / name) != sums.get(name):
            raise RuntimeError("发布文件缺失或校验失败：" + name)
    manifest_sha = sums["release-manifest.json"]
    if expected_manifest and expected_manifest != manifest_sha:
        raise RuntimeError("本地发布清单与指定校验值不一致")
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "tavern-release/v2" or manifest.get("candidate"):
        raise RuntimeError("只允许安装正式 Tavern v2 发布包")
    return manifest, manifest_sha


def extract_runner(directory, destination, manifest):
    expected = {name: digest for name, digest in manifest["artifacts"].items() if name.startswith("ops/")}
    archive = Path(directory) / "nora-tavern-ops.tar.gz"
    if sha(archive) != manifest["archives"]["ops"]["sha256"]:
        raise RuntimeError("更新器压缩包校验失败")
    seen = set()
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or ".." in path.parts or member.name not in expected:
                raise RuntimeError("更新器压缩包包含非法文件")
            data = package.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != expected[member.name]:
                raise RuntimeError("更新器文件校验失败：" + member.name)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(member.name)
    if seen != set(expected):
        raise RuntimeError("更新器压缩包不完整")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", "--hermes-home", dest="home", default=os.environ.get("HERMES_HOME", "/opt/data"))
    parser.add_argument("--tag")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if not (args.apply and args.confirm):
        raise RuntimeError("更新命令必须包含 --apply --confirm")
    home = Path(args.home).expanduser().resolve()
    root = home / "tavern-updates"
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="install-", dir=root) as temporary:
        work = Path(temporary)
        bundle = args.release_dir
        if bundle is None:
            bundle = work / "release"
            bundle.mkdir()
            base = (
                f"https://github.com/{REPO}/releases/download/{args.tag}"
                if args.tag else f"https://github.com/{REPO}/releases/latest/download"
            )
            for name in ASSETS:
                download(base + "/" + name, bundle / name)
        manifest, manifest_sha = verify_bundle(bundle, args.manifest_sha256)
        runner = work / "runner"
        extract_runner(bundle, runner, manifest)
        command = [
            sys.executable, "-u", "-B", str(runner / "ops/updater/update.py"),
            "--hermes-home", str(home), "install",
            "--release-dir", str(Path(bundle).resolve()),
            "--manifest-sha256", manifest_sha, "--confirm",
        ]
        result = subprocess.run(command)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[tavern-updater] 更新失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
