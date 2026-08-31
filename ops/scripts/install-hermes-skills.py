#!/usr/bin/env python3
"""Install Tavern's four skills and helpers; default is a read-only plan."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


SKILLS = ("creative/tavern", "creative/tavern-ops", "system/tavern-updater", "creative/nora-cardforge")
RETIRED = (
    "tavern-world", "tavern-runtime-plugins", "tavern-continuity",
    "tavern-story-profile", "tavern-frontend", "tavern-world-visuals",
)
OLD_REFERENCES = (
    "creative/tavern-world-visuals/scripts/world_theme.py",
    "creative/tavern-world-visuals/references/theme-schema.md",
    "creative/tavern/references/shared-contract.md",
    "creative/tavern/references/native-runtime.md",
    "creative/tavern/references/conversation-cards.md",
    "creative/tavern/specialists/tavern-story-profile/references/actor-memory.md",
    "creative/tavern-story-profile/references/actor-memory.md",
    "creative/tavern-ops/references/i18n.md",
    "creative/tavern-ops/references/liveware-ops.md",
    "creative/tavern-ops/references/model-config.md",
    "system/tavern-updater/references/AGENTS.md",
    "system/tavern-updater/references/release-format.md",
)
PROFILE_HELPER = "creative/tavern/scripts/profile_memory.py"
OLD_PROFILE_HELPERS = (
    "creative/tavern-story-profile/scripts/profile_memory.py",
    "creative/tavern/specialists/tavern-story-profile/scripts/profile_memory.py",
)
BEGIN, END = "<!-- BEGIN TAVERN SKILLS -->", "<!-- END TAVERN SKILLS -->"
LEGACY_SECTIONS = {
    "## Tavern Skill Routing": "aeaf6c777e0f35201e95c7f6d3547822f391abe08b8b5a1dfce63bbfb4881285",
    "## Execution Contract": "c0b9aeacaec3e0d98d3b8e569e5381bf0e0d8ce79b215d7203750070a2b49f9f",
    "## Tavern Updates": "5e86541ed63ae6b635af7afb7c9498d791ca3e02f7913bffc39f8aca8b188eb8",
}
PROVISION_OLD = '''# Keep the Story Profile specialist in lockstep with the Nora adapter. Older
# installs called the removed Python /api/event endpoint from this skill.
STORY_PROFILE_SKILL_SOURCE="$SCRIPT_DIR/../specialists/tavern-story-profile"
STORY_PROFILE_SKILL_TARGET="$HERMES_HOME/skills/creative/tavern-story-profile"
if [ -d "$STORY_PROFILE_SKILL_SOURCE" ]; then
  mkdir -p "$STORY_PROFILE_SKILL_TARGET/scripts" "$STORY_PROFILE_SKILL_TARGET/references"
  cp "$STORY_PROFILE_SKILL_SOURCE/SKILL.md" "$STORY_PROFILE_SKILL_TARGET/SKILL.md"
  cp "$STORY_PROFILE_SKILL_SOURCE/scripts/profile_memory.py" "$STORY_PROFILE_SKILL_TARGET/scripts/profile_memory.py"
  cp "$STORY_PROFILE_SKILL_SOURCE/references/actor-memory.md" "$STORY_PROFILE_SKILL_TARGET/references/actor-memory.md"
fi
'''
PROVISION_NEW = '''# Skill installation is separate from Liveware provisioning; do not recreate
# retired specialist entries here. See ops/skills/INSTALL.md in the source tree.
'''


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def safe_file(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"Symlink requires manual review: {part}")
    if path.exists() and not path.is_file():
        raise ValueError(f"Not a regular file: {path}")
    return path


def read_optional(path):
    path = safe_file(path)
    return path.read_bytes() if path.exists() else None


def merge_agents(existing, block):
    if block.count(BEGIN) != 1 or block.count(END) != 1:
        raise ValueError("Invalid source AGENTS block")
    if BEGIN in existing or END in existing:
        if existing.count(BEGIN) != 1 or existing.count(END) != 1:
            raise ValueError("Ambiguous AGENTS markers")
        start, end = existing.index(BEGIN), existing.index(END)
        if end < start:
            raise ValueError("Invalid AGENTS marker order")
        before, after = existing[:start], existing[end + len(END):]
        if any(heading in before + after for heading in LEGACY_SECTIONS):
            raise ValueError("Mixed managed and legacy AGENTS sections; review manually")
        return before + block.strip() + after
    kept = []
    for section in re.split(r"(?m)(?=^## )", existing):
        heading = section.splitlines()[0] if section else ""
        if heading in LEGACY_SECTIONS:
            if digest(section.strip().encode()) != LEGACY_SECTIONS[heading]:
                raise ValueError(f"Modified legacy AGENTS section; preserve and review: {heading}")
        else:
            kept.append(section)
    return "".join(kept).rstrip() + "\n\n" + block.strip() + "\n"


def skill_name(path):
    content = read_optional(path).decode("utf-8-sig")
    parts = content.split("---", 2)
    if len(parts) != 3 or parts[0].strip():
        return None
    match = re.search(r"(?m)^name:\s*['\"]?([\w.-]+)['\"]?\s*$", parts[1])
    return match.group(1) if match else None


def build_plan(source, home, agents_path=None, *, full_release=False):
    source, home = Path(source).absolute(), Path(home).absolute()
    root = home / "skills"
    if source == root or root in source.parents:
        raise ValueError("Stage source outside the active skills directory")
    changes = {}

    def put(path, new):
        path = safe_file(path)
        old = read_optional(path)
        if old != new:
            changes[str(path)] = {"path": str(path), "old": old, "new": new,
                                  "mode": path.stat().st_mode & 0o777 if path.exists() else 0o644}

    for rel in SKILLS:
        directory = source / rel
        if not (directory / "SKILL.md").is_file():
            raise ValueError(f"Missing canonical skill: {rel}")
        if skill_name(directory / "SKILL.md") != rel.split("/")[-1]:
            raise ValueError(f"Canonical skill name mismatch: {rel}")
        for file in sorted(directory.rglob("*")):
            if not file.is_file():
                continue
            if (rel == "system/tavern-updater" and file.relative_to(directory).as_posix() == "scripts/update.py"
                    and not full_release and not (home / "apps/tavern-ops/updater/update.py").is_file()):
                # A skills-only refresh cannot install a launcher whose runtime
                # is absent. First full-release adoption installs both together.
                continue
            # macOS archives can carry AppleDouble ._*.md sidecars; they are
            # metadata, never instructions or supporting references.
            if any(part.startswith(".") or part in ("tests", "agents", "node_modules", "__pycache__")
                   for part in file.relative_to(directory).parts):
                continue
            if file.name == "SKILL.md" and file != directory / "SKILL.md":
                raise ValueError(f"Nested canonical skill: {file}")
            put(root / rel / file.relative_to(directory), read_optional(file))
    for name in RETIRED:
        put(root / "creative" / name / "SKILL.md", None)
    nested = root / "creative/tavern/specialists/tavern-story-profile/SKILL.md"
    put(nested, None)
    for rel in OLD_REFERENCES:
        put(root / rel, None)
    # Keep offline maintenance capabilities once, outside the retired skill
    # trees. A locally customized old helper requires review, not deletion.
    helper = read_optional(source.parent / "scripts/profile_memory.py")
    if helper is None:
        raise ValueError("Missing canonical profile maintenance helper")
    put(root / PROFILE_HELPER, helper)
    for rel in OLD_PROFILE_HELPERS:
        old = read_optional(root / rel)
        if old is not None and old != helper:
            raise ValueError(f"Modified legacy profile helper; preserve and review: {rel}")
        put(root / rel, None)
    for file in sorted((root / "creative").glob(".tavern-pre-*/SKILL.md")):
        if skill_name(file) != "tavern":
            raise ValueError(f"Unknown backup entry; preserve and review: {file}")
        put(file, None)

    # Unknown same-name skills are conflicts, never permission to delete custom work.
    expected = {rel.split("/")[-1]: root / rel / "SKILL.md" for rel in SKILLS}
    for file in sorted(root.rglob("SKILL.md")):
        if str(file) in changes and changes[str(file)]["new"] is None:
            continue
        name = skill_name(file)
        if name in {*expected, *RETIRED} and file != expected.get(name):
            raise ValueError(f"Unmanaged duplicate skill; preserve and review: {file}")

    agents = Path(agents_path) if agents_path else home / "AGENTS.md"
    home_names = {entry.name for entry in home.iterdir()} if home.exists() else set()
    if not agents_path and "agents.md" in home_names and "AGENTS.md" not in home_names:
        raise ValueError("Existing lowercase agents.md: confirm its loading and use --agents-path")
    text = (read_optional(agents) or b"").decode("utf-8")
    block = read_optional(source / "agents-tavern.md").decode("utf-8")
    put(agents, merge_agents(text, block).encode())

    provision = root / "creative/tavern/scripts/provision.sh"
    old = read_optional(provision)
    if old and b"STORY_PROFILE_SKILL_SOURCE=" in old:
        if old.count(PROVISION_OLD.encode()) != 1:
            raise ValueError("Unrecognized provision specialist-copy block; review manually")
        put(provision, old.replace(PROVISION_OLD.encode(), PROVISION_NEW.encode()))
    return sorted(changes.values(), key=lambda change: change["path"])


def plan_summary(plan):
    entries = [{"path": c["path"], "before": digest(c["old"]), "after": digest(c["new"]),
                "mode": c["mode"], "action": "retire" if c["new"] is None else "write"}
               for c in plan]
    return {"digest": digest(json.dumps(entries, sort_keys=True).encode()), "changes": entries}


def atomic_write(path, data, mode):
    path = safe_file(path)
    if data is None:
        if path.exists():
            path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tavern-skill-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_plan(plan, home, expected):
    summary = plan_summary(plan)
    if summary["digest"] != expected:
        raise ValueError("Plan changed; inspect a new dry-run before applying")
    if not plan:
        return {"status": "unchanged", "changed": 0}
    for change in plan:
        if read_optional(change["path"]) != change["old"]:
            raise ValueError("Target changed since planning; inspect a new dry-run")
    backup_root = Path(home) / "tavern-skill-backups"
    safe_file(backup_root / "probe")
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="migration-", dir=backup_root))
    for i, change in enumerate(plan):
        summary["changes"][i]["backup"] = f"{i}.bak" if change["old"] is not None else None
        if change["old"] is not None:
            (backup / f"{i}.bak").write_bytes(change["old"])
    (backup / "manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
    applied = []
    try:
        for change in plan:
            if read_optional(change["path"]) != change["old"]:
                raise ValueError(f"Concurrent change: {change['path']}")
            atomic_write(change["path"], change["new"], change["mode"])
            applied.append(change)
        if any(read_optional(c["path"]) != c["new"] for c in plan):
            raise ValueError("Installed content verification failed")
    except Exception as error:
        failures = []
        for change in reversed(applied):
            try:
                if read_optional(change["path"]) != change["new"]:
                    raise ValueError("Concurrent modification; not overwriting it")
                atomic_write(change["path"], change["old"], change["mode"])
            except Exception:
                failures.append(change["path"])
        raise RuntimeError(f"Apply failed: {error}; backup={backup}; restore failures={failures}") from error
    return {"status": "installed", "changed": len(plan), "backup": str(backup),
            "digest": summary["digest"], "servicesRestarted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "skills")
    parser.add_argument("--hermes-home", type=Path, required=True)
    parser.add_argument("--agents-path", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-plan")
    args = parser.parse_args()
    if args.apply and not args.expected_plan:
        parser.error("--apply requires the inspected --expected-plan digest")
    plan = build_plan(args.source, args.hermes_home, args.agents_path)
    result = apply_plan(plan, args.hermes_home, args.expected_plan) if args.apply else plan_summary(plan)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
