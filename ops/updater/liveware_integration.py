"""Bind the two existing Liveware Apps; network failures never undo local code."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
from urllib.parse import urlencode

ROLES = {
    "console": ("Tavern", ""),
    "actor": ("Story Profile", "/_liveware/story-profile"),
}
ASSET_RELEASE_PATTERN = re.compile(r"^[a-f0-9]{12,64}$", re.IGNORECASE)
LIVEWARE_DOMAIN_PATTERN = re.compile(r"^[A-Za-z0-9-]+\.apps\.clawling\.io$")


def runtime_asset_release(port=8799):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/version",
        headers={"Accept": "application/json", "Cache-Control": "no-store"},
    )
    with opener.open(request, timeout=10) as response:
        payload = response.read(65537)
        if response.status != 200 or len(payload) > 65536:
            raise RuntimeError("Tavern 资源版本接口不可用")
    value = json.loads(payload)
    release = value.get("assetRelease") if isinstance(value, dict) else None
    if not isinstance(release, str) or not ASSET_RELEASE_PATTERN.fullmatch(release):
        raise RuntimeError("Tavern 未返回有效的资源版本")
    return release.lower()


def release_launcher_url(domain, release):
    if not isinstance(domain, str) or not LIVEWARE_DOMAIN_PATTERN.fullmatch(domain):
        raise ValueError("Liveware App 域名无效")
    if not isinstance(release, str) or not ASSET_RELEASE_PATTERN.fullmatch(release):
        raise ValueError("Tavern 资源版本无效")
    return f"https://{domain}/?{urlencode({'release': release.lower()})}"


def listed_apps(home):
    value = launcher(home, "list_apps")
    value = value.get("apps", value.get("data", [])) if isinstance(value, dict) else value
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError("ClawChat 返回了未知的 App 列表")
    return value


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
    value = json.loads(result.stdout)
    if isinstance(value, dict) and (value.get("error") or value.get("ok") is False or value.get("success") is False):
        raise RuntimeError("ClawChat 启动器操作失败：" + operation)
    return value


def refresh(home, port=8799):
    home = Path(home)
    path = home / "tavern-state/apps.json"
    if not path.is_file():
        return {"status": "not-configured", "warnings": ["未找到既有 Liveware App；需要首次初始化"]}
    document = json.loads(path.read_text(encoding="utf-8"))
    release = runtime_asset_release(port)
    warnings = []
    try:
        listed = listed_apps(home)
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
            desired = {"app_id": app_id, "name": title, "url": release_launcher_url(domain, release)}
            if listed is not None:
                matches = [item for item in listed if item.get("app_id") == app_id]
                current = {key: matches[0].get(key) for key in desired} if len(matches) == 1 else None
                if current != desired:
                    if matches:
                        launcher(home, "unregister_app", app_id=app_id)
                    try:
                        launcher(home, "register_app", **desired)
                    except Exception:
                        for previous in matches:
                            restore = {key: previous.get(key) for key in desired}
                            if all(restore.values()):
                                try:
                                    launcher(home, "register_app", **restore)
                                except Exception:
                                    pass
                        raise
                    listed = listed_apps(home)
                    matches = [item for item in listed if item.get("app_id") == app_id]
                    verified = {key: matches[0].get(key) for key in desired} if len(matches) == 1 else None
                    if verified != desired:
                        raise RuntimeError(title + " 启动器资源版本未更新")
        except Exception as error:
            warnings.append(f"{title} 刷新失败：{error}")
    return {
        "status": "updated" if not warnings else "local-installed-liveware-pending",
        "warnings": warnings,
        "assetRelease": release,
    }


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
