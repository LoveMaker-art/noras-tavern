#!/bin/sh
# provision — 首跑：创建/复用 Nora Tavern 与 Story Profile 两个 Liveware 入口。
#
# 职责边界：这里管**一次性 install 关注点**——建/复用 app、写 state/apps.json、register
# 进 member-backend（launcher 瓦片）。起进程 / 重启恢复由 bringup-native.sh 负责。
#
# 幂等 + 不烧配额：先 `liveware app list` 查同名 active app，**有就复用**（apps.json 丢了
# 也能从 list 恢复），**缺才 `app create`**。per-owner 配额 ~3、且无 app delete，所以
# 复用优先是硬要求——重跑本脚本不会重复建 app。
#
# Liveware 底层 app 使用稳定名称 Tavern，不随主理人昵称变化。
#
# 前置：容器已激活（hermes clawchat activate）+ 装了 clawchat 插件（带 liveware 二进制）。
# 跑：sh "$HERMES_HOME/skills/creative/tavern/scripts/provision.sh"
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "${HERMES_HOME:-}" ]; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ] && [ -d /opt/data/skills ]; then
    HERMES_HOME=/opt/data
  else
    HERMES_HOME="$HOME/.hermes"
  fi
fi
DATA_ROOT="${TAVERN_DATA_ROOT:-$HERMES_HOME}"
TAVERN_STATE="${TAVERN_STATE_DIR:-$DATA_ROOT/tavern-state}"
LW_DIR="$HERMES_HOME/clawchat/liveware"
LW="${LIVEWARE_BIN:-}"
if [ -z "$LW" ]; then
  if command -v liveware >/dev/null 2>&1; then
    LW="$(command -v liveware)"
  else
    LW="$LW_DIR/liveware"
  fi
fi
if [ ! -x "$LW" ]; then
  echo "✗ liveware command not found: $LW" >&2
  exit 1
fi
PLUGIN="${CLAWCHAT_PLUGIN_DIR:-$HERMES_HOME/plugins/clawchat}"
PY="${TAVERN_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x /opt/hermes/.venv/bin/python ]; then PY=/opt/hermes/.venv/bin/python; else PY="$(command -v python3)"; fi
fi
APPS="$TAVERN_STATE/apps.json"
mkdir -p "$TAVERN_STATE"

# Skill installation is separate from Liveware provisioning; do not recreate
# retired specialist entries here. See ops/skills/INSTALL.md in the source tree.
CONSOLE_APP_NAME="${TAVERN_CONSOLE_APP_NAME:-Tavern}"
CONSOLE_NAME="$CONSOLE_APP_NAME"
TAVERN_APP="${TAVERN_APP_DIR:-$DATA_ROOT/apps/tavern-runtime}"
ACTOR_APP_NAME="${TAVERN_ACTOR_APP_NAME:-Story Profile}"
ACTOR_NAME="$ACTOR_APP_NAME"

# 1. liveware 登录（token 从 plugin profile config 解析；env CLAWCHAT_TOKEN 是空壳别直接传）
echo "== login =="
cd "$PLUGIN" && HERMES_HOME="$HERMES_HOME" "$PY" -c \
  "import asyncio,sys; sys.path.insert(0,'.'); from clawchat_gateway import tools; print('login:', asyncio.run(tools.liveware_login()))"

# 2. 解析或创建两个入口 → 写 apps.json。两个入口共用同一个 Node 进程。
echo "== resolve/create apps =="
HERMES_HOME="$HERMES_HOME" "$PY" - "$LW" "$APPS" "$CONSOLE_APP_NAME" "$CONSOLE_NAME" "$ACTOR_APP_NAME" "$ACTOR_NAME" <<'PY'
import json, subprocess, sys, time
lw, apps_path, console_app_name, console_name, actor_app_name, actor_name = sys.argv[1:7]

def app_list():
    r = subprocess.run([lw, "app", "list", "--json"], capture_output=True, text=True)
    try:
        payload = json.loads(r.stdout)
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict) and isinstance(payload.get("apps"), list):
            return payload["apps"]
        return []
    except Exception:
        return []

def created_app_id(output):
    try:
        payload = json.loads(output)
        if isinstance(payload, dict):
            return (payload.get("appId") or payload.get("app_id") or "").strip()
    except Exception:
        pass
    for line in output.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[0] in {"appId", "app_id"}:
            return parts[-1].strip()
    return ""

def find(name, apps):
    for a in apps:
        if str(a.get("name", "")).casefold() == name.casefold() and a.get("status") == "active":
            return a
    return None

def find_id(app_id, apps):
    for a in apps:
        if a.get("appId") == app_id and a.get("status") == "active":
            return a
    return None

def existing_id(key):
    try:
        with open(apps_path, encoding="utf-8") as f:
            return ((json.load(f).get(key) or {}).get("app_id") or "").strip()
    except Exception:
        return ""

def ensure(key, name):
    apps = app_list()
    old_id = existing_id(key)
    if old_id:
        a = find_id(old_id, apps)
        if a:
            print("  reuse-id:", name, a["appId"])
            return a
    a = find(name, apps)
    if a:
        print("  reuse:", name, a["appId"])
        return a
    print("  create:", name, "(app list 无同名 active，新建——会消耗 owner 配额)")
    result = subprocess.run(
        [lw, "app", "create", name, "--agent-type", "hermes"],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr:
        print(result.stderr.rstrip(), file=sys.stderr)
    new_id = created_app_id(result.stdout)
    a = None
    for attempt in range(30):
        apps = app_list()
        a = find_id(new_id, apps) if new_id else find(name, apps)
        if a:
            break
        if attempt < 29:
            time.sleep(2)
    if not a:
        identity = new_id or name
        raise SystemExit("  ✗ 创建成功，但 60 秒内未在 app list 确认 active: " + identity)
    print("  created:", name, a["appId"])
    return a

con = ensure("console", console_app_name)
actor = ensure("actor", actor_app_name)
data = {
    "console": {"name": console_name, "liveware_name": console_app_name,
                "app_id": con["appId"], "domain": con["domain"]},
    "actor": {"name": actor_name, "liveware_name": actor_app_name,
              "app_id": actor["appId"], "domain": actor["domain"]},
}
json.dump(data, open(apps_path, "w"), ensure_ascii=False, indent=2)
print("  wrote", apps_path)
PY

# 3. register 进 member-backend（名字/URL 不一致时刷新注册；不删除 liveware app 本体）
echo "== register apps =="
cd "$PLUGIN" && HERMES_HOME="$HERMES_HOME" "$PY" - "$APPS" <<'PY'
import asyncio, json, sys
sys.path.insert(0, '.')
from clawchat_gateway import tools
apps_path = sys.argv[1]
d = json.load(open(apps_path, encoding="utf-8"))

def app_rows(payload):
    if isinstance(payload, dict):
        rows = payload.get("apps")
        return rows if isinstance(rows, list) else []
    return []

async def go():
    listed = app_rows(await tools.list_apps())
    by_app_id = {r.get("app_id") or r.get("appId"): r for r in listed if isinstance(r, dict)}
    for key in ("console", "actor"):
        e = d[key]
        url = "https://%s/" % e["domain"]
        row = by_app_id.get(e["app_id"])
        same = row and row.get("name") == e["name"] and row.get("url") == url
        if same:
            print("  registered-current:", e["name"])
            continue
        if row:
            res = await tools.unregister_app(e["app_id"])
            print("  unregistered-stale:", row.get("name"), res)
        res = await tools.register_app(name=e["name"], app_id=e["app_id"], url=url)
        print("  registered:", e["name"], res)
asyncio.run(go())
PY

# 4. 初始化唯一的结构化档案。若 state/actor_self.md 来自旧版本，内核会自动迁移。
if [ ! -f "$TAVERN_APP/story_profile_runtime/core/story_profile.py" ] || [ ! -f "$TAVERN_APP/actor_self.md" ]; then
  echo "Story Profile runtime is missing from $TAVERN_APP" >&2
  exit 1
fi
HERMES_HOME="$HERMES_HOME" TAVERN_STATE_DIR="$TAVERN_STATE" PYTHONPATH="$TAVERN_APP/story_profile_runtime/core" \
  "$PY" - "$TAVERN_APP/actor_self.md" <<'PY'
import os, pathlib, sys
import story_profile
story_profile.ensure_profile(pathlib.Path(os.environ["TAVERN_STATE_DIR"]), pathlib.Path(sys.argv[1]))
print("  story-profile: initialized")
PY

echo "== provision done. apps.json: =="
cat "$APPS"
