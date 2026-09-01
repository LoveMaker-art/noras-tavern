#!/usr/bin/env python3
"""Prepare the four official Tavern skill directories for direct replacement."""
import argparse
import json
from pathlib import Path
import shutil

SKILLS = (
    "creative/tavern",
    "creative/tavern-ops",
    "system/tavern-updater",
    "creative/nora-cardforge",
)
RETIRED = (
    "tavern-world",
    "tavern-runtime-plugins",
    "tavern-continuity",
    "tavern-story-profile",
    "tavern-frontend",
    "tavern-world-visuals",
)
TAVERN_SCRIPTS = (
    "runtime.sh",
    "provision.sh",
    "bringup-native.sh",
    "analyze-boot-metrics.mjs",
    "analyze-runtime-phases.mjs",
    "profile_memory.py",
)


def prepare_skill_trees(release, destination):
    release, destination = Path(release), Path(destination)
    source = release / "ops/skills"
    destination.mkdir(parents=True, exist_ok=True)
    prepared = {}
    for relative in SKILLS:
        origin = source / relative
        if not (origin / "SKILL.md").is_file():
            raise RuntimeError("发布包缺少技能：" + relative)
        target = destination / relative
        shutil.copytree(origin, target)
        prepared[relative] = target
    tavern = prepared["creative/tavern"]
    scripts = tavern / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    for name in TAVERN_SCRIPTS:
        shutil.copy2(release / "ops/scripts" / name, scripts / name)
    hook_source = release / "ops/hooks/tavern-liveware-register"
    if hook_source.is_dir():
        shutil.copytree(hook_source, tavern / "hooks/tavern-liveware-register", dirs_exist_ok=True)
    shutil.copy2(release / "ops/eslint-owned.cjs", tavern / "eslint-owned.cjs")
    return prepared


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    prepared = prepare_skill_trees(args.source, args.destination)
    print(json.dumps({"prepared": sorted(prepared)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
