#!/bin/sh
# Production topology: one Nora Tavern Node process behind Tavern and Story Profile apps.
set -eu

if [ -z "${HERMES_HOME:-}" ]; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ] && [ -d /opt/data/skills ]; then
    HERMES_HOME=/opt/data
  else
    HERMES_HOME="$HOME/.hermes"
  fi
fi
DATA_ROOT="${TAVERN_DATA_ROOT:-$HERMES_HOME}"
TAVERN_SKILL="${TAVERN_SKILL_DIR:-$HERMES_HOME/skills/creative/tavern}"
TAVERN_APP="${TAVERN_APP_DIR:-$DATA_ROOT/apps/tavern-runtime}"
TAVERN_STATE="${TAVERN_STATE_DIR:-$DATA_ROOT/tavern-state}"
NATIVE_PORT="${TAVERN_PORT:-8799}"
APPS="$TAVERN_STATE/apps.json"
PLUGIN="${CLAWCHAT_PLUGIN_DIR:-$HERMES_HOME/plugins/clawchat}"
LW_DIR="$HERMES_HOME/clawchat/liveware"
PY="${TAVERN_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /opt/hermes/.venv/bin/python ]; then
    PY=/opt/hermes/.venv/bin/python
  else
    PY=$(command -v python3)
  fi
fi

if [ ! -f "$APPS" ]; then
  echo "Missing $APPS; run provision.sh first" >&2
  exit 1
fi
APP_ID=$("$PY" - "$APPS" <<'PY'
import json, sys
document = json.load(open(sys.argv[1], encoding="utf-8"))
print(str((document.get("console") or {}).get("app_id") or ""))
PY
)
ACTOR_APP_ID=$("$PY" - "$APPS" <<'PY'
import json, sys
document = json.load(open(sys.argv[1], encoding="utf-8"))
print(str((document.get("actor") or {}).get("app_id") or ""))
PY
)
if [ -z "$APP_ID" ] || [ -z "$ACTOR_APP_ID" ]; then
  echo "apps.json must contain console and actor app_id values" >&2
  exit 1
fi

LW_BIN="${LIVEWARE_BIN:-$(command -v liveware 2>/dev/null || echo "$LW_DIR/liveware")}"
if [ ! -x "$LW_BIN" ]; then
  echo "liveware is unavailable" >&2
  exit 1
fi

"$TAVERN_SKILL/scripts/runtime.sh" start --run-id production \
  --port "$NATIVE_PORT"

"$PY" "$TAVERN_APP/native_model_config.py" \
  --config "${HERMES_CONFIG_PATH:-$HERMES_HOME/config.yaml}" \
  --settings "$TAVERN_STATE/native/default-user/settings.json" \
  --marker "$TAVERN_STATE/native-runtime/model-config.json" \
  --base-url "http://127.0.0.1:$NATIVE_PORT"

cd "$PLUGIN"
HERMES_HOME="$HERMES_HOME" "$PY" -c \
  "import asyncio,sys; sys.path.insert(0,'.'); from clawchat_gateway import tools; print('login:', asyncio.run(tools.liveware_login()))"
"$LW_BIN" tunnel bind "$APP_ID" "http://127.0.0.1:$NATIVE_PORT" >/dev/null
# Each app must return its own metadata at /. Both still share one Node backend.
"$LW_BIN" tunnel bind "$ACTOR_APP_ID" "http://127.0.0.1:$NATIVE_PORT/_liveware/story-profile" >/dev/null

echo "Nora Tavern: http://127.0.0.1:$NATIVE_PORT"
