"""Build gate for the specific maintainer-reviewed ClawChat source tree."""

import hashlib
import json
from pathlib import Path
import sys


def audit(source, lock):
    from tools.plugin_guard import PLUGIN_SCANNER_VERSION, scan_plugin
    import importlib.metadata
    import tomllib
    import yaml
    from packaging.requirements import Requirement

    manifest = yaml.safe_load((source / 'plugin.yaml').read_text())
    if manifest.get('name') != 'clawchat' or manifest.get('version') != lock['version']:
        raise RuntimeError('ClawChat manifest does not match the reviewed version')
    project = tomllib.loads((source / 'pyproject.toml').read_text())
    for value in project['project']['dependencies']:
        requirement = Requirement(value)
        if requirement.marker and not requirement.marker.evaluate():
            continue
        if not requirement.specifier.contains(importlib.metadata.version(requirement.name)):
            raise RuntimeError('ClawChat runtime dependency mismatch: ' + requirement.name)

    result = scan_plugin(source, source=lock["repository"])
    rows = sorted([f.pattern_id, f.severity, f.file, f.line, f.match] for f in result.findings)
    fingerprint = hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()
    actual = {"scanner": PLUGIN_SCANNER_VERSION, "verdict": result.verdict,
              "findings": len(rows), "fingerprint": fingerprint}
    if result.verdict == "dangerous" or actual != lock["review"]:
        raise RuntimeError("ClawChat scan changed; maintainer review required: " + json.dumps(actual))
    return actual


if __name__ == "__main__":
    print(json.dumps(audit(Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text()))))
