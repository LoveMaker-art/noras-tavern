"""Use an installed Hermes loader against an isolated copy; never install live."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--live-home", type=Path, required=True)
    args = parser.parse_args()
    ops = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("install_skills", ops / "scripts/install-hermes-skills.py")
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)
    source, live = ops / "skills", args.live_home.resolve()
    live_plan = install.build_plan(source, live)  # read only, including actual legacy hashes
    before = {c["path"]: install.read_optional(c["path"]) for c in live_plan}
    with tempfile.TemporaryDirectory(prefix="hermes-skill-isolation-") as temporary:
        home = Path(temporary).resolve()
        # Only instruction entrypoints and the provision file are copied. No
        # config.yaml, credentials, chat history, DB, identity or runtime data.
        files = list((live / "skills").rglob("SKILL.md")) + [live / "AGENTS.md"]
        provision = live / "skills/creative/tavern/scripts/provision.sh"
        if provision.exists():
            files.append(provision)
        for file in files:
            if not file.exists():
                continue
            target = home / file.relative_to(live)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(install.safe_file(file), target)
        plan = install.build_plan(source, home)
        install.apply_plan(plan, home, install.plan_summary(plan)["digest"])
        assert install.build_plan(source, home) == [], "Migration must be idempotent"

        os.environ["HERMES_HOME"] = str(home)
        os.environ["TERMINAL_CWD"] = str(home)
        sys.path.insert(0, str(args.hermes_source))
        from tools.skill_manager_tool import _validate_frontmatter
        from tools.skills_tool import skills_list, skill_view
        from agent.prompt_builder import build_context_files_prompt

        listing = json.loads(skills_list())
        assert listing.get("success"), "Hermes discovery failed"
        names = [skill["name"] for skill in listing["skills"]]
        checked = {}
        for rel in install.SKILLS:
            name = rel.split("/")[-1]
            directory = home / "skills" / rel
            main_text = (directory / "SKILL.md").read_text()
            assert _validate_frontmatter(main_text) is None, name
            assert names.count(name) == 1, f"Index ambiguity: {name}"
            loaded = json.loads(skill_view(name=name))
            assert loaded.get("success"), f"Cannot load {name}: {loaded.get('error')}"
            refs = []
            for file in directory.joinpath("references").glob("*.md"):
                relative = str(file.relative_to(directory))
                result = json.loads(skill_view(name=name, file_path=relative))
                assert result.get("success"), f"Cannot load {name}/{relative}"
                refs.append(relative)
            expected = {str(p.relative_to(source / rel)) for p in (source / rel / 'references').glob('*.md')}
            assert set(refs) == expected, 'Installed references differ from release: ' + name
            checked[name] = {"frontmatter": True, "unique": True, "references": sorted(refs)}
        assert not set(install.RETIRED).intersection(names), "Retired skills remain in index"
        context = build_context_files_prompt(cwd=str(home), skip_soul=True)
        assert install.BEGIN in context, "AGENTS block not loaded"
        outside = context.split(install.BEGIN, 1)[0] + context.split(install.END, 1)[1]
        assert not any(heading in outside.splitlines() for heading in install.LEGACY_SECTIONS), "Old AGENTS routing remains"
        # Block has no unresolved reference to an old specialist.
        assert not any(re.search(r"`" + re.escape(name) + r"`", context) for name in install.RETIRED)
        assert all(install.read_optional(path) == data for path, data in before.items()), "Live files changed"
        print(json.dumps({
            "isolation": True, "hermesSource": str(args.hermes_source),
            "skills": checked, "retiredSkillsAbsent": True, "agentsLoaded": True,
            "liveFilesUnchanged": True, "livePlanDigest": install.plan_summary(live_plan)["digest"],
            "livePlannedChanges": len(live_plan), "modelCalls": 0, "servicesRestarted": False,
        }, indent=2))


if __name__ == "__main__":
    main()
