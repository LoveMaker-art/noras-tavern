#!/usr/bin/env bash
set -euo pipefail

archive="$1"
desktop="$2"
test -f "$archive"
test -f "$desktop/package.json"
py="$RUNNER_TEMP/hermes-build-source/hermes-agent/venv/bin/python"
if [[ "$RUNNER_OS" == "Windows" ]]; then
  # The isolated installation gates have finished. Restore only the test
  # interpreter's original path so its venv configuration stays valid.
  test -d "$RUNNER_TEMP/hermes-build-source"
  if [[ -e "$RUNNER_TEMP/hermes" || -L "$RUNNER_TEMP/hermes" ]]; then
    echo 'Original runtime directory must be absent before archive acceptance' >&2
    exit 1
  fi
  mv "$RUNNER_TEMP/hermes-build-source" "$RUNNER_TEMP/hermes"
  restore_source() {
    status=$?
    trap - EXIT
    if ! mv "$RUNNER_TEMP/hermes" "$RUNNER_TEMP/hermes-build-source"; then
      echo 'Failed to restore isolated build source directory' >&2
      exit 1
    fi
    exit "$status"
  }
  trap restore_source EXIT
  py="$RUNNER_TEMP/hermes/hermes-agent/venv/Scripts/python.exe"
  "$py" -B -c 'import json,os,sys,psutil; from pathlib import Path; home=Path(os.environ["RUNNER_TEMP"])/"hermes"; venv=(home/"hermes-agent/venv").resolve(); base=(home/"python").resolve(); assert Path(sys.prefix).resolve()==venv; assert Path(sys.base_prefix).resolve()==base; assert Path(psutil.__file__).resolve().is_relative_to(venv); print(json.dumps({"venv":str(venv),"base":str(base),"psutil":psutil.__version__}))'
fi
test -f "$py"
export NORA_TEST_LAUNCHER_ARCHIVE="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$archive")"
export NORA_TEST_LAUNCHER_DESKTOP="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$desktop")"
node tooling/run.mjs "$py" -B -m unittest tests.deployment.test_launcher_replacement -v
