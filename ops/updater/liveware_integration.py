"""Bind the two existing Liveware Apps; network failures never undo local code."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlencode

ROLES = {
    "console": ("Tavern", ""),
    "actor": ("Story Profile", "/_liveware/story-profile"),
}
ASSET_RELEASE_PATTERN = re.compile(r"^[a-f0-9]{12,64}$", re.IGNORECASE)
LIVEWARE_DOMAIN_PATTERN = re.compile(r"^[A-Za-z0-9-]+\.apps\.clawling\.io$")
LIVEWARE_APP_ID_PATTERN = re.compile(r"^app-[A-Za-z0-9]+$")


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


def active_apps(home):
    value = json.loads(cli(home, "app", "list", "--json"))
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError("Liveware 返回了未知的 App 列表")
    return [item for item in value if item.get("status") == "active"]


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


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


def normalized_name(value):
    return str(value or "").strip().casefold()


def app_identity(app, title):
    app_id, domain = app.get("appId"), app.get("domain")
    if not isinstance(app_id, str) or not LIVEWARE_APP_ID_PATTERN.fullmatch(app_id):
        raise RuntimeError("Liveware App ID 无效：" + title)
    if not isinstance(domain, str) or not LIVEWARE_DOMAIN_PATTERN.fullmatch(domain):
        raise RuntimeError("Liveware App 域名无效：" + title)
    return {"app_id": app_id, "domain": domain, "name": title, "liveware_name": title}


def created_identity(output, title):
    app_id = re.search(r"(?m)^appId\s+(app-[A-Za-z0-9]+)\s*$", output or "")
    domain = re.search(r"(?m)^domain\s+([A-Za-z0-9-]+\.apps\.clawling\.io)\s*$", output or "")
    if not app_id or not domain:
        return None
    return app_identity({"appId": app_id.group(1), "domain": domain.group(1)}, title)


def resolve_identity(home, document, role, title, available, *, create_missing):
    saved = document.get(role, {}) if isinstance(document.get(role), dict) else {}
    saved_id = saved.get("app_id")
    by_id = [item for item in available if saved_id and item.get("appId") == saved_id]
    if len(by_id) == 1:
        return app_identity(by_id[0], title), available

    expected_name = normalized_name(title)
    by_name = [item for item in available if normalized_name(item.get("name")) == expected_name]
    if len(by_name) == 1:
        return app_identity(by_name[0], title), available
    if len(by_name) > 1:
        raise RuntimeError("存在多个同名 Liveware App，无法安全选择：" + title)
    if not create_missing:
        return None, available

    output = cli(home, "app", "create", title, "--agent-type", "hermes")
    identity = created_identity(output, title)
    if identity:
        available = [*available, {
            "appId": identity["app_id"],
            "domain": identity["domain"],
            "name": title,
            "status": "active",
        }]
        return identity, available

    for _ in range(15):
        available = active_apps(home)
        by_name = [item for item in available if normalized_name(item.get("name")) == normalized_name(title)]
        if len(by_name) == 1:
            return app_identity(by_name[0], title), available
        if len(by_name) > 1:
            raise RuntimeError("创建后出现多个同名 Liveware App：" + title)
        time.sleep(1)
    raise RuntimeError("Liveware App 创建后未能确认：" + title)


def sync_launcher(home, desired, rows):
    title = desired["name"]
    role_rows = [
        item for item in rows
        if item.get("app_id") == desired["app_id"]
        or normalized_name(item.get("name")) == normalized_name(title)
    ]
    current = {key: role_rows[0].get(key) for key in desired} if len(role_rows) == 1 else None
    if current == desired:
        return rows

    affected_ids = {item.get("app_id") for item in role_rows if item.get("app_id")}
    previous = [item for item in rows if item.get("app_id") in affected_ids]
    try:
        for app_id in sorted(affected_ids):
            launcher(home, "unregister_app", app_id=app_id)
        launcher(home, "register_app", **desired)
    except Exception:
        for item in previous:
            restore = {key: item.get(key) for key in desired}
            if all(restore.values()):
                try:
                    launcher(home, "register_app", **restore)
                except Exception:
                    pass
        raise

    rows = listed_apps(home)
    role_rows = [
        item for item in rows
        if item.get("app_id") == desired["app_id"]
        or normalized_name(item.get("name")) == normalized_name(title)
    ]
    verified = {key: role_rows[0].get(key) for key in desired} if len(role_rows) == 1 else None
    if verified != desired:
        raise RuntimeError(title + " 启动器入口未收敛为唯一记录")
    return rows


def bind_with_retry(home, app_id, target, attempts=5):
    error = None
    for attempt in range(attempts):
        try:
            cli(home, "tunnel", "bind", app_id, target)
            return
        except Exception as current:
            error = current
            if attempt + 1 < attempts:
                time.sleep(2)
    raise RuntimeError(f"Liveware 隧道绑定连续失败 {attempts} 次：{error}")


def reconcile(home, port=8799, *, create_missing=False):
    home = Path(home)
    path = home / "tavern-state/apps.json"
    if not path.is_file() and not create_missing:
        return {"status": "not-configured", "warnings": ["未找到既有 Liveware App；需要首次初始化"]}
    document = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if not isinstance(document, dict):
        return {"status": "local-installed-liveware-pending", "warnings": ["Liveware 身份文件格式无效"]}
    release = runtime_asset_release(port)
    warnings = []
    try:
        available = active_apps(home)
    except Exception as error:
        return {
            "status": "local-installed-liveware-pending",
            "warnings": ["无法读取 Liveware App：" + str(error)],
            "assetRelease": release,
        }

    resolved = {}
    for role, (title, prefix) in ROLES.items():
        try:
            identity, available = resolve_identity(
                home, document, role, title, available, create_missing=create_missing,
            )
        except Exception as error:
            warnings.append(f"{title} 身份恢复失败：{error}")
            continue
        if identity is None:
            warnings.append(title + " 缺少可恢复的 Liveware App")
            continue
        if document.get(role) != identity:
            document[role] = identity
            atomic_json(path, document)
        resolved[role] = identity

    identities = [item["app_id"] for item in resolved.values()]
    if len(identities) != len(set(identities)):
        warnings.append("Tavern 与 Story Profile 错误地共用了同一个 App ID")

    launcher_rows = None
    for role, (title, prefix) in ROLES.items():
        app = resolved.get(role)
        if not app:
            continue
        app_id, domain = app["app_id"], app["domain"]
        try:
            bind_with_retry(home, app_id, f"http://127.0.0.1:{port}{prefix}")
            desired = {"app_id": app_id, "name": title, "url": release_launcher_url(domain, release)}
            if launcher_rows is None:
                launcher_rows = listed_apps(home)
            launcher_rows = sync_launcher(home, desired, launcher_rows)
        except Exception as error:
            warnings.append(f"{title} 刷新失败：{error}")
    return {
        "status": "updated" if not warnings and len(resolved) == len(ROLES) else "local-installed-liveware-pending",
        "warnings": warnings,
        "assetRelease": release,
    }


def refresh(home, port=8799):
    return reconcile(home, port, create_missing=False)


def repair(home, port=8799):
    return reconcile(home, port, create_missing=True)


def initialize(home, port=8799):
    return repair(home, port)


def identities_complete(home):
    path = Path(home) / "tavern-state/apps.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(document, dict):
        return False
    for role in ROLES:
        app = document.get(role)
        if not isinstance(app, dict):
            return False
        if not isinstance(app.get("app_id"), str) or not LIVEWARE_APP_ID_PATTERN.fullmatch(app["app_id"]):
            return False
        if not isinstance(app.get("domain"), str) or not LIVEWARE_DOMAIN_PATTERN.fullmatch(app["domain"]):
            return False
    return True


def start_runtime(home):
    app = Path(home) / "apps/tavern-runtime"
    return subprocess.run(
        [sys.executable, "-B", str(app / "native_lifecycle.py"), "start"],
        env={**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(home)},
        check=True,
    ).returncode


def ensure(home, port=8799):
    home = Path(home)
    start_runtime(home)
    if identities_complete(home):
        return refresh(home, port)
    return repair(home, port)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("operation", choices=("ensure", "initialize", "recover-existing", "refresh"))
    args = parser.parse_args()
    if args.operation == "ensure":
        result = ensure(args.home)
    elif args.operation == "initialize":
        result = initialize(args.home)
    else:
        if args.operation == "recover-existing":
            start_runtime(args.home)
        result = refresh(args.home)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
