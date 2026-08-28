#!/usr/bin/env bash
set -euo pipefail

bootstrap_url="${TAVERN_UPDATE_BOOTSTRAP_URL:-https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh}"
hermes_root="${HERMES_HOME:-/opt/data}"
sender="$hermes_root/scripts/nora-tavern-card-send.py"
log_file="$hermes_root/logs/nora-tavern-update-check.log"
notice_state="$hermes_root/tavern-updates/notification-state.json"
python_bin="${TAVERN_UPDATE_PYTHON:-/opt/hermes/.venv/bin/python3}"
if [[ ! -x "$python_bin" ]]; then
  python_bin="$(command -v python3 || command -v python)"
fi

mkdir -p "$(dirname "$log_file")" "$(dirname "$notice_state")"

log_error() {
  local message="$1"
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >>"$log_file"
}

if ! result="$(curl -fsSL "$bootstrap_url" | sh 2>&1)"; then
  log_error "update check failed: ${result:0:4000}"
  exit 0
fi

if ! summary="$("$python_bin" -c '
import json, sys
data = json.loads(sys.stdin.read())
summary = {
    "ok": data.get("ok", False),
    "installed": ((data.get("check") or {}).get("installed")
                  or (data.get("report") or {}).get("installed")
                  or "unknown"),
    "latest": ((data.get("check") or {}).get("latest")
               or (data.get("report") or {}).get("target")
               or "unknown"),
    "plan_id": (data.get("report") or {}).get("plan_id") or "",
    "backup": data.get("backup") or "",
}
print(json.dumps(summary, ensure_ascii=False))
' <<<"$result")"; then
  log_error "update check returned invalid JSON"
  exit 0
fi

IFS=$'\t' read -r ok installed latest plan_id bootstrap_backup < <("$python_bin" -c '
import json, sys
data = json.loads(sys.stdin.read())
print(
    str(data.get("ok")).lower(),
    data.get("installed") or "unknown",
    data.get("latest") or "unknown",
    data.get("plan_id") or "",
    data.get("backup") or "",
    sep="\t",
)
' <<<"$summary")

case "$bootstrap_backup" in
  "$hermes_root"/tavern-updates/bootstrap-backups/*)
    if [[ -d "$bootstrap_backup" ]]; then
      find "$bootstrap_backup" -mindepth 1 -delete
      rmdir "$bootstrap_backup"
    fi
    ;;
esac

if [[ "$plan_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
  plan_dir="$hermes_root/tavern-updates/plans/$plan_id"
  if [[ -d "$plan_dir" ]]; then
    find "$plan_dir" -mindepth 1 -delete
    rmdir "$plan_dir"
  fi
fi

# User-visible state is deliberately binary: update available, or silent.
if [[ "$ok" != "true" || "$installed" == "unknown" || "$latest" == "unknown" ]]; then
  log_error "update check incomplete: ok=$ok installed=$installed latest=$latest"
  exit 0
fi

if [[ "$installed" == "$latest" ]]; then
  exit 0
fi

last_notified_latest=""
if [[ -f "$notice_state" ]]; then
  last_notified_latest="$("$python_bin" -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
print(data.get("last_notified_latest") or "")
' "$notice_state" 2>/dev/null || true)"
fi

# Do not repeat the same update notice every day. A new latest version resets the reminder.
if [[ "$last_notified_latest" == "$latest" ]]; then
  exit 0
fi

if ! delivery_error="$(
  "$python_bin" "$sender" \
    --installed "$installed" \
    --latest "$latest" 2>&1
)"; then
  log_error "update card delivery failed: ${delivery_error:0:4000}"
  exit 0
fi

"$python_bin" - "$notice_state" "$latest" "$installed" <<'PY'
import datetime as _dt
import json
import os
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "last_notified_latest": sys.argv[2],
    "last_notified_installed": sys.argv[3],
    "last_notified_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp_name, path)
finally:
    try:
        os.unlink(tmp_name)
    except FileNotFoundError:
        pass
PY

# Keep stdout empty: the script sends its own Markdown bubble and cron delivery stays local.
exit 0
