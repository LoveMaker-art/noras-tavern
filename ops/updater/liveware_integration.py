"""Bind the two existing Liveware Apps; network failures never undo local code."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROLES = {
    "console": ("Tavern", ""),
    "actor": ("Story Profile", "/_liveware/story-profile"),
}


def binary(home):
    candidates = [
        os.environ.get("LIVEWARE_BIN"),
        shutil.which("liveware"),
        "/opt/clawnest/bin/liveware",
        str(Path(home) / "clawchat/liveware/liveware"),
    ]
    return next((value for value in candidates if value and Path(value).is_file()), None)


def environment(home):
    env = {**os.environ, "HOME": str(home), "HERMES_HOME": str(home)}
    saved = Path(home) / ".clawling/liveware.json"
    if saved.is_file():
        value = json.loads(saved.read_text(encoding="utf-8"))
        for key, field in (
            ("LIVEWARE_TOKEN", "token"),
            ("LIVEWARE_API_URL", "apiUrl"),
            ("LIVEWARE_INSTANCE_ID", "instanceId"),
        ):
            if value.get(field):
                env[key] = value[field]
    return env


def cli(home, *args):
    executable = binary(home)
    if not executable:
        raise RuntimeError("未找到 Liveware CLI")
    return subprocess.run(
        [executable, *args],
        env=environment(home),
        text=True,
        capture_output=True,
        timeout=45,
        check=True,
    ).stdout


def launcher(home, operation, **parameters):
    plugin = Path(os.environ.get("CLAWCHAT_PLUGIN_DIR") or Path(home) / "plugins/clawchat")
    code = (
        "import asyncio,json,sys;sys.path.insert(0,sys.argv[1]);"
        "from clawchat_gateway import tools;"
        "print(json.dumps(asyncio.run(getattr(tools,sys.argv[2])(**json.load(sys.stdin)))))"
    )
    result = subprocess.run(
        [sys.executable, "-B", "-c", code, str(plugin), operation],
        input=json.dumps(parameters),
        text=True,
        capture_output=True,
        env=environment(home),
        timeout=45,
        check=True,
    )
    return json.loads(result.stdout)


def refresh(home, port=8799):
    home = Path(home)
    path = home / "tavern-state/apps.json"
    if not path.is_file():
        return {"status": "not-configured", "warnings": ["未找到既有 Liveware App；需要首次初始化"]}
    document = json.loads(path.read_text(encoding="utf-8"))
    warnings = []
    try:
        listed = launcher(home, "list_apps")
        listed = listed.get("apps", listed.get("data", [])) if isinstance(listed, dict) else listed
        if not isinstance(listed, list):
            raise RuntimeError("ClawChat 返回了未知的 App 列表")
    except Exception as error:
        listed = None
        warnings.append("无法刷新 ClawChat 启动器：" + str(error))
    for role, (title, prefix) in ROLES.items():
        app = document.get(role, {})
        app_id, domain = app.get("app_id"), app.get("domain")
        if not app_id or not domain:
            warnings.append(role + " 缺少 App ID")
            continue
        try:
            cli(home, "tunnel", "bind", app_id, f"http://127.0.0.1:{port}{prefix}")
            desired = {"app_id": app_id, "name": title, "url": f"https://{domain}/"}
            if listed is not None:
                matches = [item for item in listed if item.get("app_id") == app_id]
                current = {key: matches[0].get(key) for key in desired} if len(matches) == 1 else None
                if len(matches) > 1:
                    warnings.append(title + " 存在重复启动器记录，未自动继续添加")
                elif current != desired:
                    if current:
                        launcher(home, "unregister_app", app_id=app_id)
                    launcher(home, "register_app", **desired)
        except Exception as error:
            warnings.append(f"{title} 刷新失败：{error}")
    return {"status": "updated" if not warnings else "local-installed-liveware-pending", "warnings": warnings}


def initialize(home, port=8799):
    home = Path(home)
    path = home / "tavern-state/apps.json"
    document = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    available = json.loads(cli(home, "app", "list", "--json"))
    for role, (title, _) in ROLES.items():
        saved = document.get(role, {}).get("app_id")
        matches = [app for app in available if app.get("status") == "active"
                   and (app.get("appId") == saved if saved else app.get("name") == title)]
        if not matches:
            cli(home, "app", "create", title, "--agent-type", "hermes")
            available = json.loads(cli(home, "app", "list", "--json"))
            matches = [app for app in available if app.get("status") == "active" and app.get("name") == title]
        if len(matches) != 1:
            raise RuntimeError("无法唯一确定 Liveware App：" + title)
        app = matches[0]
        document[role] = {"app_id": app["appId"], "domain": app["domain"], "name": title, "liveware_name": title}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return refresh(home, port)


def start_runtime(home):
    app = Path(home) / "apps/tavern-runtime"
    return subprocess.run(
        [sys.executable, "-B", str(app / "native_lifecycle.py"), "start"],
        env={**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(home)},
        check=True,
    ).returncode


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("operation", choices=("initialize", "recover-existing", "refresh"))
    args = parser.parse_args()
    if args.operation == "initialize":
        result = initialize(args.home)
    else:
        if args.operation == "recover-existing":
            start_runtime(args.home)
        result = refresh(args.home)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
