"""Validate the shipped skill with the installed Hermes loader in an isolated home."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hermes-source", type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="cardforge-hermes-loader-") as temporary:
    target = Path(temporary) / "skills/creative/nora-cardforge"
    shutil.copytree(source, target)
    os.environ["HERMES_HOME"] = temporary
    os.environ["TERMINAL_CWD"] = temporary
    sys.path.insert(0, str(args.hermes_source))
    from tools.skill_manager_tool import _validate_frontmatter
    from tools.skills_tool import skills_list, skill_view

    text = (target / "SKILL.md").read_text()
    assert _validate_frontmatter(text, new_skill=True) is None
    listing = json.loads(skills_list())
    assert listing.get("success"), listing.get("error")
    matches = [s for s in listing["skills"] if s["name"] == "nora-cardforge"]
    assert len(matches) == 1, "Skill discovery must be unambiguous"
    loaded = json.loads(skill_view(name="nora-cardforge", preprocess=False))
    assert loaded.get("success"), loaded.get("error")
    references = []
    for file in sorted(target.joinpath("references").glob("*.md")):
        relative = file.relative_to(target).as_posix()
        result = json.loads(skill_view(name="nora-cardforge", file_path=relative))
        assert result.get("success"), result.get("error")
        references.append(relative)
    print(json.dumps({"ok": True, "isolated": True, "uniqueSkill": True,
                      "referencesReadable": references, "modelCalls": 0}))
